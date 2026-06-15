import path from 'node:path';
import pg from 'pg';
import { config } from '../config.js';
import { hashPassword } from '../auth/crypto.js';
import { FOIA_STATUTES, computeConfidence, type SourceType, type VerificationStatus } from '@stn/shared';

/**
 * Seed: anonymized, deterministic sample data (PRNG-generated points — NOT
 * real camera locations) plus real reference data (state statutes, real
 * municipal surveillance ordinances as policy-timeline examples).
 *
 *   SEED_SCALE=demo (default ~1.5k assets) | perf (~100k assets)
 *   SEED_DEMO_USERS=true|false (default true outside production)
 */

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(0x57_4e_31); // "STN1"
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

const CITIES: Array<{ name: string; state: string; lng: number; lat: number; weight: number }> = [
  { name: 'San Francisco', state: 'California', lng: -122.4194, lat: 37.7749, weight: 1.4 },
  { name: 'Oakland', state: 'California', lng: -122.2712, lat: 37.8044, weight: 1.0 },
  { name: 'Los Angeles', state: 'California', lng: -118.2437, lat: 34.0522, weight: 1.8 },
  { name: 'San Diego', state: 'California', lng: -117.1611, lat: 32.7157, weight: 1.1 },
  { name: 'New York City', state: 'New York', lng: -73.9857, lat: 40.7484, weight: 2.0 },
  { name: 'Chicago', state: 'Illinois', lng: -87.6298, lat: 41.8781, weight: 1.7 },
  { name: 'Houston', state: 'Texas', lng: -95.3698, lat: 29.7604, weight: 1.3 },
  { name: 'Phoenix', state: 'Arizona', lng: -112.074, lat: 33.4484, weight: 1.0 },
  { name: 'Philadelphia', state: 'Pennsylvania', lng: -75.1652, lat: 39.9526, weight: 1.1 },
  { name: 'Seattle', state: 'Washington', lng: -122.3321, lat: 47.6062, weight: 1.2 },
  { name: 'Denver', state: 'Colorado', lng: -104.9903, lat: 39.7392, weight: 0.9 },
  { name: 'Atlanta', state: 'Georgia', lng: -84.388, lat: 33.749, weight: 1.2 },
  { name: 'Boston', state: 'Massachusetts', lng: -71.0589, lat: 42.3601, weight: 0.9 },
  { name: 'Detroit', state: 'Michigan', lng: -83.0458, lat: 42.3314, weight: 1.0 },
  { name: 'Miami', state: 'Florida', lng: -80.1918, lat: 25.7617, weight: 0.9 },
  { name: 'Austin', state: 'Texas', lng: -97.7431, lat: 30.2672, weight: 0.8 },
  { name: 'Portland', state: 'Oregon', lng: -122.6765, lat: 45.5231, weight: 0.8 },
  { name: 'Minneapolis', state: 'Minnesota', lng: -93.265, lat: 44.9778, weight: 0.8 },
  { name: 'New Orleans', state: 'Louisiana', lng: -90.0715, lat: 29.9511, weight: 0.7 },
  { name: 'Baltimore', state: 'Maryland', lng: -76.6122, lat: 39.2904, weight: 0.9 },
];

const TECH_PROFILE: Array<{
  tech: string;
  vendors: string[];
  share: number;
  namePrefix: string;
}> = [
  { tech: 'lpr', vendors: ['Flock Safety', 'Motorola Solutions', 'Vigilant Solutions'], share: 0.32, namePrefix: 'ALPR' },
  { tech: 'cctv', vendors: ['Avigilon', 'Verkada', 'Genetec', 'Hikvision'], share: 0.3, namePrefix: 'Camera' },
  { tech: 'gunshot_detection', vendors: ['SoundThinking', 'ShotSpotter'], share: 0.08, namePrefix: 'Acoustic sensor' },
  { tech: 'facial_recognition', vendors: ['Clearview AI', 'NEC', 'Idemia'], share: 0.07, namePrefix: 'FR system' },
  { tech: 'drone', vendors: ['Skydio', 'DJI', 'Axon'], share: 0.07, namePrefix: 'UAS unit' },
  { tech: 'body_worn_camera', vendors: ['Axon', 'Motorola Solutions'], share: 0.06, namePrefix: 'BWC program' },
  { tech: 'sensor', vendors: ['Fusus', 'Genetec'], share: 0.05, namePrefix: 'Sensor node' },
  { tech: 'cell_site_simulator', vendors: ['L3Harris', 'Harris Corporation'], share: 0.02, namePrefix: 'CSS deployment' },
  { tech: 'predictive_policing', vendors: ['Geolitica', 'PredPol', 'Palantir'], share: 0.02, namePrefix: 'Analytics platform' },
  { tech: 'other', vendors: ['Dataminr', 'BriefCam'], share: 0.01, namePrefix: 'System' },
];

