-- Live statute store: public-records law per jurisdiction, versioned with a
-- human review pipeline. Seeded at boot from the shared code constants
-- (ensureStatutesSeeded); the statute_recheck job refetches source_url pages
-- and files change PROPOSALS (review_status='needs_review') — publication
-- happens only through the admin approve endpoint. Keeping statute data
-- current requires no code changes.
CREATE TABLE statutes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_key text NOT NULL,               -- 'CA', 'US', 'PR', ...
  state text NOT NULL,
  law_name text NOT NULL,
  citation text NOT NULL,
  response_days int,
  business_days boolean NOT NULL DEFAULT true,
  notes text,
  source_url text,
  source_hash text,                             -- sha256 of last fetched source content
  version int NOT NULL DEFAULT 1,
  review_status text NOT NULL DEFAULT 'approved'
    CHECK (review_status IN ('approved', 'needs_review', 'rejected')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  checked_at timestamptz,
  checked_by text,                              -- 'seed' | 'job:fetch' | 'job:llm' | 'admin'
  proposed_changes jsonb,
  source_excerpt text,
  llm_model text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- exactly one live row per jurisdiction
CREATE UNIQUE INDEX statutes_active ON statutes (jurisdiction_key)
  WHERE review_status = 'approved' AND superseded_at IS NULL;
CREATE INDEX statutes_review ON statutes (created_at) WHERE review_status = 'needs_review';
