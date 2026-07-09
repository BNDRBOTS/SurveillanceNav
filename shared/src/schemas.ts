import { z } from 'zod';
import {
  TECHNOLOGY_TYPES,
  ASSET_STATUSES,
  SOURCE_TYPES,
  VERIFICATION_STATUSES,
  FOIA_STATUSES,
  FOIA_OUTCOMES,
  DISPUTE_STATUSES,
  EXPORT_FORMATS,
  JURISDICTION_TYPES,
  WORKSPACE_ROLES,
  PROCUREMENT_REVIEW_STATUSES,
  LIMITS,
} from './constants.js';

/* ------------------------------------------------------------------ *
 * Primitives: every external input passes through one of these.
 * They trim, strip zero-width characters, and bound length so that
 * malformed copy/paste input is normalized instead of crashing flows.
 * ------------------------------------------------------------------ */

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u2060]/g;

export const safeString = (max = 500) =>
  z
    .string()
    .transform((s) => s.replace(ZERO_WIDTH, '').trim())
    .pipe(z.string().max(max));

export const nonEmptyString = (max = 500) => safeString(max).pipe(z.string().min(1, 'Required'));

export const uuid = z.string().uuid('Invalid id');

export const email = safeString(254)
  .pipe(z.string().toLowerCase().email('Enter a valid email address'));

export const password = z
  .string()
  .min(LIMITS.passwordMinLength, `Use at least ${LIMITS.passwordMinLength} characters`)
  .max(128, 'Password is too long')
  .refine((p) => /[a-z]/.test(p) && /[A-Z0-9]/.test(p), {
    message: 'Mix upper/lower case letters or numbers',
  });

export const latitude = z.coerce.number().min(-90).max(90);
export const longitude = z.coerce.number().min(-180).max(180);

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((d) => !Number.isNaN(Date.parse(d)), 'Invalid date');

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  sort: safeString(60).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/** "minLng,minLat,maxLng,maxLat" — tolerant of whitespace and stray chars. */
export const bbox = z
  .string()
  .transform((s) => s.replace(ZERO_WIDTH, '').trim())
  .refine((s) => {
    const parts = s.split(',').map((p) => Number(p.trim()));
    return parts.length === 4 && parts.every((n) => Number.isFinite(n));
  }, 'bbox must be "minLng,minLat,maxLng,maxLat"')
  .transform((s) => {
    const [minLng, minLat, maxLng, maxLat] = s.split(',').map((p) => Number(p.trim())) as [
      number,
      number,
      number,
      number,
    ];
    return { minLng, minLat, maxLng, maxLat };
  })
  .refine(
    (b) => b.minLng >= -180 && b.maxLng <= 180 && b.minLat >= -90 && b.maxLat <= 90 && b.minLng <= b.maxLng && b.minLat <= b.maxLat,
    'bbox out of range',
  );

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

export const signupSchema = z.object({
  email,
  name: nonEmptyString(120),
  password,
  consent: z.object({
    terms: z.literal(true, { errorMap: () => ({ message: 'You must accept the terms' }) }),
    privacy: z.literal(true, { errorMap: () => ({ message: 'You must accept the privacy policy' }) }),
    researchContact: z.boolean().default(false),
  }),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Required').max(128),
  totp: safeString(12).optional(),
});

export const mfaVerifySchema = z.object({ code: nonEmptyString(12) });

export const resetRequestSchema = z.object({ email });
export const resetCompleteSchema = z.object({ token: nonEmptyString(200), password });

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

export const updateMeSchema = z
  .object({
    name: nonEmptyString(120).optional(),
    consent: z.object({ researchContact: z.boolean() }).optional(),
    currentPassword: z.string().max(128).optional(),
    newPassword: password.optional(),
  })
  .refine((v) => !v.newPassword || !!v.currentPassword, {
    message: 'Current password required to change password',
    path: ['currentPassword'],
  });

/* ------------------------------------------------------------------ *
 * Workspaces
 * ------------------------------------------------------------------ */

export const createWorkspaceSchema = z.object({
  name: nonEmptyString(120),
  settings: z
    .object({
      defaultRegion: z.object({ lng: longitude, lat: latitude, zoom: z.number().min(0).max(22) }).optional(),
    })
    .partial()
    .default({}),
});

export const updateWorkspaceSchema = createWorkspaceSchema.partial();

export const addMemberSchema = z.object({
  email,
  role: z.enum(WORKSPACE_ROLES).default('viewer'),
});

