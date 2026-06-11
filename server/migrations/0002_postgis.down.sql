DROP TRIGGER IF EXISTS jurisdictions_geom_sync ON jurisdictions;
DROP FUNCTION IF EXISTS sync_jurisdiction_geom();
DROP INDEX IF EXISTS jurisdictions_geom_gist;
ALTER TABLE jurisdictions DROP COLUMN IF EXISTS geom;
DROP INDEX IF EXISTS assets_geo_gist;
ALTER TABLE surveillance_assets DROP COLUMN IF EXISTS geo_point;