const SOURCES: Array<{ name: string; type: SourceType; url: string; verification: VerificationStatus }> = [
  { name: 'EFF Atlas of Surveillance', type: 'ngo', url: 'https://atlasofsurveillance.org', verification: 'verified' },
  { name: 'DeFlock Community Reports', type: 'community', url: 'https://deflock.me', verification: 'pending' },
  { name: 'Municipal Procurement Records', type: 'government', url: 'https://www.usaspending.gov', verification: 'verified' },
  { name: 'ACLU Documents Archive', type: 'ngo', url: 'https://www.aclu.org', verification: 'verified' },
  { name: 'MuckRock FOIA Responses', type: 'media', url: 'https://www.muckrock.com', verification: 'verified' },
  { name: 'University Privacy Lab Field Survey', type: 'academic', url: 'https://citizenlab.ca', verification: 'pending' },
  { name: 'Community Field Reports (unreviewed)', type: 'community', url: 'https://example-community.org', verification: 'unverified' },
];

/** Real municipal surveillance-governance milestones for the policy timeline. */
const POLICIES: Array<{ city: string; title: string; date: string; url: string; content: string }> = [
  {
    city: 'San Francisco',
    title: 'Acquisition of Surveillance Technology Ordinance (facial recognition ban)',
    date: '2019-07-01',
    url: 'https://sfgov.legistar.com/View.ashx?M=F&ID=7206781&GUID=38D37061-4D87-4A94-9AB3-CB113656159A',
    content:
      'San Francisco became the first major U.S. city to ban government use of facial recognition technology. The ordinance (Admin Code §19B) also requires Board approval before any city department acquires surveillance technology, an annual surveillance report, and a published surveillance technology policy for each approved system.',
  },
  {
    city: 'Oakland',
    title: 'Surveillance and Community Safety Ordinance',
    date: '2018-05-15',
    url: 'https://library.municode.com/ca/oakland/codes/code_of_ordinances?nodeId=TIT9PUPEMOWE_CH9.64REACUSSUTE',
    content:
      'Oakland Municipal Code 9.64 requires Privacy Advisory Commission review and City Council approval, with a Surveillance Impact Report and Use Policy, before any city entity acquires or uses surveillance technology. It mandates annual reports detailing usage, complaints, and audit results.',
  },
  {
    city: 'Seattle',
    title: 'Surveillance Ordinance (SMC 14.18)',
    date: '2017-09-01',
    url: 'https://www.seattle.gov/tech/initiatives/privacy/surveillance-technologies',
    content:
      'Seattle Municipal Code 14.18 requires Council approval and a Surveillance Impact Report for surveillance technologies, maintains a public master list of approved technologies, and mandates equity analysis and community engagement during review.',
  },
  {
    city: 'New York City',
    title: 'Public Oversight of Surveillance Technology (POST) Act',
    date: '2020-07-15',
    url: 'https://legistar.council.nyc.gov/LegislationDetail.aspx?ID=3343878&GUID=996ABB2A-9F4C-4A32-B081-D6F24AB954A0',
    content:
      'The POST Act requires the NYPD to publish impact and use policies for each surveillance technology it deploys, covering capabilities, rules, data retention, access controls, and external entity access, with oversight by the Inspector General.',
  },
  {
    city: 'Boston',
    title: 'Face Surveillance Ban Ordinance',
    date: '2020-06-24',
    url: 'https://www.boston.gov/news/boston-city-council-votes-ban-face-surveillance-technology',
    content:
      'Boston banned city use of face surveillance systems and prohibited entering agreements to obtain face surveillance from third parties, citing accuracy disparities and civil liberties risks.',
  },
  {
    city: 'Baltimore',
    title: 'Facial Recognition Moratorium (Council Bill 21-0001)',
    date: '2021-08-09',
    url: 'https://baltimore.legistar.com/LegislationDetail.aspx?ID=4749282&GUID=2KEY0B2C',
    content:
      'Baltimore enacted a moratorium prohibiting persons and city agencies from obtaining or using face surveillance technology (with limited exceptions), one of the broadest municipal restrictions at the time.',
  },
  {
    city: 'Portland',
    title: 'Face Recognition Ban (public and private)',
    date: '2021-01-01',
    url: 'https://www.portland.gov/smart-city-pdx/face-recognition-ban',
    content:
      'Portland, Oregon banned facial recognition use by city bureaus and, uniquely, by private entities in places of public accommodation, the strictest municipal FR regulation in the U.S. at adoption.',
  },
  {
    city: 'Detroit',
    title: 'Project Green Light & FR Use Policy revisions',
    date: '2019-09-19',
    url: 'https://detroitmi.gov/departments/police-department/project-green-light-detroit',
    content:
      'Following public hearings, the Detroit Board of Police Commissioners approved a revised facial recognition policy restricting use to violent-crime still-photo investigations with multi-level review, after criticism of the Project Green Light camera network.',
  },
];

