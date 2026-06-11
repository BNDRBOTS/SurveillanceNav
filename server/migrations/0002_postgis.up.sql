-- Optional PostGIS capability migration. The migration runner only applies
-- this when the postgis extension is available on the server; without it the
-- app transparently falls back to lat/lng bounding-box + haversine queries.

CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE surveillance_assets
  ADD COLUMN geo_point geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED;

CREATE INDEX assets_geo_gist ON surveillance_assets USING gist (geo_point);

ALTER TABLE jurisdictions
  ADD COLUMN geom geometry;

CREATE INDEX jurisdictions_geom_gist ON jurisdictions USING gist (geom);

-- Keep jurisdiction geometry in sync with its GeoJSON document.
CREATE OR REPLACE FUNCTION sync_jurisdiction_geom() RETURNS trigger AS $$
BEGIN
  IF NEW.geojson IS NOT NULL AND (NEW.geojson ? 'geometry' OR NEW.geojson ? 'coordinates') THEN
    BEGIN
      IF NEW.geojson ? 'geometry' THEN
        NEW.geom := ST_GeomFromGeoJSON((NEW.geojson->'geometry')::text);
      ELSE
        NEW.geom := ST_GeomFromGeoJSON(NEW.geojson::text);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NEW.geom := NULL; -- malformed geometry must never block the write
    END;
  ELSE
    NEW.geom := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jurisdictions_geom_sync
  BEFORE INSERT OR UPDATE OF geojson ON jurisdictions
  FOR EACH ROW EXECUTE FUNCTION sync_jurisdiction_geom();

UPDATE jurisdictions SET geojson = geojson WHERE geojson IS NOT NULL;
