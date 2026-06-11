/** Domain constants shared by server and web. Single source of truth. */

export const TECHNOLOGY_TYPES = [
  'lpr',
  'cctv',
  'facial_recognition',
  'drone',
  'gunshot_detection',
  'cell_site_simulator',
  'body_worn_camera',
  'sensor',
  'predictive_policing',
  'other',
] as const;
export type TechnologyType = (typeof TECHNOLOGY_TYPES)[number];

export const TECHNOLOGY_LABELS: Record<TechnologyType, string> = {
  lpr: 'License Plate Reader',
  cctv: 'CCTV Camera',
  facial_recognition: 'Facial Recognition',
  drone: 'Drone / UAS',
  gunshot_detection: 'Gunshot Detection',
  cell_site_simulator: 'Cell-Site Simulator',
  body_worn_camera: 'Body-Worn Camera',
  sensor: 'Sensor Network',
  predictive_policing: 'Predictive Policing',
  other: 'Other',
};

export const ASSET_STATUSES = ['proposed', 'active', 'retired', 'removed', 'unverified'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const SOURCE_TYPES = ['government', 'ngo', 'academic', 'community', 'media'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const VERIFICATION_STATUSES = ['unverified', 'pending', 'verified', 'rejected'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const GLOBAL_ROLES = ['viewer', 'editor', 'admin'] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

export const WORKSPACE_ROLES = ['viewer', 'editor', 'admin'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const FOIA_STATUSES = ['draft', 'sent', 'acknowledged', 'response', 'appeal', 'closed'] as const;
export type FoiaStatus = (typeof FOIA_STATUSES)[number];

export const FOIA_OUTCOMES = ['fulfilled', 'partial', 'denied', 'withdrawn'] as const;
export type FoiaOutcome = (typeof FOIA_OUTCOMES)[number];

export const DISPUTE_STATUSES = ['open', 'under_review', 'accepted', 'rejected', 'withdrawn'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const EXPORT_FORMATS = ['csv', 'geojson', 'json', 'kml', 'pdf', 'html'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_STATUSES = ['queued', 'processing', 'completed', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const JURISDICTION_TYPES = ['country', 'state', 'county', 'city', 'agency'] as const;
export type JurisdictionType = (typeof JURISDICTION_TYPES)[number];

export const PROCUREMENT_REVIEW_STATUSES = ['needs_review', 'approved', 'rejected'] as const;
export type ProcurementReviewStatus = (typeof PROCUREMENT_REVIEW_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const SCAN_STATUSES = ['pending', 'clean', 'quarantined'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const PII_STATUSES = ['pending', 'clean', 'flagged'] as const;
export type PiiStatus = (typeof PII_STATUSES)[number];

/** Known surveillance vendors used by the procurement parser and filters. */
export const KNOWN_VENDORS = [
  'Flock Safety',
  'Axon',
  'Motorola Solutions',
  'Vigilant Solutions',
  'ShotSpotter',
  'SoundThinking',
  'Genetec',
  'Verkada',
  'BriefCam',
  'Cellebrite',
  'Clearview AI',
  'Palantir',
  'Fusus',
  'Ring',
  'DJI',
  'Skydio',
  'Harris Corporation',
  'L3Harris',
  'NEC',
  'Idemia',
  'Avigilon',
  'Hikvision',
  'Dahua',
  'PredPol',
  'Geolitica',
  'Dataminr',
] as const;

/** Limits enforced by API and surfaced in UI. */
export const LIMITS = {
  uploadMaxBytes: 50 * 1024 * 1024, // 50MB
  exportMaxRows: 50_000,
  exportFreeRows: 10_000,
  assetPageMax: 5000,
  searchDebounceMs: 150,
  accessTokenTtlSec: 15 * 60,
  refreshTokenTtlSec: 30 * 24 * 3600,
  exportTtlHours: 72,
  passwordMinLength: 10,
} as const;

export const ALLOWED_UPLOAD_MIME = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'text/csv',
  'text/plain',
] as const;

/** Map technology types to marker colors — glowing hues on void, no blues. */
export const TECH_COLORS: Record<TechnologyType, string> = {
  lpr: '#00E5A8',
  cctv: '#FFD166',
  facial_recognition: '#FF4D4D',
  drone: '#FF8E3C',
  gunshot_detection: '#B98CFF',
  cell_site_simulator: '#FF5CA8',
  body_worn_camera: '#4ADE80',
  sensor: '#19D3DA',
  predictive_policing: '#ACFF3C',
  other: '#8A9099',
};

export const API_PREFIX = '/api/v1';
