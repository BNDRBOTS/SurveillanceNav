import type {
  TechnologyType,
  AssetStatus,
  SourceType,
  VerificationStatus,
  GlobalRole,
  WorkspaceRole,
  FoiaStatus,
  FoiaOutcome,
  DisputeStatus,
  ExportFormat,
  ExportStatus,
  JurisdictionType,
  ProcurementReviewStatus,
  ScanStatus,
  PiiStatus,
} from './constants.js';

/** Consistent API error envelope. Never leaks stack traces. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    retryAfterSec?: number;
  };
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface UserPublic {
  id: string;
  email: string;
  name: string;
  role: GlobalRole;
  status: 'active' | 'invited' | 'suspended' | 'deleted';
  mfaEnabled: boolean;
  consentFlags: Record<string, boolean>;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthTokens {
  accessToken: string;
  expiresInSec: number;
  user: UserPublic;
  mfaSetupRequired?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  settings: Record<string, unknown>;
  role?: WorkspaceRole;
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  createdAt: string;
}

export interface Jurisdiction {
  id: string;
  name: string;
  type: JurisdictionType;
  parentId: string | null;
  geojson?: unknown;
  assetCount?: number;
  createdAt: string;
}

export interface Source {
  id: string;
  name: string;
  type: SourceType;
  url: string | null;
  contact: string | null;
  verificationStatus: VerificationStatus;
  lastVerifiedAt: string | null;
  createdAt: string;
}

export interface ConfidenceFactor {
  factor: string;
  delta: number;
  note: string;
}

export interface SurveillanceAsset {
  id: string;
  name: string;
  jurisdictionId: string | null;
  jurisdictionName?: string | null;
  sourceId: string | null;
  sourceName?: string | null;
  sourceType?: SourceType | null;
  sourceVerification?: VerificationStatus | null;
  technologyType: TechnologyType;
  vendor: string | null;
  status: AssetStatus;
  deploymentDate: string | null;
  retirementDate: string | null;
  confidenceScore: number;
  confidenceFactors?: ConfidenceFactor[];
  lng: number;
  lat: number;
  properties: Record<string, unknown>;
  evidenceCount?: number;
  openDisputes?: number;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetHistoryEntry {
  id: number;
  assetId: string;
  userId: string | null;
  userName?: string | null;
  action: string;
  diff: Record<string, { from: unknown; to: unknown }> | null;
  createdAt: string;
}

export interface AssetEvidence {
  id: string;
  assetId: string;
  fileKey: string;
  fileName: string;
  fileType: string;
  sizeBytes: number;
  scanStatus: ScanStatus;
  piiStatus: PiiStatus;
  createdAt: string;
}

export interface Dispute {
  id: string;
  assetId: string;
  assetName?: string;
  userId: string;
  userName?: string;
  reason: string;
  evidence: string;
  evidenceUrl: string | null;
  status: DisputeStatus;
  resolution: string | null;
  adminId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FoiaRequest {
  id: string;
  workspaceId: string;
  jurisdictionId: string | null;
  jurisdictionName?: string | null;
  createdBy: string;
  status: FoiaStatus;
  outcome: FoiaOutcome | null;
  subject: string;
  body: string;
  foiaNumber: string | null;
  sentAt: string | null;
  dueAt: string | null;
  documentCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface FoiaTemplate {
  id: string;
  name: string;
  technology: TechnologyType | null;
  body: string;
}

export interface FoiaDocument {
  id: string;
  requestId: string;
  fileKey: string;
  fileName: string;
  fileType: string;
  sizeBytes: number;
  scanStatus: ScanStatus;
  piiStatus: PiiStatus;
  redactions: unknown;
  createdAt: string;
}

export interface Procurement {
  id: string;
  jurisdictionId: string | null;
  jurisdictionName?: string | null;
  vendor: string | null;
  title: string;
  amount: number | null;
  currency: string;
  startDate: string | null;
  endDate: string | null;
  technologyTerms: string[];
  confidenceScore: number;
  rawFileKey: string | null;
  normalized: Record<string, unknown>;
  reviewStatus: ProcurementReviewStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Policy {
  id: string;
  jurisdictionId: string;
  jurisdictionName?: string | null;
  title: string;
  effectiveDate: string;
  sourceUrl: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExportJob {
  id: string;
  workspaceId: string | null;
  userId: string;
  format: ExportFormat;
  resource: string;
  params: Record<string, unknown>;
  fileKey: string | null;
  status: ExportStatus;
  error: string | null;
  rowCount: number | null;
  truncated: boolean;
  downloadUrl?: string | null;
  expiresAt: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AuditLogEntry {
  id: number;
  actorId: string | null;
  actorEmail?: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface CommentItem {
  id: string;
  assetId: string;
  workspaceId: string;
  userId: string;
  userName: string;
  body: string;
  mentions: string[];
  createdAt: string;
}

export interface LayerPreset {
  id: string;
  name: string;
  workspaceId: string | null;
  userId: string;
  config: Record<string, unknown>;
  shareToken: string;
  createdAt: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  checks: Record<string, { ok: boolean; latencyMs?: number; detail?: string }>;
  version: string;
  uptimeSec: number;
}

export interface AdminMetrics {
  requestsLastHour: number;
  errorRateLastHour: number;
  p95LatencyMs: number;
  dbHealthy: boolean;
  cacheBackend: 'redis' | 'memory';
  cacheHitRatio: number;
  jobs: { queued: number; running: number; failedLast24h: number };
  scheduledJobs: Array<{
    name: string;
    enabled: boolean;
    intervalSec: number;
    lastRunAt: string | null;
    lastStatus: string | null;
    lastDurationMs: number | null;
  }>;
  storage: { backend: string; ok: boolean };
  counts: Record<string, number>;
}

/** Cluster feature returned by the assets endpoint at low zoom. */
export interface AssetClusterFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    cluster: true;
    count: number;
    techBreakdown: Partial<Record<TechnologyType, number>>;
  };
}
