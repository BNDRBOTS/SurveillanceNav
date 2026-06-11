-- STN initial schema. Requires PostgreSQL 14+. PostGIS is added in 0002
-- (optional capability — the app degrades to lat/lng haversine queries
-- when the extension is unavailable).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------- utility

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  -- Retention jobs may prune append-only tables only after explicitly
  -- setting this transaction-local GUC (and archiving rows first).
  IF TG_OP = 'DELETE' AND current_setting('stn.allow_audit_prune', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows are append-only (operation % blocked)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- identity

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer','editor','admin')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','suspended','deleted')),
  password_hash text NOT NULL,
  mfa_enabled   boolean NOT NULL DEFAULT false,
  mfa_secret    text,
  consent_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  failed_login_attempts int NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  deleted_at    timestamptz
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  replaced_by uuid,
  ip          text,
  user_agent  text
);
CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id, expires_at);

CREATE TABLE password_resets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- workspaces

CREATE TABLE workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  owner_id   uuid NOT NULL REFERENCES users(id),
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TRIGGER workspaces_updated BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer','editor','admin')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members (user_id);

CREATE TABLE workspace_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        text NOT NULL,
  role         text NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer','editor','admin')),
  token_hash   text NOT NULL UNIQUE,
  created_by   uuid NOT NULL REFERENCES users(id),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_invites_ws ON workspace_invites (workspace_id);

-- ---------------------------------------------------------------- reference data

CREATE TABLE jurisdictions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  type       text NOT NULL CHECK (type IN ('country','state','county','city','agency')),
  parent_id  uuid REFERENCES jurisdictions(id) ON DELETE SET NULL,
  geojson    jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jurisdictions_name_type ON jurisdictions (lower(name), type);
CREATE INDEX jurisdictions_parent ON jurisdictions (parent_id);
CREATE INDEX jurisdictions_name_trgm ON jurisdictions USING gin (name gin_trgm_ops);
CREATE TRIGGER jurisdictions_updated BEFORE UPDATE ON jurisdictions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sources (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  type                text NOT NULL CHECK (type IN ('government','ngo','academic','community','media')),
  url                 text,
  contact             text,
  verification_status text NOT NULL DEFAULT 'unverified'
                      CHECK (verification_status IN ('unverified','pending','verified','rejected')),
  last_verified_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sources_name_unique ON sources (lower(name));
CREATE TRIGGER sources_updated BEFORE UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- assets

CREATE TABLE surveillance_assets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  jurisdiction_id  uuid REFERENCES jurisdictions(id) ON DELETE SET NULL,
  source_id        uuid REFERENCES sources(id) ON DELETE SET NULL,
  technology_type  text NOT NULL CHECK (technology_type IN
    ('lpr','cctv','facial_recognition','drone','gunshot_detection','cell_site_simulator',
     'body_worn_camera','sensor','predictive_policing','other')),
  vendor           text,
  status           text NOT NULL DEFAULT 'unverified'
                   CHECK (status IN ('proposed','active','retired','removed','unverified')),
  deployment_date  date,
  retirement_date  date,
  confidence_score int NOT NULL DEFAULT 20 CHECK (confidence_score BETWEEN 0 AND 100),
  confidence_factors jsonb NOT NULL DEFAULT '[]'::jsonb,
  lng              double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  lat              double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  properties       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  last_verified_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  fts tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(name,'') || ' ' || coalesce(vendor,''))
  ) STORED
);
CREATE INDEX assets_jurisdiction ON surveillance_assets (jurisdiction_id) WHERE deleted_at IS NULL;
CREATE INDEX assets_tech ON surveillance_assets (technology_type) WHERE deleted_at IS NULL;
CREATE INDEX assets_vendor ON surveillance_assets (vendor) WHERE deleted_at IS NULL;
CREATE INDEX assets_status ON surveillance_assets (status) WHERE deleted_at IS NULL;
CREATE INDEX assets_deploy_date ON surveillance_assets (deployment_date) WHERE deleted_at IS NULL;
CREATE INDEX assets_confidence ON surveillance_assets (confidence_score) WHERE deleted_at IS NULL;
CREATE INDEX assets_latlng ON surveillance_assets (lat, lng) WHERE deleted_at IS NULL;
CREATE INDEX assets_fts ON surveillance_assets USING gin (fts);
CREATE INDEX assets_props ON surveillance_assets USING gin (properties jsonb_path_ops);
CREATE TRIGGER assets_updated BEFORE UPDATE ON surveillance_assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Corroborating sources beyond the primary (many-to-many).
CREATE TABLE asset_sources (
  asset_id  uuid NOT NULL REFERENCES surveillance_assets(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, source_id)
);

