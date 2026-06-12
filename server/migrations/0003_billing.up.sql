-- Billing (Stripe) support: user plan + idempotent webhook event log.
ALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro'));
ALTER TABLE users ADD COLUMN stripe_customer_id text;
ALTER TABLE users ADD COLUMN stripe_subscription_id text;
CREATE UNIQUE INDEX users_stripe_customer ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE billing_events (
  id           text PRIMARY KEY,          -- Stripe event id (idempotency)
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  processed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
