import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { audit } from './audit.js';
import { invalidateUserStatusCache } from '../plugins/auth.js';

/**
 * Stripe integration via its plain REST API (no SDK — zero new
 * dependencies, same supply-chain posture as the rest of the security
 * core). Flow: Checkout Session (subscription) → signature-verified
 * webhooks flip users.plan → Billing Portal for self-service management.
 * When STRIPE_* env vars are absent every endpoint degrades to a clear
 * "not configured" state and the UI hides billing affordances.
 */

const API = 'https://api.stripe.com/v1';

async function stripeRequest<T>(path: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.stripe.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${body.error?.message ?? 'request failed'}`);
  return body;
}

async function ensureCustomer(userId: string, email: string, name: string): Promise<string> {
  const existing = await queryOne<{ stripe_customer_id: string | null }>(
    `SELECT stripe_customer_id FROM users WHERE id = $1`,
    [userId],
  );
  if (existing?.stripe_customer_id) return existing.stripe_customer_id;
  const customer = await stripeRequest<{ id: string }>('/customers', {
    email,
    name,
    'metadata[stnUserId]': userId,
  });
  await query(`UPDATE users SET stripe_customer_id = $2 WHERE id = $1`, [userId, customer.id]);
  return customer.id;
}

export async function createCheckoutSession(userId: string, email: string, name: string): Promise<string> {
  const customer = await ensureCustomer(userId, email, name);
  const session = await stripeRequest<{ url: string }>('/checkout/sessions', {
    mode: 'subscription',
    customer,
    'line_items[0][price]': config.stripe.priceIdPro,
    'line_items[0][quantity]': '1',
    client_reference_id: userId,
    success_url: `${config.publicUrl}/settings?billing=success`,
    cancel_url: `${config.publicUrl}/settings?billing=cancelled`,
    'subscription_data[metadata][stnUserId]': userId,
    allow_promotion_codes: 'true',
  });
  return session.url;
}

export async function createPortalSession(userId: string): Promise<string> {
  const row = await queryOne<{ stripe_customer_id: string | null }>(
    `SELECT stripe_customer_id FROM users WHERE id = $1`,
    [userId],
  );
  if (!row?.stripe_customer_id) throw new Error('No billing profile yet — upgrade first.');
  const session = await stripeRequest<{ url: string }>('/billing_portal/sessions', {
    customer: row.stripe_customer_id,
    return_url: `${config.publicUrl}/settings`,
  });
  return session.url;
}

/* ------------------------------ webhooks ------------------------------ */

/** Verify the Stripe-Signature header (t=...,v1=...) against the raw body. */
export function verifyStripeSignature(rawBody: Buffer, header: string, secret: string, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1)];
    }),
  ) as { t?: string; v1?: string };
  if (!parts.t || !parts.v1) return false;
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody.toString('utf8')}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      customer?: string;
      status?: string;
      client_reference_id?: string;
      subscription?: string;
      metadata?: Record<string, string>;
    };
  };
}

async function setPlanByCustomer(customerId: string, plan: 'free' | 'pro', subscriptionId: string | null): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `UPDATE users SET plan = $2, stripe_subscription_id = $3 WHERE stripe_customer_id = $1 RETURNING id`,
    [customerId, plan, subscriptionId],
  );
  if (row) await invalidateUserStatusCache(row.id);
  return row?.id ?? null;
}

/** Idempotent webhook processor. Returns what happened (for logging/tests). */
export async function processStripeEvent(event: StripeEvent): Promise<string> {
  // idempotency: first writer wins, replays no-op
  const inserted = await query(
    `INSERT INTO billing_events (id, type, payload, processed_at)
     VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [event.id, event.type, JSON.stringify(event)],
  );
  if (inserted.rowCount === 0) return 'duplicate_ignored';

  const obj = event.data.object;
  let outcome = 'ignored';

  if (event.type === 'checkout.session.completed' && obj.customer) {
    const userId = await setPlanByCustomer(obj.customer, 'pro', obj.subscription ?? null);
    outcome = userId ? `upgraded:${userId}` : 'customer_not_found';
  } else if (event.type === 'customer.subscription.updated' && obj.customer) {
    const active = obj.status === 'active' || obj.status === 'trialing' || obj.status === 'past_due';
    const userId = await setPlanByCustomer(obj.customer, active ? 'pro' : 'free', obj.id);
    outcome = userId ? `${active ? 'pro' : 'free'}:${userId}` : 'customer_not_found';
  } else if (event.type === 'customer.subscription.deleted' && obj.customer) {
    const userId = await setPlanByCustomer(obj.customer, 'free', null);
    outcome = userId ? `downgraded:${userId}` : 'customer_not_found';
  }

  await audit({
    actorId: null,
    action: `billing.${event.type}`,
    resource: 'billing',
    resourceId: event.id,
    metadata: { outcome },
  });
  return outcome;
}
