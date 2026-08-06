export type ItemAction = 'add' | 'replace' | 'delete';

export type ExecutionMode = 'local' | 'remote';

export type BatchState =
  | 'DRAFT'
  | 'VALIDATING'
  | 'READY'
  | 'QUEUED'
  | 'RUNNING'
  | 'LOCAL_DIFF_READY'
  | 'FAILED';

export type JobState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface Submitter {
  name: string;
  email: string;
}

export interface CreateBatchInput {
  title: string;
  description: string;
  designUrl: string;
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
  state: BatchState;
  validation: unknown | null;
  warningsAcknowledged: boolean;
  plan: unknown | null;
  baseCommit: string | null;
  localDiff: unknown | null;
  error: { code: string; message: string } | null;
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

export interface BatchDetails extends StoredBatch {
  items: StoredItem[];
  job: StoredJob | null;
}

export interface AppConfig {
  databasePath: string;
  storageRoot: string;
  repositoryPath: string;
  temporaryRoot: string;
  executionMode: ExecutionMode;
  stage1SourcePath?: string;
  localTargetRef?: string;
  upstreamRemote: string;
  upstreamBranch: string;
  targetRepository: TargetRepository;
  catalogPackageName: string;
  catalogTag: string;
  catalogRegistryUrl: string;
  catalogAuthToken?: string;
  catalogSourceRepository: string;
  catalogCacheRoot: string;
  catalogRefreshIntervalMs: number;
  workerPollIntervalMs: number;
  maxUploadBytes: number;
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
