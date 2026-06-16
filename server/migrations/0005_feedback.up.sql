-- In-app feedback submissions — stored in DB, visible in admin console.
CREATE TABLE feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  category    text NOT NULL CHECK (category IN ('bug', 'suggestion', 'correction', 'other')),
  subject     text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 120),
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  page_url    text,
  user_agent  text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'resolved', 'wont_fix')),
  admin_note  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX feedback_created ON feedback (created_at DESC);
CREATE INDEX feedback_status  ON feedback (status);
CREATE INDEX feedback_user    ON feedback (user_id) WHERE user_id IS NOT NULL;
