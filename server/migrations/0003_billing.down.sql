DROP TABLE IF EXISTS billing_events;
DROP INDEX IF EXISTS users_stripe_customer;
ALTER TABLE users DROP COLUMN IF EXISTS stripe_subscription_id;
ALTER TABLE users DROP COLUMN IF EXISTS stripe_customer_id;
ALTER TABLE users DROP COLUMN IF EXISTS plan;
