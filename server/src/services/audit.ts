import { query } from '../db/pool.js';

/**
 * Append-only audit trail. Writes must never break the primary operation:
 * on DB failure the entry is buffered in memory and flushed by the next
 * successful write (bounded buffer; overflow drops oldest and logs).
 */

export interface AuditEntry {
  actorId: string | null;
  action: string;
  resource: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

const buffer: AuditEntry[] = [];
const BUFFER_MAX = 1000;

async function write(entry: AuditEntry): Promise<void> {
  await query(
    `INSERT INTO audit_logs (actor_id, action, resource, resource_id, metadata, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.actorId,
      entry.action,
      entry.resource,
      entry.resourceId ?? null,
      JSON.stringify(entry.metadata ?? {}),
      entry.ip ?? null,
      (entry.userAgent ?? '').slice(0, 300) || null,
    ],
  );
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    // flush any buffered entries first to preserve ordering
    while (buffer.length > 0) {
      const pending = buffer[0]!;
      await write(pending);
      buffer.shift();
    }
    await write(entry);
  } catch {
    if (buffer.length >= BUFFER_MAX) buffer.shift();
    buffer.push(entry);
  }
}

export function auditBufferSize(): number {
  return buffer.length;
}
