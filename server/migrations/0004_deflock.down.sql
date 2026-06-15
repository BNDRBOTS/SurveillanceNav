DROP TABLE IF EXISTS import_tiles;
-- Dropping the column also drops assets_external_ref.
ALTER TABLE surveillance_assets DROP COLUMN IF EXISTS external_ref;
