import type { ConfidenceFactor } from './types.js';
import type { SourceType, VerificationStatus } from './constants.js';

export interface ConfidenceInput {
  sourceType: SourceType | null;
  sourceVerification: VerificationStatus | null;
  evidenceCount: number;
  lastVerifiedAt: string | Date | null;
  openDisputes: number;
  acceptedDisputes: number;
  corroboratingSources: number;
}

const SOURCE_BASE: Record<SourceType, number> = {
  government: 70,
  ngo: 60,
  academic: 60,
  media: 50,
  community: 35,
};

/**
 * Deterministic, explainable confidence scoring (0–100).
 * Shared verbatim between server (persistence + recalc job) and web
 * (score explanation UI) so explanations always match stored values.
 */
export function computeConfidence(input: ConfidenceInput): {
  score: number;
  factors: ConfidenceFactor[];
} {
  const factors: ConfidenceFactor[] = [];
  let score = 20;
  factors.push({ factor: 'baseline', delta: 20, note: 'All records start at a conservative baseline.' });

  if (input.sourceType) {
    const base = SOURCE_BASE[input.sourceType] - 20;
    score += base;
    factors.push({
      factor: 'source_type',
      delta: base,
      note: `Source category "${input.sourceType}" adjusts the baseline.`,
    });
  } else {
    factors.push({ factor: 'source_type', delta: 0, note: 'No source on record — treated as unverified.' });
  }

  if (input.sourceVerification === 'verified') {
    score += 15;
    factors.push({ factor: 'source_verified', delta: 15, note: 'The source registry entry is verified.' });
  } else if (input.sourceVerification === 'rejected') {
    score -= 25;
    factors.push({ factor: 'source_rejected', delta: -25, note: 'The source failed verification review.' });
  }

  const evidenceBonus = Math.min(15, input.evidenceCount * 5);
  if (evidenceBonus > 0) {
    score += evidenceBonus;
    factors.push({
      factor: 'evidence',
      delta: evidenceBonus,
      note: `${input.evidenceCount} evidence file(s) attached (+5 each, max +15).`,
    });
  }

  if (input.lastVerifiedAt) {
    const ageDays = Math.max(0, (Date.now() - new Date(input.lastVerifiedAt).getTime()) / 86_400_000);
    const decay = Math.min(20, Math.floor(ageDays / 30));
    if (decay > 0) {
      score -= decay;
      factors.push({
        factor: 'verification_age',
        delta: -decay,
        note: `Last verified ${Math.floor(ageDays)} days ago (−1 per 30 days, max −20).`,
      });
    } else {
      factors.push({ factor: 'verification_age', delta: 0, note: 'Recently verified.' });
    }
  } else {
    score -= 10;
    factors.push({ factor: 'never_verified', delta: -10, note: 'Record has never been field-verified.' });
  }

  const disputePenalty = Math.min(30, input.openDisputes * 15);
  if (disputePenalty > 0) {
    score -= disputePenalty;
    factors.push({
      factor: 'open_disputes',
      delta: -disputePenalty,
      note: `${input.openDisputes} open dispute(s) (−15 each, max −30).`,
    });
  }

  if (input.acceptedDisputes > 0) {
    score -= 20;
    factors.push({
      factor: 'accepted_disputes',
      delta: -20,
      note: 'A past dispute against this record was upheld.',
    });
  }

  if (input.corroboratingSources > 1) {
    score += 10;
    factors.push({
      factor: 'corroboration',
      delta: 10,
      note: `${input.corroboratingSources} independent sources corroborate this record.`,
    });
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return { score: clamped, factors };
}

export function confidenceLabel(score: number): 'high' | 'medium' | 'low' | 'unverified' {
  if (score >= 75) return 'high';
  if (score >= 50) return 'medium';
  if (score >= 30) return 'low';
  return 'unverified';
}
