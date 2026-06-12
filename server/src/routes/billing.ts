import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { requireAuth } from '../plugins/auth.js';
import { badRequest, forbidden, serviceUnavailable } from '../lib/errors.js';
import { queryOne } from '../db/pool.js';
import { audit } from '../services/audit.js';
import {
  createCheckoutSession,
  createPortalSession,
  processStripeEvent,
  verifyStripeSignature,
} from '../services/stripe.js';

export function registerBillingRoutes(app: FastifyInstance): void {
  /** Plan + configuration status for the Settings card. */
  app.get('/billing/status', async (req) => {
    const configured = config.stripe.configured;
    if (!req.user) return { configured, plan: 'free', authenticated: false };
    const row = await queryOne<{ plan: string; stripe_customer_id: string | null }>(
      `SELECT plan, stripe_customer_id FROM users WHERE id = $1`,
      [req.user.id],
    );
    return {
      configured,
      authenticated: true,
      plan: row?.plan ?? 'free',
      hasBillingProfile: Boolean(row?.stripe_customer_id),
    };
  });

  app.post('/billing/checkout', async (req) => {
    requireAuth(req);
    if (!config.stripe.configured) {
      throw serviceUnavailable('Payments are not configured on this deployment yet.');
    }
    const user = await queryOne<{ email: string; name: string; plan: string }>(
      `SELECT email, name, plan FROM users WHERE id = $1`,
      [req.user!.id],
    );
    if (!user) throw forbidden();
    if (user.plan === 'pro') throw badRequest('You are already a Supporter — use “Manage billing” instead.');
    try {
      const url = await createCheckoutSession(req.user!.id, user.email, user.name);
      await audit({ actorId: req.user!.id, action: 'billing.checkout_started', resource: 'billing', ip: req.ip });
      return { url };
    } catch (err) {
      req.log.error({ err }, 'stripe checkout failed');
      throw serviceUnavailable('Could not start checkout — payments provider unreachable. Try again shortly.');
    }
  });

  app.post('/billing/portal', async (req) => {
    requireAuth(req);
    if (!config.stripe.configured) {
      throw serviceUnavailable('Payments are not configured on this deployment yet.');
    }
    try {
      const url = await createPortalSession(req.user!.id);
      await audit({ actorId: req.user!.id, action: 'billing.portal_opened', resource: 'billing', ip: req.ip });
      return { url };
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  /**
   * Stripe webhook: raw-body signature verification (encapsulated scope so
   * the buffer parser never affects other routes). Always 200s on verified
   * events — processing is idempotent via billing_events.
   */
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    scope.post('/billing/webhook', async (req, reply) => {
      if (!config.stripe.webhookSecret) {
        return reply.status(503).send({
          error: { code: 'service_unavailable', message: 'Webhook secret not configured' },
        });
      }
      const signature = req.headers['stripe-signature'];
      const raw = req.body as Buffer;
      if (typeof signature !== 'string' || !Buffer.isBuffer(raw)) {
        return reply.status(400).send({ error: { code: 'bad_request', message: 'Missing signature or body' } });
      }
      if (!verifyStripeSignature(raw, signature, config.stripe.webhookSecret)) {
        return reply.status(400).send({ error: { code: 'bad_request', message: 'Invalid signature' } });
      }
      let event;
      try {
        event = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.status(400).send({ error: { code: 'bad_request', message: 'Malformed payload' } });
      }
      const outcome = await processStripeEvent(event);
      return reply.send({ received: true, outcome });
    });
  });
}
