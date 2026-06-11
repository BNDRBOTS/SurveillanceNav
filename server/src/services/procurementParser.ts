import { KNOWN_VENDORS } from '@stn/shared';

/**
 * Procurement document parser: extracts vendor, contract amounts, dates,
 * and surveillance-technology terms from RFP/contract text, with per-field
 * provenance and an overall confidence score. Everything lands in a
 * human-in-the-loop review queue (`needs_review`) — parsing never silently
 * publishes data.
 */

export interface ParsedProcurement {
  vendor: string | null;
  vendorEvidence: string | null;
  amount: number | null;
  amountEvidence: string | null;
  startDate: string | null;
  endDate: string | null;
  dateEvidence: string[];
  technologyTerms: string[];
  confidence: number;
  fieldConfidence: Record<string, number>;
  excerpt: string;
  warnings: string[];
}

const TECH_TERM_PATTERNS: Array<{ term: string; pattern: RegExp }> = [
  { term: 'license plate reader', pattern: /\b(automated\s+)?license\s+plate\s+(reader|recognition)|\bALPR\b|\bLPR\b/i },
  { term: 'facial recognition', pattern: /\bfacial\s+recognition|\bface\s+matching|\bbiometric\s+identification/i },
  { term: 'gunshot detection', pattern: /\bgunshot\s+detection|\bShotSpotter\b|\bacoustic\s+sensor/i },
  { term: 'drone / UAS', pattern: /\bdrone[s]?\b|\bunmanned\s+aircraft|\bUAS\b|\bsUAS\b|\bquadcopter/i },
  { term: 'CCTV', pattern: /\bCCTV\b|\bclosed[\s-]circuit|\bvideo\s+surveillance|\bsecurity\s+camera/i },
  { term: 'cell-site simulator', pattern: /\bcell[\s-]site\s+simulator|\bstingray\b|\bIMSI\s+catcher/i },
  { term: 'body-worn camera', pattern: /\bbody[\s-]worn\s+camera|\bBWC\b|\bbody\s+camera/i },
  { term: 'predictive policing', pattern: /\bpredictive\s+policing|\bcrime\s+forecast/i },
  { term: 'social media monitoring', pattern: /\bsocial\s+media\s+(monitoring|surveillance|intelligence)/i },
  { term: 'data broker / fusion', pattern: /\bdata\s+fusion|\bfusion\s+center|\breal[\s-]time\s+crime\s+center/i },
  { term: 'video analytics', pattern: /\bvideo\s+analytics|\bobject\s+detection|\bperson\s+of\s+interest/i },
];