CREATE TABLE asset_evidence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    uuid NOT NULL REFERENCES surveillance_assets(id) ON DELETE CASCADE,
  file_key    text NOT NULL,
  file_name   text NOT NULL,
  file_type   text NOT NULL,
  size_bytes  bigint NOT NULL DEFAULT 0,
  scan_status text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','quarantined')),
  pii_status  text NOT NULL DEFAULT 'pending' CHECK (pii_status IN ('pending','clean','flagged')),
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_evidence_asset ON asset_evidence (asset_id);
CREATE INDEX asset_evidence_pending ON asset_evidence (scan_status) WHERE scan_status = 'pending';

-- Immutable change history (diff per change).
CREATE TABLE asset_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id   uuid NOT NULL,
  user_id    uuid,
  action     text NOT NULL,
  diff       jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_history_asset ON asset_history (asset_id, created_at DESC);
CREATE TRIGGER asset_history_append_only
  BEFORE UPDATE OR DELETE ON asset_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    uuid NOT NULL REFERENCES surveillance_assets(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  reason      text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  admin_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX flags_open ON flags (status, created_at) WHERE status = 'open';

CREATE TABLE disputes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     uuid NOT NULL REFERENCES surveillance_assets(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  reason       text NOT NULL,
  evidence     text NOT NULL,
  evidence_url text,
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','under_review','accepted','rejected','withdrawn')),
  resolution   text,
  admin_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX disputes_asset ON disputes (asset_id);
CREATE INDEX disputes_open ON disputes (status, created_at) WHERE status IN ('open','under_review');
CREATE TRIGGER disputes_updated BEFORE UPDATE ON disputes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE merge_candidates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_a     uuid NOT NULL REFERENCES surveillance_assets(id) ON DELETE CASCADE,
  asset_b     uuid NOT NULL REFERENCES surveillance_assets(id) ON DELETE CASCADE,
  score       real NOT NULL,
  reasons     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','merged','dismissed')),
  admin_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (asset_a, asset_b)
);

-- ---------------------------------------------------------------- FOIA

CREATE TABLE foia_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  technology text,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE foia_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  jurisdiction_id uuid REFERENCES jurisdictions(id) ON DELETE SET NULL,
  created_by      uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','sent','acknowledged','response','appeal','closed')),
  outcome         text CHECK (outcome IN ('fulfilled','partial','denied','withdrawn')),
  subject         text NOT NULL,
  body            text NOT NULL,
  foia_number     text,
  sent_at         timestamptz,
  due_at          timestamptz,
  reminded_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX foia_ws ON foia_requests (workspace_id, status) WHERE deleted_at IS NULL;
CREATE INDEX foia_due ON foia_requests (due_at) WHERE deleted_at IS NULL AND status IN ('sent','acknowledged');
CREATE TRIGGER foia_updated BEFORE UPDATE ON foia_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE foia_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES foia_requests(id) ON DELETE CASCADE,
  file_key    text NOT NULL,
  file_name   text NOT NULL,
  file_type   text NOT NULL,
  size_bytes  bigint NOT NULL DEFAULT 0,
  redactions  jsonb,
  scan_status text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','quarantined')),
  pii_status  text NOT NULL DEFAULT 'pending' CHECK (pii_status IN ('pending','clean','flagged')),
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX foia_documents_req ON foia_documents (request_id);

-- ---------------------------------------------------------------- procurement & policy

CREATE TABLE procurements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id  uuid REFERENCES jurisdictions(id) ON DELETE SET NULL,
  vendor           text,
  title            text NOT NULL,
  amount           numeric(14,2),
  currency         text NOT NULL DEFAULT 'USD',
  start_date       date,
  end_date         date,
  technology_terms text[] NOT NULL DEFAULT '{}',
  confidence_score int NOT NULL DEFAULT 20 CHECK (confidence_score BETWEEN 0 AND 100),
  raw_file_key     text,
  raw_text_excerpt text,
  normalized       jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_status    text NOT NULL DEFAULT 'needs_review'
                   CHECK (review_status IN ('needs_review','approved','rejected')),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  fts tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(vendor,''))
  ) STORED
);
CREATE INDEX procurements_jur ON procurements (jurisdiction_id) WHERE deleted_at IS NULL;
CREATE INDEX procurements_vendor ON procurements (vendor) WHERE deleted_at IS NULL;
CREATE INDEX procurements_fts ON procurements USING gin (fts);
CREATE TRIGGER procurements_updated BEFORE UPDATE ON procurements FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id uuid NOT NULL REFERENCES jurisdictions(id) ON DELETE CASCADE,
  title           text NOT NULL,
  effective_date  date NOT NULL,
  source_url      text,
  content         text NOT NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  fts tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))
  ) STORED
);
CREATE INDEX policies_jur ON policies (jurisdiction_id, effective_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX policies_fts ON policies USING gin (fts);
CREATE TRIGGER policies_updated BEFORE UPDATE ON policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- exports & ops

CREATE TABLE exports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  format       text NOT NULL CHECK (format IN ('csv','geojson','json','kml','pdf','html')),
  resource     text NOT NULL,
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,
  file_key     text,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','processing','completed','failed','expired')),
  error        text,
  row_count    int,
  truncated    boolean NOT NULL DEFAULT false,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX exports_user ON exports (user_id, created_at DESC);
CREATE INDEX exports_expiry ON exports (expires_at) WHERE status = 'completed';

CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid,
  action      text NOT NULL,
  resource    text NOT NULL,
  resource_id text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_action ON audit_logs (action, created_at DESC);
CREATE INDEX audit_logs_created ON audit_logs (created_at);
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','completed','failed','cancelled')),
  priority     int NOT NULL DEFAULT 5,
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  last_error   text,
  result       jsonb,
  locked_by    text,
  locked_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX jobs_ready ON jobs (status, run_at, priority) WHERE status = 'queued';
CREATE INDEX jobs_type ON jobs (type, created_at DESC);
CREATE TRIGGER jobs_updated BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE job_schedules (
  name          text PRIMARY KEY,
  description   text NOT NULL DEFAULT '',
  interval_sec  int NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  last_run_at   timestamptz,
  next_run_at   timestamptz NOT NULL DEFAULT now(),
  last_status   text,
  last_duration_ms int,
  last_error    text
);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asset_id     uuid NOT NULL REFERENCES surveillance_assets(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body         text NOT NULL,
  mentions     uuid[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX comments_asset ON comments (asset_id, created_at);
CREATE TRIGGER comments_updated BEFORE UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE layer_presets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  config       jsonb NOT NULL,
  share_token  text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER layer_presets_updated BEFORE UPDATE ON layer_presets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE TABLE idempotency_keys (
  key         text NOT NULL,
  user_id     uuid NOT NULL,
  method      text NOT NULL,
  path        text NOT NULL,
  status_code int,
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, user_id)
);
CREATE INDEX idempotency_created ON idempotency_keys (created_at);

-- Hour-bucketed request metrics for the admin monitoring console.
CREATE TABLE request_metrics (
  bucket    timestamptz NOT NULL,
  route     text NOT NULL,
  count     bigint NOT NULL DEFAULT 0,
  errors    bigint NOT NULL DEFAULT 0,
  total_ms  bigint NOT NULL DEFAULT 0,
  max_ms    int NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, route)
);
