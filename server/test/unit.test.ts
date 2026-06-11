import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
  generateTotpSecret,
  totpCode,
  verifyTotp,
  signDownload,
  verifyDownload,
  base32Decode,
  base32Encode,
} from '../src/auth/crypto.js';
import { toCsv, toGeoJson, toKml } from '../src/lib/formats.js';
import { PdfBuilder } from '../src/lib/pdf.js';
import { detectPii, verifyMagicBytes } from '../src/services/scanner.js';
import { parseProcurementText } from '../src/services/procurementParser.js';
import { computeConfidence, computeFoiaDueDate, statuteForState, parseCoordinates, haversineMeters } from '@stn/shared';

describe('password hashing (scrypt)', () => {
  it('hashes and verifies; rejects wrong password and garbage hashes', async () => {
    const hash = await hashPassword('s3cret-Passw0rd!');
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword('s3cret-Passw0rd!', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });
});

describe('JWT (HS256)', () => {
  const secret = 'unit-test-secret';
  it('round-trips and rejects tampering, expiry, and alg confusion', () => {
    const token = signJwt({ sub: 'u1', role: 'editor', typ: 'access' }, secret, 60);
    const payload = verifyJwt(token, secret);
    expect(payload?.sub).toBe('u1');
    expect(verifyJwt(token, 'other-secret')).toBeNull();
    expect(verifyJwt(`${token}x`, secret)).toBeNull();
    const expired = signJwt({ sub: 'u1', role: 'editor', typ: 'access' }, secret, -10);
    expect(verifyJwt(expired, secret)).toBeNull();
    // alg:none style forgery
    const [, body] = token.split('.');
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(verifyJwt(`${noneHeader}.${body}.`, secret)).toBeNull();
  });
});

describe('TOTP (RFC 6238)', () => {
  it('verifies current and adjacent windows, rejects others', () => {
    const secret = generateTotpSecret();
    const code = totpCode(secret);
    expect(verifyTotp(secret, code)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, Date.now() - 30_000))).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, Date.now() - 120_000))).toBe(false);
    expect(verifyTotp(secret, 'abc123')).toBe(false);
    expect(verifyTotp(secret, '000000')).toBe(verifyTotp(secret, '000000')); // deterministic
  });
  it('RFC 6238 SHA-1 test vector (secret "12345678901234567890", T=59s → 287082)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpCode(secret, 59_000)).toBe('287082');
  });
  it('base32 round trip', () => {
    const buf = Buffer.from('hello world & more bytes!');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });
});

describe('signed downloads', () => {
  it('verifies valid signatures and rejects tampered/expired ones', () => {
    const suffix = signDownload('exports/x.csv', 'sec', 60);
    const params = new URLSearchParams(suffix);
    expect(verifyDownload('exports/x.csv', params.get('exp')!, params.get('sig')!, 'sec')).toBe(true);
    expect(verifyDownload('exports/other.csv', params.get('exp')!, params.get('sig')!, 'sec')).toBe(false);
    expect(verifyDownload('exports/x.csv', '1', params.get('sig')!, 'sec')).toBe(false);
  });
});

describe('export formats', () => {
  it('CSV escapes quotes/newlines and defuses spreadsheet formula injection', () => {
    const csv = toCsv([{ a: '=cmd()', b: 'line\n"quoted"' }]);
    expect(csv).toContain(`'=cmd()`); // leading apostrophe defuses the formula
    expect(csv).toContain('""quoted""');
  });
  it('GeoJSON and KML are well-formed', () => {
    const geo = JSON.parse(toGeoJson([{ lng: -122, lat: 37, properties: { name: 'A' } }]));
    expect(geo.features[0].geometry.coordinates).toEqual([-122, 37]);
    const kml = toKml([{ lng: -122, lat: 37, properties: { name: 'A<&>' } }]);
    expect(kml).toContain('A&lt;&amp;&gt;');
    expect(kml).toContain('<coordinates>-122,37,0</coordinates>');
  });
  it('PDF builder produces a valid PDF with pages and xref', () => {
    const pdf = new PdfBuilder('Test');
    pdf.heading('Hello');
    pdf.text('Lorem ipsum '.repeat(200));
    pdf.table(['a', 'b'], [['1', '2'], ['3', '4']]);
    pdf.mapSnapshot([{ lng: -122, lat: 37 }], { minLng: -123, minLat: 36, maxLng: -121, maxLat: 38 });
    const buf = pdf.build();
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.toString('latin1')).toContain('startxref');
    expect(buf.toString('latin1')).toContain('%%EOF');
  });
});