const VENDOR_LABEL = /(?:vendor|contractor|supplier|awarded\s+to|provider|company)\s*[:-]\s*([A-Z][A-Za-z0-9 .,&'-]{2,60})/;

const MONTHS =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';

const DATE_PATTERNS = [
  new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'gi'),
  /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,
  /\b(\d{4})-(\d{2})-(\d{2})\b/g,
];

const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function normalizeDate(match: RegExpExecArray, patternIndex: number): string | null {
  try {
    let y: number, m: number, d: number;
    if (patternIndex === 0) {
      const monthKey = (match[1] ?? '').toLowerCase().slice(0, 4).replace(/\.$/, '');
      m = MONTH_INDEX[monthKey.slice(0, 3)] ?? MONTH_INDEX[monthKey] ?? 0;
      d = Number(match[2]);
      y = Number(match[3]);
    } else if (patternIndex === 1) {
      m = Number(match[1]);
      d = Number(match[2]);
      y = Number(match[3]);
    } else {
      y = Number(match[1]);
      m = Number(match[2]);
      d = Number(match[3]);
    }
    if (!y || !m || !d || m > 12 || d > 31 || y < 1990 || y > 2100) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  } catch {
    return null;
  }
}

function contextAround(text: string, index: number, span = 60): string {
  return text
    .slice(Math.max(0, index - span), Math.min(text.length, index + span))
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseProcurementText(rawText: string): ParsedProcurement {
  const warnings: string[] = [];
  const text = rawText.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u00A0\u200B-\u200D\uFEFF]/g, ' ').slice(0, 500_000);
  if (rawText.length > 500_000) warnings.push('Document truncated to 500k characters for parsing.');
  if (text.trim().length < 40) warnings.push('Very little extractable text — document may be scanned (OCR required).');

  const fieldConfidence: Record<string, number> = {};

  // --- vendor -----------------------------------------------------------
  let vendor: string | null = null;
  let vendorEvidence: string | null = null;
  for (const known of KNOWN_VENDORS) {
    const idx = text.toLowerCase().indexOf(known.toLowerCase());
    if (idx >= 0) {
      vendor = known;
      vendorEvidence = contextAround(text, idx);
      fieldConfidence.vendor = 90;
      break;
    }
  }
  if (!vendor) {
    const m = VENDOR_LABEL.exec(text);
    if (m?.[1]) {
      vendor = m[1].replace(/\s+/g, ' ').replace(/[.,;]+$/, '').trim();
      vendorEvidence = contextAround(text, m.index);
      fieldConfidence.vendor = 60;
    } else {
      fieldConfidence.vendor = 0;
      warnings.push('No vendor identified — set manually during review.');
    }
  }

  // --- amount -----------------------------------------------------------
  let amount: number | null = null;
  let amountEvidence: string | null = null;
  const amountMatches = [...text.matchAll(/\$\s?([\d,]+(?:\.\d{2})?)\s?(million|M\b)?/gi)];
  let best = 0;
  for (const m of amountMatches) {
    let value = Number((m[1] ?? '0').replace(/,/g, ''));
    if (m[2]) value *= 1_000_000;
    if (!Number.isFinite(value) || value <= 0 || value > 1e12) continue;
    // Prefer amounts near contract-value language; otherwise take the max.
    const ctx = contextAround(text, m.index ?? 0, 80).toLowerCase();
    const weighted = /total|contract|not[\s-]to[\s-]exceed|amount|award|sum of/.test(ctx) ? value * 10 : value;
    if (weighted > best) {
      best = weighted;
      amount = value;
      amountEvidence = contextAround(text, m.index ?? 0, 80);
    }
  }
  fieldConfidence.amount = amount === null ? 0 : amountEvidence && /total|contract|not[\s-]to[\s-]exceed|award/i.test(amountEvidence) ? 85 : 55;
  if (amount === null) warnings.push('No contract amount found.');

  // --- dates ------------------------------------------------------------
  const found: string[] = [];
  const dateEvidence: string[] = [];
  DATE_PATTERNS.forEach((pattern, pi) => {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null && found.length < 40) {
      const norm = normalizeDate(m, pi);
      if (norm) {
        found.push(norm);
        if (dateEvidence.length < 6) dateEvidence.push(contextAround(text, m.index, 50));
      }
    }
  });
  const sorted = [...new Set(found)].sort();
  const startDate = sorted[0] ?? null;
  const endDate = sorted.length > 1 ? sorted[sorted.length - 1]! : null;
  fieldConfidence.dates = sorted.length === 0 ? 0 : sorted.length === 1 ? 45 : 70;
  if (sorted.length === 0) warnings.push('No dates found in document.');

  // --- technology terms ---------------------------------------------------
  const technologyTerms = TECH_TERM_PATTERNS.filter((t) => t.pattern.test(text)).map((t) => t.term);
  fieldConfidence.technology = technologyTerms.length > 0 ? 80 : 0;
  if (technologyTerms.length === 0) {
    warnings.push('No surveillance technology terms matched — confirm document relevance.');
  }

  const weights = { vendor: 0.3, amount: 0.25, dates: 0.15, technology: 0.3 } as const;
  const confidence = Math.round(
    (fieldConfidence.vendor ?? 0) * weights.vendor +
      (fieldConfidence.amount ?? 0) * weights.amount +
      (fieldConfidence.dates ?? 0) * weights.dates +
      (fieldConfidence.technology ?? 0) * weights.technology,
  );

  return {
    vendor,
    vendorEvidence,
    amount,
    amountEvidence,
    startDate,
    endDate,
    dateEvidence,
    technologyTerms,
    confidence,
    fieldConfidence,
    excerpt: text.slice(0, 1500).replace(/\s+/g, ' ').trim(),
    warnings,
  };
}
