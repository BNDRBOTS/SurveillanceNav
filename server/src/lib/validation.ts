import type { z } from 'zod';
import { unprocessable, badRequest } from './errors.js';

/** Parse with zod and convert failures into the standard 422 envelope. */
export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    throw unprocessable('Validation failed — check the highlighted fields.', details);
  }
  return result.data;
}

const MAX_JSON_DEPTH = 12;

/** Reject pathological nesting (JSON bombs) before zod ever sees it. */
export function assertSaneJsonDepth(value: unknown, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) {
    throw badRequest('Request body exceeds maximum nesting depth');
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw badRequest('Request array too large');
    for (const item of value) assertSaneJsonDepth(item, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 1_000) throw badRequest('Request object too large');
    for (const [, v] of entries) assertSaneJsonDepth(v, depth + 1);
  }
}

export interface PageParams {
  page: number;
  pageSize: number;
}

export function paginate<T>(items: T[], total: number, p: PageParams) {
  return {
    items,
    page: p.page,
    pageSize: p.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / p.pageSize)),
  };
}

/** Whitelist-mapped ORDER BY — never interpolate user sort keys directly. */
export function safeSort(
  requested: string | undefined,
  allowed: Record<string, string>,
  fallback: string,
): string {
  if (!requested) return fallback;
  return allowed[requested] ?? fallback;
}
