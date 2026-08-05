export type ItemAction = 'add' | 'replace' | 'delete';

export interface Submitter {
  name: string;
  email: string;
}

export interface BatchInput {
  title: string;
  description: string;
  designUrl: string;
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
  state: 'DRAFT' | 'VALIDATING' | 'READY' | 'QUEUED' | 'RUNNING' | 'LOCAL_DIFF_READY' | 'FAILED';
  items: ApiItem[];
  validation: ValidationResult | null;
  localDiff: { changedFiles: string[]; patch: string } | null;
  error: { code: string; message: string } | null;
}

export interface CatalogIcon {
  primaryName: string;
  sourceName: string;
  aliases: string[];
  sourceFile: string;
}

export interface Catalog {
  icons: CatalogIcon[];
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
  getCatalog: () => request<Catalog>('/api/catalog'),
  createBatch: (input: BatchInput) => request<BatchDetails>('/api/batches', {
    method: 'POST',
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
  submitBatch: (batchId: string) => request<BatchDetails>(`/api/batches/${encodeURIComponent(batchId)}/submit`, { method: 'POST' }),
  retryBatch: (batchId: string) => request<BatchDetails>(`/api/batches/${encodeURIComponent(batchId)}/retry`, { method: 'POST' }),
  getBatch: (batchId: string) => request<BatchDetails>(`/api/batches/${encodeURIComponent(batchId)}`),
  iconPreviewUrl: (name: string) => `/api/catalog/icons/${encodeURIComponent(name)}/svg`,
};