const FOIA_TEMPLATES: Array<{ name: string; technology: string | null; body: string }> = [
  {
    name: 'License plate reader deployments',
    technology: 'lpr',
    body: `{{TODAY}}

Public Records Officer
{{JURISDICTION}}

Re: Public records request — automated license plate reader (ALPR) systems

To the Records Officer:

Pursuant to {{LAW_NAME}} {{CITATION}}, I request copies of the following records created or maintained since {{SINCE_DATE}}:

1. Contracts, purchase orders, invoices, and grant documents for automated license plate reader (ALPR) hardware, software, or data services (including but not limited to Flock Safety, Motorola Solutions/Vigilant, and Genetec);
2. Policies, procedures, or general orders governing ALPR use, data retention, sharing, and audits;
3. The current count and locations (or location descriptions) of fixed ALPR cameras, and the number of mobile ALPR units in service;
4. Data-sharing agreements with other agencies or private entities concerning ALPR data, including hot-list sources;
5. Annual or periodic audit reports of ALPR queries.

{{DEADLINE_SENTENCE}}

I request records in electronic format where available. If any portion is withheld, please cite the specific exemption and release all segregable portions. As this request concerns government transparency and is not for commercial use, I ask that fees be waived; if fees exceed $25, please contact me before proceeding.

Sincerely,
{{REQUESTER_NAME}}
{{ORGANIZATION}}
{{EMAIL}}`,
  },
  {
    name: 'Facial recognition technology use',
    technology: 'facial_recognition',
    body: `{{TODAY}}

Public Records Officer
{{JURISDICTION}}

Re: Public records request — facial recognition technology

To the Records Officer:

Pursuant to {{LAW_NAME}} {{CITATION}}, I request the following records from {{SINCE_DATE}} to the present:

1. Contracts, licenses, trial agreements, or invoices with facial recognition vendors (including Clearview AI, NEC, Idemia, Rank One, or DataWorks Plus);
2. Policies or procedures governing facial recognition searches, including who may run searches and required approvals;
3. Aggregate statistics on facial recognition searches performed (number of searches, by year);
4. Records of audits, accuracy assessments, or misidentification incidents;
5. Communications with vendors regarding capabilities, accuracy, or demographic performance.

{{DEADLINE_SENTENCE}}

Please provide records electronically. If any portion is withheld, cite the specific exemption and release segregable portions. I request a fee waiver as this request serves the public interest in government oversight.

Sincerely,
{{REQUESTER_NAME}}
{{ORGANIZATION}}
{{EMAIL}}`,
  },
  {
    name: 'Drone / UAS program records',
    technology: 'drone',
    body: `{{TODAY}}

Public Records Officer
{{JURISDICTION}}

Re: Public records request — unmanned aircraft systems (UAS/drones)

To the Records Officer:

Pursuant to {{LAW_NAME}} {{CITATION}}, I request the following records since {{SINCE_DATE}}:

1. An inventory of UAS owned, leased, or operated (make, model, sensor payloads);
2. Purchase records, grants (including UASI/Homeland Security funding), and maintenance contracts;
3. Policies governing UAS deployment, including warrant requirements, retention of footage, and "drone as first responder" programs;
4. Flight logs or aggregate deployment statistics by year and purpose category;
5. FAA certificates of authorization or waivers.

{{DEADLINE_SENTENCE}}

Electronic copies preferred. Cite specific exemptions for any withholding and release segregable portions. Fee waiver requested — this is a non-commercial public-interest request.

Sincerely,
{{REQUESTER_NAME}}
{{ORGANIZATION}}
{{EMAIL}}`,
  },
  {
    name: 'Camera network / CCTV registry',
    technology: 'cctv',
    body: `{{TODAY}}

Public Records Officer
{{JURISDICTION}}

Re: Public records request — government camera networks and registries

To the Records Officer:

Pursuant to {{LAW_NAME}} {{CITATION}}, I request the following records since {{SINCE_DATE}}:

1. The count and locations (or descriptions) of government-operated video surveillance cameras, including real-time crime center feeds;
2. Contracts for camera hardware, video management software, or analytics (including Fusus, Avigilon, Verkada, Genetec, BriefCam);
3. Private camera registry program documents, including counts of registered/integrated private cameras and terms of access;
4. Retention schedules and access policies for recorded video;
5. Any video analytics capabilities in use (object detection, person search, anomaly detection).

{{DEADLINE_SENTENCE}}

Electronic format preferred; cite exemptions specifically; segregable portions should be released. Fee waiver requested.

Sincerely,
{{REQUESTER_NAME}}
{{ORGANIZATION}}
{{EMAIL}}`,
  },
  {
    name: 'Surveillance vendor contracts (all technologies)',
    technology: null,
    body: `{{TODAY}}

Public Records Officer
{{JURISDICTION}}

Re: Public records request — surveillance technology contracts and procurement

To the Records Officer:

Pursuant to {{LAW_NAME}} {{CITATION}}, I request, for the period {{SINCE_DATE}} to present:

1. All contracts, amendments, purchase orders, and invoices for surveillance technology, including: license plate readers; video surveillance and analytics; facial recognition; gunshot detection; cell-site simulators; social media monitoring; predictive policing; and drone systems;
2. RFPs, RFQs, sole-source justifications, and winning proposals for the above;
3. Grant applications and awards (federal or state) funding any of the above;
4. Surveillance impact reports or use policies prepared for any of the above.

{{DEADLINE_SENTENCE}}

Please provide responsive records electronically. If anything is withheld, cite the exemption and release segregable portions. Fee waiver requested as the request serves public oversight of government.

Sincerely,
{{REQUESTER_NAME}}
{{ORGANIZATION}}
{{EMAIL}}`,
  },
  {
    name: 'Gunshot detection system records',
    technology: 'gunshot_detection',
    body: `{{TODAY}}

Public Records Officer
{{JURISDICTION}}

Re: Public records request — acoustic gunshot detection systems

To the Records Officer:

Pursuant to {{LAW_NAME}} {{CITATION}}, I request the following records since {{SINCE_DATE}}:

1. Contracts and invoices with gunshot detection vendors (including SoundThinking/ShotSpotter, Flock Safety Raven);
2. Coverage-area maps or descriptions of sensor deployment zones;
3. Aggregate alert statistics: alerts published, alerts resulting in evidence of gunfire, and false-alert assessments;
4. Policies governing response to alerts and retention of audio;
5. Any internal evaluations of system accuracy or efficacy.

{{DEADLINE_SENTENCE}}

Electronic copies preferred. Cite exemptions specifically; release segregable portions. Fee waiver requested.

Sincerely,
{{REQUESTER_NAME}}
{{ORGANIZATION}}
{{EMAIL}}`,
  },
];

