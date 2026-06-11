import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyJwt, type JwtPayload } from '../auth/crypto.js';
import { config } from '../config.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { queryOne } from '../db/pool.js';
import { cachedJson, cache } from '../cache/index.js';
import type { GlobalRole, WorkspaceRole } from '@stn/shared';

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; role: GlobalRole; typ: JwtPayload['typ'] } | null;
  }
}

const ROLE_RANK: Record<GlobalRole, number> = { viewer: 1, editor: 2, admin: 3 };

/**
 * Authentication & RBAC:
 *  - Bearer access tokens (15 min HS256 JWT)
 *  - request.user populated for valid tokens; suspended/deleted users and
 *    revoked sessions are rejected via a short-TTL status cache (permission
 *    changes apply within 30s of revocation, mid-session)
 *  - requireAuth / requireRole guards; workspaceRole() for deny-by-default
 *    workspace scoping (global admins retain oversight access)
 */
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
    req.user = null;
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    const payload = verifyJwt(header.slice(7), config.jwtSecret);
    if (!payload) return;

    // Live status check (cached 30s) so suspensions/role changes bite quickly.
    const status = await cachedJson(
      `userstat:${payload.sub}`,
      30,
      async () =>
        await queryOne<{ status: string; role: GlobalRole }>(
          `SELECT status, role FROM users WHERE id = $1`,
          [payload.sub],
        ),
    );
    if (!status || status.status !== 'active') return;
    req.user = { id: payload.sub, role: status.role, typ: payload.typ };
  });
}

export async function invalidateUserStatusCache(userId: string): Promise<void> {
  await cache.del(`userstat:${userId}`);
}

export function requireAuth(req: FastifyRequest): asserts req is FastifyRequest & {
  user: { id: string; role: GlobalRole; typ: 'access' };
} {
  if (!req.user) throw unauthorized('Sign in to continue');
  if (req.user.typ !== 'access') {
    throw unauthorized('Complete multi-factor setup to continue');
  }
}

export function requireRole(req: FastifyRequest, role: GlobalRole): void {
  requireAuth(req);
  if (ROLE_RANK[req.user!.role] < ROLE_RANK[role]) {
    throw forbidden(`This action requires the ${role} role`);
  }
}

/** Deny-by-default workspace membership check. Returns the effective role. */
export async function workspaceRole(
  req: FastifyRequest,
  workspaceId: string,
  minRole: WorkspaceRole = 'viewer',
): Promise<WorkspaceRole> {
  requireAuth(req);
  if (req.user!.role === 'admin') return 'admin';
  const row = await queryOne<{ role: WorkspaceRole }>(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, req.user!.id],
  );
  if (!row) throw forbidden('You are not a member of this workspace');
  if (ROLE_RANK[row.role] < ROLE_RANK[minRole]) {
    throw forbidden(`This action requires workspace ${minRole} access`);
  }
  return row.role;
}

/** CSRF double-submit check for cookie-authenticated endpoints. */
export function requireCsrf(req: FastifyRequest, _reply: FastifyReply): void {
  const cookieToken = req.cookies?.['stn_csrf'];
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    throw forbidden('CSRF check failed — refresh the page and try again');
  }
}
