import { computeConfidence } from '@stn/shared';
import { query, queryOne } from '../db/pool.js';

/**
 * Recomputes and persists an asset's confidence score + explanation factors
 * from live provenance signals. Used on every provenance-affecting event
 * (evidence upload, dispute open/resolve, source verification) and by the
 * nightly recalculation job.
 */
export async function recalcAssetConfidence(assetId: string): Promise<number | null> {
  const row = await queryOne<{
    source_type: string | null;
    source_verification: string | null;
    last_verified_at: string | null;
    evidence_count: number;
    open_disputes: number;
    accepted_disputes: number;
    corroborating: number;
  }>(
    `SELECT
       s.type AS source_type,
       s.verification_status AS source_verification,
       a.last_verified_at,
       (SELECT count(*) FROM asset_evidence e WHERE e.asset_id = a.id AND e.scan_status = 'clean')::int AS evidence_count,
       (SELECT count(*) FROM disputes d WHERE d.asset_id = a.id AND d.status IN ('open','under_review'))::int AS open_disputes,
       (SELECT count(*) FROM disputes d WHERE d.asset_id = a.id AND d.status = 'accepted')::int AS accepted_disputes,
       ((CASE WHEN a.source_id IS NULL THEN 0 ELSE 1 END) +
        (SELECT count(*) FROM asset_sources ms WHERE ms.asset_id = a.id AND ms.source_id IS DISTINCT FROM a.source_id))::int AS corroborating
     FROM surveillance_assets a
     LEFT JOIN sources s ON s.id = a.source_id
     WHERE a.id = $1 AND a.deleted_at IS NULL`,
    [assetId],
  );
  if (!row) return null;

  const { score, factors } = computeConfidence({
    sourceType: row.source_type as never,
    sourceVerification: row.source_verification as never,
    evidenceCount: row.evidence_count,
    lastVerifiedAt: row.last_verified_at,
    openDisputes: row.open_disputes,
    acceptedDisputes: row.accepted_disputes,
    corroboratingSources: row.corroborating,
  });

  await query(
    `UPDATE surveillance_assets SET confidence_score = $2, confidence_factors = $3 WHERE id = $1`,
    [assetId, score, JSON.stringify(factors)],
  );
  return score;
}