/**
 * Real reference data: jurisdictions (country/state/city), the source registry,
 * FOIA request templates, and real municipal surveillance ordinances for the
 * policy timeline — NOT sample/demo records. Idempotent upserts. Run both by the
 * dev seed (`main` below) and automatically on first boot of an empty database
 * (see server/src/index.ts), so a fresh production deploy is never blank.
 * Returns the jurisdiction/source id maps the demo asset generator reuses.
 */
export async function seedReference(
  client: pg.ClientBase,
  log: (msg: string) => void = () => {},
): Promise<{
  usId: string;
  stateIds: Map<string, string>;
  cityIds: Map<string, string>;
  sourceIds: Array<{ id: string; type: SourceType; verification: VerificationStatus }>;
}> {
  /* ---------------- jurisdictions ---------------- */
  const { rows: usRows } = await client.query(
    `INSERT INTO jurisdictions (name, type) VALUES ('United States', 'country')
     ON CONFLICT (lower(name), type) DO UPDATE SET updated_at = now() RETURNING id`,
  );
  const usId = (usRows[0] as { id: string }).id;

  const stateIds = new Map<string, string>();
  for (const s of FOIA_STATUTES) {
    if (s.abbr === 'DC') continue;
    const { rows } = await client.query(
      `INSERT INTO jurisdictions (name, type, parent_id) VALUES ($1, 'state', $2)
       ON CONFLICT (lower(name), type) DO UPDATE SET parent_id = EXCLUDED.parent_id RETURNING id`,
      [s.state, usId],
    );
    stateIds.set(s.state, (rows[0] as { id: string }).id);
  }
  log(`jurisdictions: 1 country + ${stateIds.size} states`);

  const cityIds = new Map<string, string>();
  for (const c of CITIES) {
    const geojson = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      properties: { name: c.name },
    };
    const { rows } = await client.query(
      `INSERT INTO jurisdictions (name, type, parent_id, geojson) VALUES ($1, 'city', $2, $3)
       ON CONFLICT (lower(name), type) DO UPDATE SET geojson = EXCLUDED.geojson RETURNING id`,
      [c.name, stateIds.get(c.state) ?? null, JSON.stringify(geojson)],
    );
    cityIds.set(c.name, (rows[0] as { id: string }).id);
  }
  log(`jurisdictions: ${cityIds.size} cities`);

  /* ---------------- sources ---------------- */
  const sourceIds: Array<{ id: string; type: SourceType; verification: VerificationStatus }> = [];
  for (const s of SOURCES) {
    const { rows } = await client.query(
      `INSERT INTO sources (name, type, url, verification_status, last_verified_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'verified' THEN now() - interval '20 days' ELSE NULL END)
       ON CONFLICT (lower(name)) DO UPDATE SET verification_status = EXCLUDED.verification_status RETURNING id`,
      [s.name, s.type, s.url, s.verification],
    );
    sourceIds.push({ id: (rows[0] as { id: string }).id, type: s.type, verification: s.verification });
  }
  log(`sources: ${sourceIds.length}`);

  /* ---------------- FOIA templates ---------------- */
  for (const t of FOIA_TEMPLATES) {
    await client.query(
      `INSERT INTO foia_templates (name, technology, body) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET body = EXCLUDED.body, technology = EXCLUDED.technology`,
      [t.name, t.technology, t.body],
    );
  }
  log(`foia templates: ${FOIA_TEMPLATES.length}`);

  /* ---------------- policies ---------------- */
  for (const p of POLICIES) {
    const jId = cityIds.get(p.city);
    if (!jId) continue;
    await client.query(
      `INSERT INTO policies (jurisdiction_id, title, effective_date, source_url, content)
       SELECT $1, $2, $3, $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM policies WHERE jurisdiction_id = $1 AND title = $2)`,
      [jId, p.title, p.date, p.url, p.content],
    );
  }
  log(`policies: ${POLICIES.length}`);

  return { usId, stateIds, cityIds, sourceIds };
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  const log = (m: string) => process.stdout.write(`[seed] ${m}\n`);

  try {
    const existing = await client.query(`SELECT count(*)::int AS n FROM jurisdictions`);
    const alreadySeeded = (existing.rows[0] as { n: number }).n > 0;
    if (alreadySeeded && process.env.SEED_FORCE !== 'true') {
      log('Database already seeded — set SEED_FORCE=true to re-run (idempotent upserts).');
    }

    const { cityIds, sourceIds } = await seedReference(client, log);

    /* ---------------- assets ---------------- */
    const scale = process.env.SEED_SCALE === 'perf' ? 70 : 1;
    const assetCount = await client.query(`SELECT count(*)::int AS n FROM surveillance_assets`);
    if ((assetCount.rows[0] as { n: number }).n > 0 && process.env.SEED_FORCE !== 'true') {
      log('assets already present — skipping generation');
    } else {
      let total = 0;
      const statuses = ['active', 'active', 'active', 'active', 'proposed', 'retired', 'unverified'] as const;
      for (const city of CITIES) {
        const n = Math.round((60 + rand() * 80) * city.weight * scale);
        const cityId = cityIds.get(city.name)!;
        const values: string[] = [];
        const params: unknown[] = [];
        let pi = 1;
        for (let k = 0; k < n; k += 1) {
          const profile = (() => {
            const r = rand();
            let acc = 0;
            for (const t of TECH_PROFILE) {
              acc += t.share;
              if (r <= acc) return t;
            }
            return TECH_PROFILE[0]!;
          })();
          // cluster: gaussian core + arterial grid lines
          const onGrid = rand() < 0.45;
          const spread = 0.09;
          let lng: number;
          let lat: number;
          if (onGrid) {
            const gridLines = 14;
            const line = Math.floor(rand() * gridLines) - gridLines / 2;
            if (rand() < 0.5) {
              lng = city.lng + line * 0.012 + (rand() - 0.5) * 0.002;
              lat = city.lat + (rand() - 0.5) * spread * 2;
            } else {
              lat = city.lat + line * 0.01 + (rand() - 0.5) * 0.002;
              lng = city.lng + (rand() - 0.5) * spread * 2;
            }
          } else {
            const g = () => (rand() + rand() + rand() - 1.5) * spread;
            lng = city.lng + g();
            lat = city.lat + g();
          }
          const src = pick(sourceIds);
          const status = pick(statuses);
          const year = 2016 + Math.floor(rand() * 10);
          const month = 1 + Math.floor(rand() * 12);
          const day = 1 + Math.floor(rand() * 28);
          const deployed = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const verifiedRecently = rand() < 0.55;
          const lastVerified = verifiedRecently
            ? new Date(Date.now() - Math.floor(rand() * 120) * 86_400_000).toISOString()
            : null;
          const { score, factors } = computeConfidence({
            sourceType: src.type,
            sourceVerification: src.verification,
            evidenceCount: 0,
            lastVerifiedAt: lastVerified,
            openDisputes: 0,
            acceptedDisputes: 0,
            corroboratingSources: 1,
          });
          const vendor = pick(profile.vendors);
          values.push(
            `($${pi},$${pi + 1},$${pi + 2},$${pi + 3},$${pi + 4},$${pi + 5},$${pi + 6}::date,$${pi + 7},$${pi + 8},$${pi + 9},$${pi + 10}::jsonb,$${pi + 11}::timestamptz,$${pi + 12}::jsonb)`,
          );
          params.push(
            `${profile.namePrefix} — ${city.name} #${k + 1}`,
            cityId,
            src.id,
            profile.tech,
            vendor,
            status,
            deployed,
            score,
            lng,
            lat,
            JSON.stringify({ seeded: true, install: onGrid ? 'roadway' : 'facility' }),
            lastVerified,
            JSON.stringify(factors),
          );
          pi += 13;
          // flush every 200 rows to keep statements bounded
          if (values.length >= 200 || k === n - 1) {
            await client.query(
              `INSERT INTO surveillance_assets
                 (name, jurisdiction_id, source_id, technology_type, vendor, status, deployment_date,
                  confidence_score, lng, lat, properties, last_verified_at, confidence_factors)
               VALUES ${values.join(',')}`,
              params,
            );
            total += values.length;
            values.length = 0;
            params.length = 0;
            pi = 1;
          }
        }
      }
      log(`assets: ${total} generated (${process.env.SEED_SCALE === 'perf' ? 'perf' : 'demo'} scale)`);
    }

    /* ---------------- sample procurements ---------------- */
    const PROCS = [
      { city: 'San Francisco', vendor: 'Motorola Solutions', title: 'Citywide ALPR data services agreement', amount: 1_250_000, terms: ['license plate reader'], start: '2023-01-15', end: '2026-01-14' },
      { city: 'Chicago', vendor: 'SoundThinking', title: 'Acoustic gunshot detection subscription renewal', amount: 8_900_000, terms: ['gunshot detection'], start: '2022-07-01', end: '2025-06-30' },
      { city: 'Atlanta', vendor: 'Fusus', title: 'Real-time crime center video integration platform', amount: 2_400_000, terms: ['CCTV', 'video analytics', 'data broker / fusion'], start: '2023-05-01', end: '2026-04-30' },
      { city: 'Houston', vendor: 'Flock Safety', title: 'Neighborhood safety camera pilot — 250 ALPR units', amount: 687_500, terms: ['license plate reader', 'CCTV'], start: '2024-02-01', end: '2026-01-31' },
      { city: 'Seattle', vendor: 'Axon', title: 'Body-worn camera and digital evidence management', amount: 4_100_000, terms: ['body-worn camera'], start: '2021-09-01', end: '2026-08-31' },
    ];
    for (const p of PROCS) {
      await client.query(
        `INSERT INTO procurements (jurisdiction_id, vendor, title, amount, start_date, end_date, technology_terms, confidence_score, review_status, normalized)
         SELECT $1, $2, $3, $4, $5::date, $6::date, $7, 85, 'approved', '{"seeded":true}'::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM procurements WHERE title = $3)`,
        [cityIds.get(p.city) ?? null, p.vendor, p.title, p.amount, p.start, p.end, p.terms],
      );
    }
    log(`procurements: ${PROCS.length}`);

    /* ---------------- demo users ---------------- */
    const seedUsers = process.env.SEED_DEMO_USERS ?? (config.isProd ? 'false' : 'true');
    if (seedUsers === 'true') {
      const demoPassword = process.env.SEED_DEMO_PASSWORD ?? 'LensOfLight-demo-2026';
      const hash = await hashPassword(demoPassword);
      const demo: Array<[string, string, string]> = [
        ['admin@stn.local', 'Avery Admin', 'admin'],
        ['editor@stn.local', 'Eli Editor', 'editor'],
        ['viewer@stn.local', 'Vee Viewer', 'viewer'],
      ];
      for (const [email, name, role] of demo) {
        const { rows } = await client.query(
          `INSERT INTO users (email, name, role, password_hash, consent_flags)
           VALUES ($1, $2, $3, $4, '{"terms":true,"privacy":true,"seeded":true}'::jsonb)
           ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO UPDATE SET role = EXCLUDED.role
           RETURNING id`,
          [email, name, role, hash],
        );
        const uid = (rows[0] as { id: string }).id;
        const { rows: ws } = await client.query(
          `INSERT INTO workspaces (name, owner_id)
           SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE owner_id = $2)
           RETURNING id`,
          [`${name.split(' ')[0]}'s workspace`, uid],
        );
        const wsId = (ws[0] as { id: string } | undefined)?.id ??
          ((await client.query(`SELECT id FROM workspaces WHERE owner_id = $1 LIMIT 1`, [uid])).rows[0] as { id: string }).id;
        await client.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')
           ON CONFLICT DO NOTHING`,
          [wsId, uid],
        );
      }
      log(`demo users: admin@stn.local / editor@stn.local / viewer@stn.local (password: ${demoPassword})`);
      log('note: the admin account will be walked through TOTP enrollment on first login (MFA is enforced for admins).');
    }

    log('seed complete ✓');
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]).includes('seed');
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  });
}
