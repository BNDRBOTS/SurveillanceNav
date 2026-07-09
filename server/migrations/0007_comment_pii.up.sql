-- PII kinds detected in a comment at submission time (author confirmed
-- posting anyway). Lets curators find and review text-borne PII the same
-- way they review flagged files.
ALTER TABLE comments ADD COLUMN pii_kinds text[] NOT NULL DEFAULT '{}';
