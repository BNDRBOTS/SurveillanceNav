-- One-time account recovery codes (scrypt-hashed; shown to the user exactly
-- once at generation) and a throttle table for "no account under this
-- address" notice emails so unknown-address lookups can't be weaponized
-- into a mail cannon.
CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);
CREATE INDEX recovery_codes_unused ON recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE reset_email_notices (
  email_hash text PRIMARY KEY,
  last_sent_at timestamptz NOT NULL DEFAULT now()
);
