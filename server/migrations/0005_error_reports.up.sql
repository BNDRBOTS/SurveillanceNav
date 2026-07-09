-- Error reports: anonymous forensic diagnostics submitted from the client
-- (map fallback failures, statute corrections, content issues). Deliberately
-- carries no user_id / IP columns — the payload is technical, not personal.
CREATE TABLE error_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('map_style', 'map_tiles', 'statute', 'content', 'client_error')),
  message text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  app_version text,
  user_agent text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'resolved', 'dismissed')),
  admin_id uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX error_reports_new ON error_reports (created_at) WHERE status = 'new';