/* ------------------------------------------------------------------ *
 * Assets
 * ------------------------------------------------------------------ */

export const assetFiltersSchema = z.object({
  bbox: bbox.optional(),
  zoom: z.coerce.number().min(0).max(24).optional(),
  jurisdictionId: uuid.optional(),
  technologyType: z
    .union([z.enum(TECHNOLOGY_TYPES), z.array(z.enum(TECHNOLOGY_TYPES))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  vendor: safeString(120).optional(),
  status: z
    .union([z.enum(ASSET_STATUSES), z.array(z.enum(ASSET_STATUSES))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  sourceType: z
    .union([z.enum(SOURCE_TYPES), z.array(z.enum(SOURCE_TYPES))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  verification: z.enum(VERIFICATION_STATUSES).optional(),
  minConfidence: z.coerce.number().int().min(0).max(100).optional(),
  deployedAfter: isoDate.optional(),
  deployedBefore: isoDate.optional(),
  q: safeString(200).optional(),
  nearLng: longitude.optional(),
  nearLat: latitude.optional(),
  radiusMeters: z.coerce.number().min(1).max(200_000).optional(),
  format: z.enum(['json', 'geojson']).default('json'),
});

export const listAssetsQuery = assetFiltersSchema.merge(paginationQuery);

export const createAssetSchema = z.object({
  name: nonEmptyString(200),
  jurisdictionId: uuid.nullable().optional(),
  sourceId: uuid.nullable().optional(),
  technologyType: z.enum(TECHNOLOGY_TYPES),
  vendor: safeString(120).optional(),
  status: z.enum(ASSET_STATUSES).default('unverified'),
  deploymentDate: isoDate.nullable().optional(),
  retirementDate: isoDate.nullable().optional(),
  lng: longitude,
  lat: latitude,
  properties: z.record(z.unknown()).default({}),
});

export const updateAssetSchema = createAssetSchema.partial();

export const flagAssetSchema = z.object({
  reason: nonEmptyString(2000),
});

export const disputeAssetSchema = z.object({
  reason: nonEmptyString(200),
  evidence: nonEmptyString(5000),
  evidenceUrl: safeString(500).optional(),
});

export const resolveErrorReportSchema = z.object({
  action: z.enum(['resolved', 'dismissed']),
});

export const resolveDisputeSchema = z.object({
  status: z.enum(DISPUTE_STATUSES),
  resolution: nonEmptyString(5000),
});

/* ------------------------------------------------------------------ *
 * FOIA
 * ------------------------------------------------------------------ */

export const createFoiaSchema = z.object({
  workspaceId: uuid,
  jurisdictionId: uuid.nullable().optional(),
  subject: nonEmptyString(300),
  body: nonEmptyString(20000),
  templateId: uuid.optional(),
  dueAt: isoDate.nullable().optional(),
});

export const updateFoiaSchema = z.object({
  subject: nonEmptyString(300).optional(),
  body: nonEmptyString(20000).optional(),
  jurisdictionId: uuid.nullable().optional(),
  status: z.enum(FOIA_STATUSES).optional(),
  outcome: z.enum(FOIA_OUTCOMES).nullable().optional(),
  foiaNumber: safeString(100).nullable().optional(),
  dueAt: isoDate.nullable().optional(),
  sentAt: isoDate.nullable().optional(),
});

export const listFoiaQuery = paginationQuery.extend({
  workspaceId: uuid.optional(),
  status: z.enum(FOIA_STATUSES).optional(),
  q: safeString(200).optional(),
});

/* ------------------------------------------------------------------ *
 * Procurement
 * ------------------------------------------------------------------ */

export const parseProcurementSchema = z.object({
  jurisdictionId: uuid.nullable().optional(),
  /** Raw pasted text. File uploads use multipart on the same endpoint. */
  text: safeString(200_000).optional(),
  title: safeString(300).optional(),
});

export const updateProcurementSchema = z.object({
  vendor: safeString(160).nullable().optional(),
  title: safeString(300).optional(),
  amount: z.coerce.number().min(0).max(1e12).nullable().optional(),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
  technologyTerms: z.array(safeString(80)).max(50).optional(),
  jurisdictionId: uuid.nullable().optional(),
  reviewStatus: z.enum(PROCUREMENT_REVIEW_STATUSES).optional(),
});

export const listProcurementsQuery = paginationQuery.extend({
  jurisdictionId: uuid.optional(),
  vendor: safeString(160).optional(),
  reviewStatus: z.enum(PROCUREMENT_REVIEW_STATUSES).optional(),
  q: safeString(200).optional(),
});

/* ------------------------------------------------------------------ *
 * Policies
 * ------------------------------------------------------------------ */

export const createPolicySchema = z.object({
  jurisdictionId: uuid,
  title: nonEmptyString(300),
  effectiveDate: isoDate,
  sourceUrl: safeString(500).pipe(z.string().url('Enter a valid URL')).nullable().optional(),
  content: nonEmptyString(100_000),
});

export const updatePolicySchema = createPolicySchema.partial();

export const listPoliciesQuery = paginationQuery.extend({
  jurisdictionId: uuid.optional(),
  q: safeString(200).optional(),
});

/* ------------------------------------------------------------------ *
 * Exports
 * ------------------------------------------------------------------ */

export const createExportSchema = z.object({
  workspaceId: uuid.nullable().optional(),
  format: z.enum(EXPORT_FORMATS),
  resource: z.enum(['assets', 'foia', 'procurements', 'policies', 'report']),
  params: z.record(z.unknown()).default({}),
});

/* ------------------------------------------------------------------ *
 * Jurisdictions & sources
 * ------------------------------------------------------------------ */

export const createJurisdictionSchema = z.object({
  name: nonEmptyString(200),
  type: z.enum(JURISDICTION_TYPES),
  parentId: uuid.nullable().optional(),
  geojson: z.record(z.unknown()).nullable().optional(),
});

export const createSourceSchema = z.object({
  name: nonEmptyString(200),
  type: z.enum(SOURCE_TYPES),
  url: safeString(500).pipe(z.string().url()).nullable().optional(),
  contact: safeString(300).nullable().optional(),
});

export const updateSourceSchema = createSourceSchema.partial().extend({
  verificationStatus: z.enum(VERIFICATION_STATUSES).optional(),
});

/* ------------------------------------------------------------------ *
 * Comments & layer presets
 * ------------------------------------------------------------------ */

export const createCommentSchema = z.object({
  workspaceId: uuid,
  body: nonEmptyString(5000),
});

export const layerPresetSchema = z.object({
  name: nonEmptyString(120),
  workspaceId: uuid.nullable().optional(),
  config: z.object({
    baseStyle: z.enum(['streets', 'satellite', 'hybrid', 'dark', 'contrast']).default('dark'),
    layers: z.record(z.boolean()).default({}),
    heatmap: z.boolean().default(false),
    clustering: z.boolean().default(true),
    filters: z.record(z.unknown()).default({}),
    camera: z.object({ lng: longitude, lat: latitude, zoom: z.number().min(0).max(22) }).optional(),
  }),
});

/* ------------------------------------------------------------------ *
 * Admin
 * ------------------------------------------------------------------ */

export const mergeAssetsSchema = z.object({
  keepId: uuid,
  mergeIds: z.array(uuid).min(1).max(50),
});

export const updateUserAdminSchema = z.object({
  role: z.enum(['viewer', 'editor', 'admin']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
});

export const auditLogQuery = paginationQuery.extend({
  actorId: uuid.optional(),
  action: safeString(100).optional(),
  resource: safeString(100).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const settingsUpdateSchema = z.object({
  key: nonEmptyString(100),
  value: z.unknown(),
});

/* ------------------------------------------------------------------ *
 * Error reports — anonymous forensic diagnostics from the client.
 * Bounded hard: this endpoint accepts unauthenticated traffic.
 * ------------------------------------------------------------------ */
export const errorReportSchema = z
  .object({
    kind: z.enum(['map_style', 'map_tiles', 'statute', 'content', 'client_error']),
    message: nonEmptyString(500),
    detail: z
      .object({
        route: safeString(200).optional(),
        styleId: safeString(40).optional(),
        errorChain: z.array(safeString(300)).max(10).optional(),
        mapState: z
          .object({ lng: z.number().finite(), lat: z.number().finite(), zoom: z.number().finite() })
          .optional(),
        viewport: safeString(40).optional(),
        online: z.boolean().optional(),
        context: safeString(1000).optional(),
      })
      .default({}),
    appVersion: safeString(40).optional(),
  })
  .refine((r) => JSON.stringify(r.detail).length <= 8_192, { message: 'Diagnostic detail too large' });
