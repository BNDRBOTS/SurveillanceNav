-- De-Flock / OpenStreetMap import support.
--
-- external_ref makes imports idempotent per external feature (e.g. "osm:node/123"),
-- so the same OSM node upserts in place instead of duplicating on every refresh.
ALTER TABLE surveillance_assets ADD COLUMN external_ref text;
CREATE UNIQUE INDEX assets_external_ref ON surveillance_assets (external_ref)
  WHERE external_ref IS NOT NULL;

-- Records which map tiles were imported recently so viewport-triggered imports
-- throttle calls to the upstream Overpass API (a fresh DB starts empty and fills
-- in from real community data as people browse).
CREATE TABLE import_tiles (
  tile        text PRIMARY KEY,
  imported_at timestamptz NOT NULL DEFAULT now(),
  asset_count int NOT NULL DEFAULT 0
);
