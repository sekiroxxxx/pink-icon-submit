export type ItemAction = 'add' | 'replace' | 'delete';

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
  state: BatchState;
  validation: unknown | null;
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
  upstreamRemote: string;
  upstreamBranch: string;
  workerPollIntervalMs: number;
  maxUploadBytes: number;
}

export interface IconBatchResult {
  exitCode: number;
  payload: Record<string, unknown>;
}
