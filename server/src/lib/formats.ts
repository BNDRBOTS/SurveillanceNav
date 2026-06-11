/** Export format generators: CSV (RFC 4180), GeoJSON, KML, JSON. */

export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return columns ? `${columns.join(',')}\r\n` : '';
  const cols = columns ?? Object.keys(rows[0]!);
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    // Defend spreadsheet consumers against formula injection
    if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
    if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [cols.join(',')];
  for (const row of rows) lines.push(cols.map((c) => escape(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export interface GeoFeatureInput {
  lng: number;
  lat: number;
  properties: Record<string, unknown>;
  id?: string;
}

export function toGeoJson(features: GeoFeatureInput[]): string {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: features.map((f) => ({
      type: 'Feature',
      id: f.id,
      geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
      properties: f.properties,
    })),
  });
}

const xmlEscape = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export function toKml(features: GeoFeatureInput[], docName = 'STN Export'): string {
  const placemarks = features
    .map((f) => {
      const name = xmlEscape(String(f.properties.name ?? f.id ?? 'Asset'));
      const desc = xmlEscape(
        Object.entries(f.properties)
          .filter(([k]) => k !== 'name')
          .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')}`)
          .join('\n'),
      );
      return `    <Placemark><name>${name}</name><description>${desc}</description><Point><coordinates>${f.lng},${f.lat},0</coordinates></Point></Placemark>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xmlEscape(docName)}</name>
${placemarks}
  </Document>
</kml>
`;
}
