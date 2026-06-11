import net from 'node:net';
import { config } from '../config.js';

/**
 * Upload scanning pipeline:
 *  1. Type allowlist + magic-byte verification (extension spoofing defense)
 *  2. Malware: ClamAV (clamd INSTREAM) when CLAMD_HOST is configured;
 *     built-in heuristics otherwise (EICAR, executable magic bytes,
 *     macro-bearing Office archives, embedded JS in PDFs)
 *  3. PII detection: SSNs, credit cards (Luhn-validated), emails, phones
 *
 * Results: clean | quarantined (+ reasons) and pii: clean | flagged (+ kinds)
 */

export interface ScanResult {
  malware: 'clean' | 'quarantined';
  malwareReasons: string[];
  pii: 'clean' | 'flagged';
  piiKinds: string[];
}

const MAGIC: Array<{ type: string; bytes: number[]; offset?: number }> = [
  { type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
];

const EXECUTABLE_MAGIC: Array<{ name: string; bytes: number[] }> = [
  { name: 'windows-pe', bytes: [0x4d, 0x5a] }, // MZ
  { name: 'elf', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'mach-o', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: 'shell-script', bytes: [0x23, 0x21] }, // #!
];

const EICAR =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

export function verifyMagicBytes(buf: Buffer, declaredType: string): boolean {
  if (declaredType === 'text/csv' || declaredType === 'text/plain') {
    // must not be a binary executable masquerading as text
    return !EXECUTABLE_MAGIC.some((m) => startsWith(buf, m.bytes));
  }
  if (declaredType === 'image/avif') return buf.includes(Buffer.from('ftyp'), 0);
  const rule = MAGIC.find((m) => m.type === declaredType);
  if (!rule) return false;
  return startsWith(buf, rule.bytes, rule.offset ?? 0);
}

async function clamavScan(buf: Buffer): Promise<{ infected: boolean; signature?: string } | null> {
  if (!config.clamav.host) return null;
  return new Promise((resolve) => {
    const socket = net.createConnection(
      { host: config.clamav.host, port: config.clamav.port, timeout: 30_000 },
      () => {
        socket.write('zINSTREAM\0');
        const size = Buffer.alloc(4);
        size.writeUInt32BE(buf.length);
        socket.write(size);
        socket.write(buf);
        socket.write(Buffer.from([0, 0, 0, 0]));
      },
    );
    let response = '';
    socket.on('data', (d) => {
      response += d.toString();
    });
    socket.on('end', () => {
      if (response.includes('FOUND')) {
        resolve({ infected: true, signature: response.replace(/\0/g, '').trim() });
      } else resolve({ infected: false });
    });
    socket.on('error', () => resolve(null)); // unreachable → fall back to heuristics
    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

function heuristicMalwareScan(buf: Buffer): string[] {
  const reasons: string[] = [];
  const head = buf.subarray(0, 8);
  for (const m of EXECUTABLE_MAGIC) {
    if (startsWith(head, m.bytes)) reasons.push(`executable_magic:${m.name}`);
  }
  if (buf.includes(Buffer.from(EICAR))) reasons.push('eicar_test_signature');
  // Office macro container: ZIP with vbaProject.bin
  if (startsWith(buf, [0x50, 0x4b]) && buf.includes(Buffer.from('vbaProject.bin'))) {
    reasons.push('office_macro_container');
  }
  // PDF with embedded JavaScript or auto-open action
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) {
    const text = buf.subarray(0, Math.min(buf.length, 2_000_000)).toString('latin1');
    if (/\/JavaScript|\/JS\s*\(/.test(text)) reasons.push('pdf_embedded_javascript');
    if (/\/OpenAction/.test(text) && /\/Launch/.test(text)) reasons.push('pdf_launch_action');
  }
  return reasons;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function detectPii(text: string): string[] {
  const kinds = new Set<string>();
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) kinds.add('ssn');
  const cardCandidates = text.match(/\b(?:\d[ -]?){13,19}\b/g) ?? [];
  for (const cand of cardCandidates) {
    const digits = cand.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      kinds.add('credit_card');
      break;
    }
  }
  if (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(text)) kinds.add('email');
  if (/\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/.test(text)) kinds.add('phone');
  if (/\b\d{1,2}\/\d{1,2}\/\d{4}\b.{0,20}\b(DOB|date of birth|born)\b/i.test(text) ||
      /\b(DOB|date of birth)\b.{0,20}\d{1,2}\/\d{1,2}\/\d{4}/i.test(text)) {
    kinds.add('date_of_birth');
  }
  return [...kinds];
}

export async function scanUpload(buf: Buffer, declaredType: string): Promise<ScanResult> {
  const malwareReasons: string[] = [];

  if (!verifyMagicBytes(buf, declaredType)) {
    malwareReasons.push('magic_bytes_mismatch');
  }

  const clam = await clamavScan(buf);
  if (clam?.infected) {
    malwareReasons.push(`clamav:${clam.signature ?? 'detected'}`);
  } else if (clam === null) {
    malwareReasons.push(...heuristicMalwareScan(buf));
  }

  // PII over extractable text (cap to keep scans bounded)
  const textSample = buf.subarray(0, Math.min(buf.length, 5_000_000)).toString('utf8');
  const piiKinds = detectPii(textSample);

  return {
    malware: malwareReasons.length > 0 ? 'quarantined' : 'clean',
    malwareReasons,
    pii: piiKinds.length > 0 ? 'flagged' : 'clean',
    piiKinds,
  };
}
