-- Versioned acknowledgment history: which disclaimer (key) at which version a
-- user accepted, and when. Append-only — version bumps insert new rows, prior
-- acceptances remain as evidence of what was agreed to at the time.
CREATE TABLE acknowledgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  version int NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, key, version)
);
CREATE INDEX acknowledgments_user ON acknowledgments (user_id);
