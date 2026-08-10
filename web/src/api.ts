export type ItemAction = 'add' | 'replace' | 'delete';
export type CatalogGroup = 'all' | 'pink' | 'toolbar' | 'common';

export interface Submitter {
  name: string;
  email: string;
}

export interface BatchInput {
  title: string;
  description: string;
  designUrl?: string;
  submitter: Submitter;
}

export interface ItemInput {
  action: ItemAction;
  designName?: string;
  targetName?: string;
  description?: string;
  reason?: string;
  replacementName?: string;
}

export interface ApiItem extends ItemInput {
  id: string;
  batchId: string;
  sourceFile: string | null;
}

export interface Diagnostic {
  code: string;
  message: string;
  itemId?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

export interface BatchDetails extends BatchInput {
  id: string;
  executionMode: 'local' | 'remote' | null;
  state: 'DRAFT' | 'VALIDATING' | 'READY' | 'QUEUED' | 'RUNNING' | 'LOCAL_DIFF_READY' | 'COMMIT_PREPARED' | 'BRANCH_PUSHED' | 'PR_CREATING' | 'PR_CREATED' | 'FAILED';
  items: ApiItem[];
  validation: ValidationResult | null;
  warningsAcknowledged: boolean;
  localDiff: { changedFiles: string[]; patch: string } | null;
  delivery: {
    checkpoint: 'NONE' | 'COMMIT_PREPARED' | 'BRANCH_PUSHED' | 'PR_CREATING' | 'PR_CREATED';
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
  };
  error: { code: string; message: string } | null;
}

export interface NamePreview {
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

export interface CatalogPage {
  catalogBaseline: CatalogBaseline;
  page: number;
  pageSize: number;
  total: number;
  icons: CatalogPageIcon[];
}

export interface CatalogPageQuery {
  query?: string;
  group?: CatalogGroup;
  page?: number;
  pageSize?: number;
}

export class ApiError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string; code?: string } } | null;
    throw new ApiError(body?.error?.message ?? `请求失败 (${response.status})`, body?.error?.code);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

function itemRequest(item: ItemInput, svg?: File): RequestInit {
  if (svg) {
    const body = new FormData();
    body.set('item', JSON.stringify(item));
    body.set('svg', svg);
    return { method: 'POST', body };
  }
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(item),
  };
}

export const api = {
  getCatalogPage: (query: CatalogPageQuery) => {
    const parameters = new URLSearchParams();
    if (query.query) parameters.set('query', query.query);
    if (query.group) parameters.set('group', query.group);
    if (query.page) parameters.set('page', String(query.page));
    if (query.pageSize) parameters.set('pageSize', String(query.pageSize));
    return request<CatalogPage>(`/api/catalog/page?${parameters.toString()}`);
  },
  previewName: (name: string) => request<NamePreview>(`/api/names/preview?${new URLSearchParams({ name }).toString()}`),
  createBatch: (input: BatchInput) => request<BatchDetails>('/api/batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }),
  updateBatch: (batchId: string, input: Pick<BatchInput, 'title' | 'description' | 'designUrl'>) => request<BatchDetails>(`/api/batches/${encodeURIComponent(batchId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }),
  addItem: (batchId: string, item: ItemInput, svg?: File) => request<ApiItem>(`/api/batches/${encodeURIComponent(batchId)}/items`, itemRequest(item, svg)),
  updateItem: (batchId: string, itemId: string, item: ItemInput, svg?: File) => {
    const options = itemRequest(item, svg);
    return request<ApiItem>(`/api/batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}`, { ...options, method: 'PUT' });
  },
  deleteItem: (batchId: string, itemId: string) => request<void>(`/api/batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' }),
  validateBatch: (batchId: string) => request<BatchDetails>(`/api/batches/${encodeURIComponent(batchId)}/validate`, { method: 'POST' }),
  submitBatch: (batchId: string, confirmRepeatedSubmission = false) => request<BatchDetails>(`/api/batches/${encodeURIComponent(batchId)}/submit`, {
    method: 'POST',
    ...(confirmRepeatedSubmission ? {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmRepeatedSubmission: true }),
    } : {}),
  }),
  returnToEdit: (batchId: string) => request<BatchDetails>(`/api/batches/${encodeURIComponent(batchId)}/return-to-edit`, { method: 'POST' }),
  retryBatch: (batchId: string) => request<BatchDetails>(`/api/batches/${encodeURIComponent(batchId)}/retry`, { method: 'POST' }),
  getBatch: (batchId: string) => request<BatchDetails>(`/api/batches/${encodeURIComponent(batchId)}`),
};