describe('scanner', () => {
  it('detects PII kinds with Luhn validation for cards', () => {
    expect(detectPii('SSN 123-45-6789 here')).toContain('ssn');
    expect(detectPii('card 4111 1111 1111 1111')).toContain('credit_card');
    expect(detectPii('card 4111 1111 1111 1112')).not.toContain('credit_card'); // bad Luhn
    expect(detectPii('mail me a@b.co thanks')).toContain('email');
    expect(detectPii('call (415) 555-2671 now')).toContain('phone');
    expect(detectPii('nothing sensitive')).toEqual([]);
  });
  it('verifies magic bytes against declared type', () => {
    expect(verifyMagicBytes(Buffer.from('%PDF-1.4 etc'), 'application/pdf')).toBe(true);
    expect(verifyMagicBytes(Buffer.from('MZ\x90\x00'), 'application/pdf')).toBe(false);
    expect(verifyMagicBytes(Buffer.from('plain text'), 'text/plain')).toBe(true);
    expect(verifyMagicBytes(Buffer.from('\x7fELF...'), 'text/plain')).toBe(false);
  });
});

describe('procurement parser', () => {
  it('extracts vendor, amount, dates, technology terms with confidence', () => {
    const result = parseProcurementText(`
      CITY OF EXAMPLE — CONTRACT AWARD
      Vendor: Flock Safety
      The City agrees to a total contract amount not to exceed $1,250,000.00 for the
      deployment of automated license plate reader (ALPR) cameras.
      Term: January 15, 2024 through 2027-01-14.
    `);
    expect(result.vendor).toBe('Flock Safety');
    expect(result.amount).toBe(1_250_000);
    expect(result.startDate).toBe('2024-01-15');
    expect(result.endDate).toBe('2027-01-14');
    expect(result.technologyTerms).toContain('license plate reader');
    expect(result.confidence).toBeGreaterThan(70);
  });
  it('degrades gracefully on garbage with warnings instead of crashing', () => {
    const result = parseProcurementText('zzz');
    expect(result.vendor).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(30);
  });
});

describe('confidence engine', () => {
  it('scores verified government sources high, disputed community low, with explanations', () => {
    const high = computeConfidence({
      sourceType: 'government',
      sourceVerification: 'verified',
      evidenceCount: 3,
      lastVerifiedAt: new Date(),
      openDisputes: 0,
      acceptedDisputes: 0,
      corroboratingSources: 2,
    });
    expect(high.score).toBeGreaterThanOrEqual(90);
    expect(high.factors.find((f) => f.factor === 'corroboration')).toBeTruthy();

    const low = computeConfidence({
      sourceType: 'community',
      sourceVerification: 'unverified',
      evidenceCount: 0,
      lastVerifiedAt: null,
      openDisputes: 2,
      acceptedDisputes: 1,
      corroboratingSources: 0,
    });
    expect(low.score).toBeLessThan(30);
    expect(low.score).toBeGreaterThanOrEqual(0);
  });
});

describe('FOIA statutes', () => {
  it('finds statutes by name/abbr and computes business-day deadlines', () => {
    const ca = statuteForState('California');
    expect(ca?.citation).toContain('7920');
    expect(statuteForState('tx')?.lawName).toContain('Texas');
    // NY: 5 business days from a Friday → next Friday
    const ny = statuteForState('New York')!;
    const due = computeFoiaDueDate(new Date('2026-06-05T12:00:00Z'), ny); // Friday
    expect(due.getDay()).not.toBe(0);
    expect(due.getDay()).not.toBe(6);
    const days = Math.round((due.getTime() - new Date('2026-06-05T12:00:00Z').getTime()) / 86_400_000);
    expect(days).toBe(7); // 5 business days spans a weekend
  });
});

describe('geo utilities', () => {
  it('parses pasted coordinates in either order and rejects garbage', () => {
    expect(parseCoordinates('37.77, -122.41')).toEqual({ lat: 37.77, lng: -122.41 });
    expect(parseCoordinates('-122.41, 37.77')).toEqual({ lat: 37.77, lng: -122.41 });
    expect(parseCoordinates('​37.77,​ -122.41​')).toEqual({ lat: 37.77, lng: -122.41 }); // zero-width chars
    expect(parseCoordinates('not coords')).toBeNull();
    expect(parseCoordinates('999, 999')).toBeNull();
  });
  it('haversine distance is sane (SF→Oakland ≈ 13.4km)', () => {
    const d = haversineMeters(-122.4194, 37.7749, -122.2712, 37.8044);
    expect(d).toBeGreaterThan(12_000);
    expect(d).toBeLessThan(15_000);
  });
});
