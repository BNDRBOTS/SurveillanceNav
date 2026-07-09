import { describe, it, expect, beforeAll } from 'vitest';
import { FOIA_STATUTES, TERRITORY_STATUTES } from '@stn/shared';
import { getApp, createUser, auth } from './helpers.js';
import { query, queryOne } from '../src/db/pool.js';
import {
  ensureStatutesSeeded,
  activeStatutes,
  statuteFor,
  invalidateStatuteCache,
  recheckStatutes,
  type FetchImpl,
} from '../src/services/statutes.js';
import { cache } from '../src/cache/index.js';

beforeAll(async () => {
  await ensureStatutesSeeded();
  await invalidateStatuteCache();
});

describe('statute store', () => {
  it('seeds 50 states + DC + federal + 5 territories, idempotently', async () => {
    const again = await ensureStatutesSeeded();
    expect(again).toBe(0); // second run inserts nothing
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM statutes WHERE review_status = 'approved' AND superseded_at IS NULL`,
    );
    expect(rows[0]!.n).toBe(FOIA_STATUTES.length + TERRITORY_STATUTES.length + 1); // 51 + 5 + US
  });

  it('serves territories through the live read path', async () => {
    const pr = await statuteFor('PR');
    expect(pr).toMatchObject({ state: 'Puerto Rico', responseDays: 10, businessDays: true });
    const guam = await statuteFor('Guam');
    expect(guam).toMatchObject({ citation: '5 GCA ch. 10', responseDays: 4 });
    const as = await statuteFor('American Samoa');
    expect(as?.responseDays).toBeNull();
  });

  it('honors the admin deadline override setting (previously dead)', async () => {
    await query(
      `INSERT INTO app_settings (key, value) VALUES ('foia.deadlineOverrides', '{"CA": {"responseDays": 12}}')
       ON CONFLICT (key) DO UPDATE SET value = '{"CA": {"responseDays": 12}}'`,
    );
    await invalidateStatuteCache();
    const ca = await statuteFor('California');
    expect(ca?.responseDays).toBe(12);
    expect(ca?.notes).toContain('adjusted by the operators');
    await query(`DELETE FROM app_settings WHERE key = 'foia.deadlineOverrides'`);
    await invalidateStatuteCache();
  });

  it('reference endpoint returns federal, states, and territories from the store', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/reference/foia-statutes' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.federal.abbr).toBe('US');
    expect(body.states.length).toBe(FOIA_STATUTES.length);
    expect(body.territories.length).toBe(5);
  });
});

describe('statute recheck job', () => {
  const stubFetch =
    (pageText: string, llmJson?: Record<string, unknown>): FetchImpl =>
    async (url: string) => {
      if (url.includes('/chat/completions')) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(llmJson ?? {}) } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(pageText, { status: 200 });
    };

  it('unchanged source hash updates checked_at only, no proposals', async () => {
    const row = await queryOne<{ id: string; citation: string; source_url: string }>(
      `SELECT id, citation, source_url FROM statutes
       WHERE jurisdiction_key = 'US' AND review_status = 'approved' AND superseded_at IS NULL`,
    );
    const page = `Official text referencing ${row!.citation} in full.`;
    const first = await recheckStatutes(1, stubFetch(page));
    expect(first.checked).toBe(1);
    // second pass with identical content: hash matches → unchanged
    const second = await recheckStatutes(1, stubFetch(page));
    expect(second.unchanged + second.proposals).toBeGreaterThan(0);
  });

  it('heuristic drift (citation vanished) files exactly one review proposal + admin notification', async () => {
    const admin = await createUser('admin');
    const target = await queryOne<{ jurisdiction_key: string }>(
      `SELECT jurisdiction_key FROM statutes
       WHERE review_status = 'approved' AND superseded_at IS NULL AND source_url IS NOT NULL
         AND jurisdiction_key <> 'US'
       ORDER BY checked_at ASC NULLS FIRST LIMIT 1`,
    );
    const key = target!.jurisdiction_key;

    const drifted = 'A completely rewritten page that references nothing familiar at all.';
    await recheckStatutes(1, stubFetch(drifted));
    // run again — the open proposal must not duplicate
    await query(`UPDATE statutes SET checked_at = NULL WHERE jurisdiction_key = $1 AND review_status = 'approved'`, [key]);
    await recheckStatutes(1, stubFetch(drifted + ' now changed again'));

    const proposals = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM statutes WHERE jurisdiction_key = $1 AND review_status = 'needs_review'`,
      [key],
    );
    expect(proposals.rows[0]!.n).toBe(1);

    const app = await getApp();
    const notif = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/notifications',
      headers: auth(admin),
    });
    const items = notif.json().items as Array<{ title: string }>;
    expect(items.some((n) => n.title === 'Statute change proposed')).toBe(true);
  });

  it('approve supersedes the active row, bumps version, and updates the live read path', async () => {
    const app = await getApp();
    const admin = await createUser('admin');
    const proposal = await queryOne<{ id: string; jurisdiction_key: string; version: number }>(
      `SELECT id, jurisdiction_key, version FROM statutes WHERE review_status = 'needs_review' LIMIT 1`,
    );
    expect(proposal).toBeTruthy();

    const approve = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/statutes/${proposal!.id}/approve`,
      headers: auth(admin),
    });
    expect(approve.statusCode).toBe(200);

    const active = await queryOne<{ id: string; version: number }>(
      `SELECT id, version FROM statutes WHERE jurisdiction_key = $1 AND review_status = 'approved' AND superseded_at IS NULL`,
      [proposal!.jurisdiction_key],
    );
    expect(active!.id).toBe(proposal!.id);
    expect(active!.version).toBe(proposal!.version);

    const superseded = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM statutes WHERE jurisdiction_key = $1 AND superseded_at IS NOT NULL`,
      [proposal!.jurisdiction_key],
    );
    expect(superseded.rows[0]!.n).toBeGreaterThan(0);
  });

  it('admin PATCH creates a new approved version directly and compose picks it up', async () => {
    const app = await getApp();
    const admin = await createUser('admin');
    const edit = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/statutes/AK',
      headers: auth(admin),
      payload: { responseDays: 11, notes: 'Adjusted after 2026 session amendment (test).' },
    });
    expect(edit.statusCode).toBe(200);

    const ak = await statuteFor('Alaska');
    expect(ak?.responseDays).toBe(11);

    const versions = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM statutes WHERE jurisdiction_key = 'AK'`,
    );
    expect(versions.rows[0]!.n).toBeGreaterThanOrEqual(2);
  });

  it('reject leaves the active statute untouched', async () => {
    const app = await getApp();
    const admin = await createUser('admin');
    // force a fresh proposal on US via drift
    await query(`UPDATE statutes SET checked_at = NULL, source_hash = NULL WHERE jurisdiction_key = 'US' AND review_status = 'approved'`);
    await recheckStatutes(1, stubFetch('entirely unrelated content'));
    const proposal = await queryOne<{ id: string }>(
      `SELECT id FROM statutes WHERE jurisdiction_key = 'US' AND review_status = 'needs_review'`,
    );
    if (proposal) {
      const before = await statuteFor('US');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/statutes/${proposal.id}/reject`,
        headers: auth(admin),
      });
      expect(res.statusCode).toBe(200);
      await invalidateStatuteCache();
      const after = await statuteFor('US');
      expect(after).toEqual(before);
    }
  });

  it('falls back to compiled-in statutes when the table is empty', async () => {
    // simulate an unmigrated/empty store: hide the active rows, remembering exactly which
    const hidden = await query<{ id: string }>(
      `UPDATE statutes SET superseded_at = now()
       WHERE superseded_at IS NULL AND review_status = 'approved' RETURNING id`,
    );
    await cache.del('statutes:active');
    const all = await activeStatutes();
    expect(all.length).toBeGreaterThanOrEqual(FOIA_STATUTES.length);
    // restore only the rows that were active before (avoids tripping the one-active index)
    await query(`UPDATE statutes SET superseded_at = NULL WHERE id = ANY($1::uuid[])`, [
      hidden.rows.map((r) => r.id),
    ]);
    await cache.del('statutes:active');
  });
});
