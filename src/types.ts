export type ItemAction = 'add' | 'replace' | 'delete';

export type ExecutionMode = 'local' | 'remote';

export type RemoteDeliveryPhase = 'branch' | 'pull_request';

export type DeliveryCheckpoint =
  | 'NONE'
  | 'COMMIT_PREPARED'
  | 'BRANCH_PUSHED'
  | 'PR_CREATING'
  | 'PR_CREATED';

export type BatchState =
  | 'DRAFT'
  | 'VALIDATING'
  | 'READY'
  | 'QUEUED'
  | 'RUNNING'
  | 'LOCAL_DIFF_READY'
  | 'COMMIT_PREPARED'
  | 'BRANCH_PUSHED'
  | 'PR_CREATING'
  | 'PR_CREATED'
  | 'FAILED';

export type JobState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface Submitter {
  name: string;
  email: string;
}

/** The only user record exposed to the browser. Password and session data are never serialized. */
export interface AuthenticatedUser {
  id: string;
  username: string;
}

export interface BootstrapUserCredentials {
  username: string;
  password: string;
}

export interface CreateBatchInput {
  title: string;
  description: string;
  designUrl?: string;
  submitter: Submitter;
}

export interface CreateItemInput {
  action: ItemAction;
  designName?: string;
  targetName?: string;
  description?: string;
  reason?: string;
  replacementName?: string;
}

export interface StoredBatch extends CreateBatchInput {
  id: string;
  catalogBaseline: CatalogBaseline | null;
  targetRepository: TargetRepository | null;
  executionMode: ExecutionMode | null;
  pushRepository: string | null;
  pushBranchPrefix: string | null;
  delivery: RemoteDeliveryState;
  state: BatchState;
  validation: unknown | null;
  warningsAcknowledged: boolean;
  plan: unknown | null;
  baseCommit: string | null;
  localDiff: unknown | null;
  error: { code: string; message: string } | null;
  /**
   * A server-derived, user-facing lifecycle classification.  Clients consume
   * this instead of trying to reproduce delivery/checkpoint error rules.
   */
  userStatus: UserBatchStatus;
  createdAt: string;
  updatedAt: string;
}

export interface StoredItem extends CreateItemInput {
  id: string;
  batchId: string;
  sourceFile: string | null;
  createdAt: string;
}

export interface StoredJob {
  batchId: string;
  state: JobState;
  attempt: number;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerFailureDiagnostic {
  operation?: string;
  command?: string;
  exitCode?: number;
  stderr?: string;
}

export interface JobFailure extends WorkerFailureDiagnostic {
  id: number;
  batchId: string;
  attempt: number;
  code: string;
  message: string;
  createdAt: string;
}

export interface BatchDetails extends StoredBatch {
  items: StoredItem[];
  job: StoredJob | null;
  failureHistory: JobFailure[];
}

export interface BatchSummary {
  id: string;
  title: string;
  userStatus: UserBatchStatus;
  createdAt: string;
  itemCounts: {
    total: number;
    add: number;
    replace: number;
    delete: number;
  };
}

export type UserBatchStatus =
  | 'draft'
  | 'processing'
  | 'needs_changes'
  | 'delivery_retryable'
  | 'developer_attention'
  | 'submitted_review'
  | 'local_complete';

export interface AppConfig {
  databasePath: string;
  storageRoot: string;
  repositoryPath: string;
  temporaryRoot: string;
  executionMode: ExecutionMode;
  stage1SourcePath?: string;
  localTargetRef?: string;
  targetRepository: TargetRepository;
  remoteDelivery?: RemoteDeliveryConfig;
  catalogPackageName: string;
  catalogTag: string;
  catalogRegistryUrl: string;
  catalogAuthToken?: string;
  catalogSourceRepository: string;
  catalogCacheRoot: string;
  catalogRefreshIntervalMs: number;
  workerEnabled: boolean;
  workerPollIntervalMs: number;
  /** Explicit cookie transport policy; never inferred from NODE_ENV. */
  sessionCookieSecure: boolean;
  maxUploadBytes: number;
  bootstrapUser?: BootstrapUserCredentials;
}

export interface IconBatchResult {
  exitCode: number;
  payload: Record<string, unknown>;
}

export type CatalogGroup = 'all' | 'pink' | 'toolbar' | 'common';

export interface CatalogPageInput {
  query?: string;
  group?: CatalogGroup;
  page?: number;
  pageSize?: number;
}

export interface CatalogPageIcon {
  primaryName: string;
  aliases: string[];
  group: Exclude<CatalogGroup, 'all'>;
  svg: string;
}

export interface CatalogBaseline {
  packageName: string;
  requestedTag: string;
  version: string;
  integrity: string;
  sourceRepository: string;
  sourceCommit: string;
}

export interface TargetRepository {
  repository: string;
  branch: 'main';
}

export interface RemoteDeliveryConfig {
  targetRemote: string;
  pushRepository: string;
  pushRemote: string;
  pushBranchPrefix: 'bot/';
  deliveryPhase: RemoteDeliveryPhase;
  githubToken: string;
  committer: CommitterIdentity;
}

export interface CommitterIdentity {
  name: string;
  email: string;
}

export interface BatchExecutionContext {
  executionMode: ExecutionMode;
  pushRepository: string | null;
  pushBranchPrefix: string | null;
}

export interface RemoteDeliveryState {
  checkpoint: DeliveryCheckpoint;
  branch: string | null;
  commitSha: string | null;
  pullRequest: {
    number: number;
    url: string;
    state: string;
    isDraft: boolean;
    createdAt: string | null;
  } | null;
  handoffAt: string | null;
}

export interface NpmCatalogIcon extends CatalogPageIcon {
  sourceName: string;
  codepoint: number;
}

export interface NpmCatalogSnapshot {
  baseline: CatalogBaseline;
  icons: NpmCatalogIcon[];
}

export interface NpmPackageCatalogOptions {
  packageName: string;
  tag: string;
  registryUrl: string;
  authToken?: string;
  sourceRepository: string;
  cacheRoot: string;
  refreshIntervalMs: number;
}

export interface CatalogPage {
  catalogBaseline: CatalogBaseline;
  page: number;
  pageSize: number;
  total: number;
  icons: CatalogPageIcon[];
}

export interface IconNamePreview {
  schemaVersion: 1;
  baseCommit: string;
  input: string;
  normalizedName: string;
  valid: boolean;
  collision: {
    primaryName: string;
    aliases: string[];
  } | null;
}
