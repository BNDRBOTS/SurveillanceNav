import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { query } from '../db/pool.js';
import { hashPassword, verifyPassword } from './crypto.js';

/**
 * One-time recovery codes: the non-email path back into an account.
 * Format XXXX-XXXX-XXXX over a Crockford-style alphabet (no 0/O/1/I/L
 * lookalikes) — ~60 bits of entropy per code. Stored scrypt-hashed like
 * passwords; the plaintext exists only in the generation response.
 * Redemption verifies against the user's unused hashes — bounded at
 * RECOVERY_CODE_COUNT scrypt comparisons and shielded by the auth rate
 * bucket, so the worst-case latency is deliberate, not dangerous.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_CODE_COUNT = 10;

function oneCode(): string {
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
    if (i === 3 || i === 7) out += '-';
  }
  return out;
}

/** Canonicalize user input: uppercase, strip everything but the alphabet. */
export function normalizeRecoveryCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return raw.length === 12 ? `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}` : input.toUpperCase();
}

/** Invalidates unused codes and issues a fresh set. Plaintext returned once. */
export async function generateRecoveryCodes(userId: string, tx?: PoolClient): Promise<string[]> {
  const run = (text: string, params: unknown[]) => (tx ? tx.query(text, params) : query(text, params));
  await run(`UPDATE recovery_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) codes.push(oneCode());
  for (const code of codes) {
    const hash = await hashPassword(code);
    await run(`INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [userId, hash]);
  }
  return codes;
}

export async function remainingRecoveryCodes(userId: string): Promise<{ remaining: number; generatedAt: string | null }> {
  const { rows } = await query<{ n: number; latest: string | null }>(
    `SELECT count(*)::int AS n, max(created_at)::text AS latest FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  return { remaining: rows[0]?.n ?? 0, generatedAt: rows[0]?.latest ?? null };
}

/** Verifies and consumes one code. Returns remaining unused count, or null if no match. */
export async function redeemRecoveryCode(userId: string, input: string): Promise<{ remaining: number } | null> {
  const code = normalizeRecoveryCode(input);
  const { rows } = await query<{ id: string; code_hash: string }>(
    `SELECT id, code_hash FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  for (const row of rows) {
    if (await verifyPassword(code, row.code_hash)) {
      await query(`UPDATE recovery_codes SET used_at = now() WHERE id = $1`, [row.id]);
      return { remaining: rows.length - 1 };
    }
  }
  return null;
}
