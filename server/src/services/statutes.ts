import crypto from 'node:crypto';
import { FOIA_STATUTES, TERRITORY_STATUTES, FEDERAL_FOIA, type FoiaStatute } from '@stn/shared';
import { query, queryOne } from '../db/pool.js';
import { cachedJson, cache } from '../cache/index.js';
import { config } from '../config.js';

/**
 * DB-backed statute store with the shared code constants as both idempotent
 * seed and hard fallback: if the table is empty or the database errors, the
 * FOIA builder keeps working from the compiled-in data. Admin edits and
 * approved recheck proposals supersede seed rows without code changes.
 */

const ALL_SEED: FoiaStatute[] = [...FOIA_STATUTES, ...TERRITORY_STATUTES, FEDERAL_FOIA];

/** Boot-time idempotent seed — inserts only jurisdictions with no live row. */
export async function ensureStatutesSeeded(): Promise<number> {
  let inserted = 0;
  for (const s of ALL_SEED) {
    const res = await query(
      `INSERT INTO statutes (jurisdiction_key, state, law_name, citation, response_days, business_days, notes, source_url, checked_at, checked_by)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, now(), 'seed'
       WHERE NOT EXISTS (
         SELECT 1 FROM statutes WHERE jurisdiction_key = $1 AND review_status = 'approved' AND superseded_at IS NULL
       )`,
      [s.abbr, s.state, s.lawName, s.citation, s.responseDays, s.businessDays, s.notes ?? null, s.sourceUrl ?? null],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

interface StatuteRow {
  jurisdiction_key: string;
  state: string;
  law_name: string;
  citation: string;
  response_days: number | null;
  business_days: boolean;
  notes: string | null;
  version: number;
}

const toStatute = (r: StatuteRow): FoiaStatute => ({
  state: r.state,
  abbr: r.jurisdiction_key,
  lawName: r.law_name,
  citation: r.citation,
  responseDays: r.response_days,
  businessDays: r.business_days,
  ...(r.notes ? { notes: r.notes } : {}),
});

/** Admin overrides (settings key `foia.deadlineOverrides`) overlay the store. */
async function deadlineOverrides(): Promise<Record<string, { responseDays?: number; businessDays?: boolean }>> {
  const row = await queryOne<{ value: Record<string, { responseDays?: number; businessDays?: boolean }> }>(
    `SELECT value FROM app_settings WHERE key = 'foia.deadlineOverrides'`,
  );
  return row?.value ?? {};
}

/** All live statutes, DB-first with code fallback, cached 5 minutes. */
export async function activeStatutes(): Promise<FoiaStatute[]> {
  return cachedJson('statutes:active', 300, async () => {
    try {
      const { rows } = await query<StatuteRow>(
        `SELECT jurisdiction_key, state, law_name, citation, response_days, business_days, notes, version
         FROM statutes WHERE review_status = 'approved' AND superseded_at IS NULL ORDER BY state`,
      );
      const overrides = await deadlineOverrides();
      const base = rows.length > 0 ? rows.map(toStatute) : ALL_SEED;
      return base.map((s) => {
        const o = overrides[s.abbr] ?? overrides[s.state];
        return o
          ? {
              ...s,
              ...(o.responseDays !== undefined ? { responseDays: o.responseDays } : {}),
              ...(o.businessDays !== undefined ? { businessDays: o.businessDays } : {}),
              notes: `${s.notes ? `${s.notes} ` : ''}(deadline adjusted by the operators)`.trim(),
            }
          : s;
      });
    } catch (err) {
      process.stderr.write(`[statutes] store unavailable — serving compiled-in data: ${(err as Error).message}\n`);
      return ALL_SEED;
    }
  });
}

/** Statute for a state/territory name or abbreviation, store-backed. */
export async function statuteFor(nameOrAbbr: string): Promise<FoiaStatute | null> {
  const needle = nameOrAbbr.trim().toLowerCase();
  const all = await activeStatutes();
  return all.find((s) => s.state.toLowerCase() === needle || s.abbr.toLowerCase() === needle) ?? null;
}

export async function invalidateStatuteCache(): Promise<void> {
  await cache.del('statutes:active');
}

/* ------------------------------------------------------------------ *
 * Recheck: refetch each statute's authoritative source; on drift, file a
 * PROPOSAL for human review. Optional LLM extraction (OpenAI-compatible —
 * DeepSeek/GLM endpoints drop in) sharpens proposals; without it, a hash/
 * citation heuristic still catches drift. Nothing auto-publishes, ever.
 * ------------------------------------------------------------------ */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export function legalLlmAvailable(): boolean {
  return Boolean(config.legalLlm.apiUrl && config.legalLlm.apiKey && config.legalLlm.model);
}

interface LlmExtraction {
  lawName?: string;
  citation?: string;
  responseDays?: number | null;
  businessDays?: boolean;
  confidence?: number;
  quote?: string;
}

async function llmExtract(text: string, current: StatuteRow, fetchImpl: FetchImpl): Promise<LlmExtraction | null> {
  try {
    const res = await fetchImpl(`${config.legalLlm.apiUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.legalLlm.apiKey}` },
      body: JSON.stringify({
        model: config.legalLlm.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You extract public-records statute facts from official legal text. Reply with strict JSON: ' +
              '{"lawName": string, "citation": string, "responseDays": number|null, "businessDays": boolean, ' +
              '"confidence": number 0-1, "quote": string (verbatim sentence supporting responseDays)}. ' +
              'responseDays is the initial statutory response window; null if the law sets no fixed day count.',
          },
          {
            role: 'user',
            content: `Jurisdiction: ${current.state}\nCurrently recorded: ${current.law_name} (${current.citation}), responseDays=${current.response_days}, businessDays=${current.business_days}\n\nOfficial text (truncated):\n${text.slice(0, 24_000)}`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    return content ? (JSON.parse(content) as LlmExtraction) : null;
  } catch {
    return null;
  }
}

export interface RecheckResult {
  checked: number;
  unchanged: number;
  proposals: number;
}

/** One recheck pass over the stalest N statutes that carry a source_url. */
export async function recheckStatutes(limit = 8, fetchImpl: FetchImpl = fetch): Promise<RecheckResult> {
  const { rows } = await query<StatuteRow & { id: string; source_url: string; source_hash: string | null }>(
    `SELECT id, jurisdiction_key, state, law_name, citation, response_days, business_days, notes, version, source_url, source_hash
     FROM statutes
     WHERE review_status = 'approved' AND superseded_at IS NULL AND source_url IS NOT NULL
     ORDER BY checked_at ASC NULLS FIRST LIMIT $1`,
    [limit],
  );

  const result: RecheckResult = { checked: 0, unchanged: 0, proposals: 0 };

  for (const row of rows) {
    result.checked += 1;
    let text = '';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetchImpl(row.source_url, {
        signal: controller.signal,
        headers: { 'user-agent': 'LensOfLight-StatuteCheck/1.0 (public-records statute currency check)' },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = (await res.text()).slice(0, 500_000);
    } catch (err) {
      // unreachable source is itself review-worthy, but only once per open proposal
      await fileProposal(row, { note: `Source unreachable: ${(err as Error).message.slice(0, 120)}` }, null, result);
      continue;
    }

    const hash = crypto.createHash('sha256').update(text).digest('hex');
    if (hash === row.source_hash) {
      result.unchanged += 1;
      await query(`UPDATE statutes SET checked_at = now(), checked_by = 'job:fetch' WHERE id = $1`, [row.id]);
      continue;
    }

    // content changed (or first fetch): try LLM extraction, else heuristic
    let extraction: LlmExtraction | null = null;
    if (legalLlmAvailable()) extraction = await llmExtract(text, row, fetchImpl);

    if (extraction && extraction.citation) {
      const differs =
        (extraction.lawName && extraction.lawName !== row.law_name) ||
        (extraction.citation && extraction.citation !== row.citation) ||
        (extraction.responseDays !== undefined && extraction.responseDays !== row.response_days) ||
        (extraction.businessDays !== undefined && extraction.businessDays !== row.business_days);
      if (differs) {
        await fileProposal(row, extraction as Record<string, unknown>, extraction.quote ?? null, result, config.legalLlm.model);
      } else {
        result.unchanged += 1;
      }
    } else {
      // heuristic: normalized citation string should still appear in the source
      const normalize = (v: string) => v.toLowerCase().replace(/[§\s.,-]+/g, '');
      if (!normalize(text).includes(normalize(row.citation).slice(0, 12))) {
        await fileProposal(row, { note: 'Source page changed and no longer references the recorded citation — verify manually.' }, null, result);
      } else {
        result.unchanged += 1;
      }
    }

    await query(`UPDATE statutes SET source_hash = $2, checked_at = now(), checked_by = $3 WHERE id = $1`, [
      row.id,
      hash,
      extraction ? 'job:llm' : 'job:fetch',
    ]);
  }
  return result;
}

async function fileProposal(
  current: StatuteRow & { id: string; source_url: string },
  changes: Record<string, unknown>,
  excerpt: string | null,
  result: RecheckResult,
  llmModel?: string,
): Promise<void> {
  // one open proposal per jurisdiction at a time
  const open = await queryOne(
    `SELECT 1 FROM statutes WHERE jurisdiction_key = $1 AND review_status = 'needs_review'`,
    [current.jurisdiction_key],
  );
  if (open) return;

  await query(
    `INSERT INTO statutes (jurisdiction_key, state, law_name, citation, response_days, business_days, notes, source_url,
                           version, review_status, proposed_changes, source_excerpt, llm_model, checked_at, checked_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'needs_review', $10, $11, $12, now(), $13)`,
    [
      current.jurisdiction_key,
      current.state,
      (changes.lawName as string) ?? current.law_name,
      (changes.citation as string) ?? current.citation,
      changes.responseDays !== undefined ? (changes.responseDays as number | null) : current.response_days,
      changes.businessDays !== undefined ? (changes.businessDays as boolean) : current.business_days,
      current.notes,
      current.source_url,
      current.version + 1,
      JSON.stringify(changes),
      excerpt,
      llmModel ?? null,
      llmModel ? 'job:llm' : 'job:fetch',
    ],
  );
  result.proposals += 1;

  await query(
    `INSERT INTO notifications (user_id, kind, title, body, link)
     SELECT id, 'statute_review', 'Statute change proposed', $1, '/admin' FROM users WHERE role = 'admin' AND status = 'active'`,
    [`${current.state}: the public-records statute source changed — review the proposed update.`],
  );
}
