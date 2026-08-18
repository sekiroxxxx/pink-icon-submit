import { act, fireEvent, render as renderBase, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

const { getSvgPreviewMock, putSvgPreviewMock } = vi.hoisted(() => ({
  getSvgPreviewMock: vi.fn().mockResolvedValue(undefined),
  putSvgPreviewMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./svg-preview-cache', () => ({
  getSvgPreview: getSvgPreviewMock,
  putSvgPreview: putSvgPreviewMock,
}));

import { App } from './App';
import type { ApiItem, BatchDetails, BatchSummary, ItemInput } from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

// Authentication is provided by stubFetch for every test; browser storage is not identity state.
function saveProfile(): void {}

function svgFile(name: string): File {
  return new File(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h1v1H0z" /></svg>'], name, { type: 'image/svg+xml' });
}

function delivery(overrides: Partial<BatchDetails['delivery']> = {}): BatchDetails['delivery'] {
  return {
    checkpoint: 'NONE',
    branch: null,
    commitSha: null,
    pullRequest: null,
    handoffAt: null,
    ...overrides,
  };
}

function batch(overrides: Partial<BatchDetails> = {}): BatchDetails {
  const result: BatchDetails = {
    id: 'ICON-TEST',
    title: '默认标题',
    description: '默认整体需求说明。',
    designUrl: undefined,
    submitter: { name: '设计师', email: 'designer@example.invalid' },
    executionMode: 'local',
    state: 'DRAFT',
    items: [],
    validation: null,
    warningsAcknowledged: false,
    baseCommit: null,
    localDiff: null,
    delivery: delivery(),
    error: null,
    job: null,
    userStatus: 'draft',
    createdAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
  if (overrides.userStatus) return result;
  if (result.state === 'PR_CREATED') return { ...result, userStatus: 'submitted_review' };
  if (result.state === 'LOCAL_DIFF_READY') return { ...result, userStatus: 'local_complete' };
  if (result.state !== 'FAILED') return { ...result, userStatus: result.state === 'DRAFT' ? 'draft' : 'processing' };
  if (result.validation?.valid === false) return { ...result, userStatus: 'needs_changes' };
  if (result.error?.code === 'GIT_COMMAND_FAILED' || result.error?.code === 'WORKER_INTERRUPTED') return { ...result, userStatus: 'delivery_retryable' };
  return { ...result, userStatus: 'developer_attention' };
}

function stubFetch(handler: (path: string, options?: RequestInit) => unknown, summaries: BatchSummary[] = [], activeBatch?: BatchDetails | (() => BatchDetails | undefined)): void {
  vi.stubGlobal('fetch', vi.fn((path: string, options?: RequestInit) => {
    if (path === '/api/auth/me') {
      return Promise.resolve(jsonResponse({ user: { id: 'user-designer', username: 'designer@example.invalid' } }));
    }
    if (path === '/api/batches/active') {
      const active = typeof activeBatch === 'function' ? activeBatch() : activeBatch;
      if (active) return Promise.resolve(jsonResponse(active));
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path === '/api/batches?limit=20') {
      return Promise.resolve(jsonResponse(summaries));
    }
    return handler(path, options);
  }));
}

function render(ui: ReactElement) {
  return renderBase(ui);
}

async function openNewWorkbench(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: '新建图标变更' }));
}

function summary(overrides: Partial<BatchSummary> = {}): BatchSummary {
  return {
    id: 'ICON-SUMMARY',
    title: '最近图标变更',
    userStatus: 'draft',
    createdAt: '2026-08-10T00:00:00.000Z',
    itemCounts: { total: 1, add: 1, replace: 0, delete: 0 },
    ...overrides,
  };
}

async function addOneSvgChange(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await fillBatchMetadata(user);
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, svgFile('new-icon.svg'));
  await screen.findByRole('button', { name: '选择 new-icon.svg' });
  await user.type(screen.getByLabelText(/^期望图标名称/), 'pink-new-icon');
  await user.type(screen.getByLabelText(/^用途说明/), '用于测试新增图标的设计稿。');
  await user.click(screen.getByRole('button', { name: '加入新增队列' }));
}

async function fillBatchMetadata(user: ReturnType<typeof userEvent.setup>, designUrl?: string): Promise<void> {
  const title = screen.getByLabelText(/^本次变更标题/) as HTMLInputElement;
  const description = screen.getByLabelText(/^整体需求说明/) as HTMLTextAreaElement;
  if (!title.value) await user.type(title, '模型入口图标');
  if (!description.value) await user.type(description, '新增模型入口图标。');
  if (designUrl) await user.type(screen.getByLabelText(/^设计稿链接/), designUrl);
}

async function openReview(user: ReturnType<typeof userEvent.setup>, designUrl?: string): Promise<void> {
  if (designUrl) await user.type(screen.getByLabelText(/^设计稿链接/), designUrl);
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  await user.click(screen.getByRole('checkbox'));
}

function draftApiHandler(catalog?: unknown) {
  let current: BatchDetails | undefined;
  let itemSequence = 0;
  return vi.fn(async (path: string, options?: RequestInit) => {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/catalog/page' && catalog) return jsonResponse(catalog);
    if (url.pathname === '/api/batches' && options?.method === 'POST') {
      const metadata = JSON.parse(String(options.body)) as Pick<BatchDetails, 'title' | 'description' | 'designUrl'>;
      current = batch({ id: 'ICON-DRAFT', ...metadata, items: [] });
      return jsonResponse(current);
    }
    if (current && url.pathname === `/api/batches/${current.id}` && options?.method === 'PUT') {
      const metadata = JSON.parse(String(options.body)) as Pick<BatchDetails, 'title' | 'description' | 'designUrl'>;
      current = { ...current, ...metadata };
      return jsonResponse(current);
    }
    if (current && url.pathname === `/api/batches/${current.id}` && !options?.method) return jsonResponse(current);
    if (current && url.pathname === `/api/batches/${current.id}/items` && options?.method === 'POST') {
      const body = options.body;
      const input = body instanceof FormData
        ? JSON.parse(String(body.get('item'))) as ItemInput
        : JSON.parse(String(body)) as ItemInput;
      const item: ApiItem = {
        id: `item-${++itemSequence}`,
        batchId: current.id,
        ...input,
        sourceFile: body instanceof FormData ? `items/item-${itemSequence}.svg` : null,
      };
      current = { ...current, items: [...current.items, item] };
      return jsonResponse(item);
    }
    if (current && url.pathname === `/api/batches/${current.id}/submit` && options?.method === 'POST') {
      current = batch({ ...current, state: 'QUEUED' });
      return jsonResponse(current);
    }
    throw new Error(`Unexpected request: ${path}`);
  });
}

function statefulDraftServer(options: { loseCreateResponse?: boolean; loseAddResponse?: boolean; failFirstReconciliationGet?: boolean; failAddBeforeWrite?: boolean; failMetadataSave?: boolean } = {}) {
  let current: BatchDetails | undefined;
  let itemSequence = 0;
  let createCount = 0;
  let addCount = 0;
  let submitCount = 0;
  let metadataSaveCount = 0;
  let createResponseLost = false;
  let addResponseLost = false;
  let addFailedBeforeWrite = false;
  let reconciliationGetFailed = false;
  const itemMutationIds: Array<string | undefined> = [];
  const handler = vi.fn(async (path: string, request?: RequestInit) => {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/auth/logout' && request?.method === 'POST') return new Response(null, { status: 204 });
    if (url.pathname === '/api/auth/login' && request?.method === 'POST') return jsonResponse({ user: { id: 'user-designer', username: 'designer@example.invalid' } });
    if (url.pathname === '/api/batches' && request?.method === 'POST') {
      createCount += 1;
      const metadata = JSON.parse(String(request.body)) as Pick<BatchDetails, 'title' | 'description' | 'designUrl'>;
      current = batch({ id: 'ICON-PERSISTED', ...metadata, items: [] });
      if (options.loseCreateResponse && !createResponseLost) {
        createResponseLost = true;
        throw new TypeError('The create response was lost.');
      }
      return jsonResponse(current);
    }
    if (current && url.pathname === `/api/batches/${current.id}` && request?.method === 'PUT') {
      metadataSaveCount += 1;
      if (options.failMetadataSave) return jsonResponse({ error: { code: 'SAVE_FAILED', message: 'Metadata save failed.' } }, 500);
      const metadata = JSON.parse(String(request.body)) as Pick<BatchDetails, 'title' | 'description' | 'designUrl'>;
      current = { ...current, ...metadata };
      return jsonResponse(current);
    }
    if (current && url.pathname === `/api/batches/${current.id}` && !request?.method) {
      if (options.failFirstReconciliationGet && addResponseLost && !reconciliationGetFailed) {
        reconciliationGetFailed = true;
        return jsonResponse({ error: { code: 'READ_FAILED', message: 'The first reconciliation read failed.' } }, 503);
      }
      return jsonResponse(current);
    }
    if (current && url.pathname === `/api/batches/${current.id}/items` && request?.method === 'POST') {
      addCount += 1;
      const body = request.body;
      const input = body instanceof FormData
        ? JSON.parse(String(body.get('item'))) as ItemInput & { clientMutationId?: string }
        : JSON.parse(String(body)) as ItemInput & { clientMutationId?: string };
      itemMutationIds.push(input.clientMutationId);
      if (options.failAddBeforeWrite && !addFailedBeforeWrite) {
        addFailedBeforeWrite = true;
        return jsonResponse({ error: { code: 'UPLOAD_FAILED', message: 'The upload failed before storage.' } }, 500);
      }
      const item: ApiItem = {
        id: `item-${++itemSequence}`,
        batchId: current.id,
        ...input,
        sourceFile: body instanceof FormData ? `items/item-${itemSequence}.svg` : null,
      };
      current = { ...current, items: [...current.items, item] };
      if (options.loseAddResponse && !addResponseLost) {
        addResponseLost = true;
        throw new TypeError('The add response was lost.');
      }
      return jsonResponse(item);
    }
    if (current && url.pathname === `/api/batches/${current.id}/submit` && request?.method === 'POST') {
      submitCount += 1;
      current = batch({ ...current, state: 'QUEUED' });
      return jsonResponse(current);
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(handler, [], () => current?.state === 'DRAFT' ? current : undefined);
  return {
    handler,
    current: () => current,
    counts: () => ({ create: createCount, add: addCount, submit: submitCount, metadataSave: metadataSaveCount }),
    itemMutationIds: () => itemMutationIds,
  };
}

async function openActiveWorkbench(user: ReturnType<typeof userEvent.setup>, label: string): Promise<void> {
  const buttons = await screen.findAllByRole('button', { name: label });
  await user.click(buttons.at(-1)!);
}

afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  getSvgPreviewMock.mockReset();
  putSvgPreviewMock.mockReset();
  getSvgPreviewMock.mockResolvedValue(undefined);
  putSvgPreviewMock.mockResolvedValue(undefined);
  vi.useRealTimers();
});

test('an unauthenticated visitor sees login and creates no local identity record', async () => {
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/auth/me') return Promise.resolve(jsonResponse({ error: { code: 'AUTHENTICATION_REQUIRED', message: '请先登录。' } }, 401));
    if (path === '/api/auth/login') return Promise.resolve(jsonResponse({ user: { id: 'user-designer', username: 'designer@example.invalid' } }));
    if (path === '/api/batches/active') return Promise.resolve(new Response(null, { status: 204 }));
    if (path === '/api/batches?limit=20') return Promise.resolve(jsonResponse([]));
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);

  await screen.findByRole('heading', { name: '登录 PinK 图标工作台' });
  await user.type(screen.getByLabelText(/^账号/), 'designer@example.invalid');
  await user.type(screen.getByLabelText(/^密码/), 'test-password');
  await user.click(screen.getByRole('button', { name: '登录' }));

  await screen.findByRole('heading', { name: '把图标设计交给开发审核' });
  expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST' }));
  expect(window.localStorage.getItem('pink-icon-submit.designer-profile.v1')).toBeNull();
});

test('logout clears the authenticated workbench and returns to the login page', async () => {
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/auth/logout') return Promise.resolve(new Response(null, { status: 204 }));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await screen.findByRole('heading', { name: '把图标设计交给开发审核' });
  await user.click(screen.getByRole('button', { name: '退出登录' }));

  await screen.findByRole('heading', { name: '登录 PinK 图标工作台' });
  expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
});

test('an authorization response from a protected batch route returns to login without exposing the batch', async () => {
  const hidden = summary({ id: 'ICON-AUTH-EXPIRED', title: '不应在失效会话后展示' });
  const fetchMock = vi.fn((path: string) => {
    if (path === `/api/batches/${hidden.id}`) {
      return Promise.resolve(jsonResponse({ error: { code: 'AUTHENTICATION_REQUIRED', message: '请先登录后再继续。' } }, 401));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [hidden]);
  const user = userEvent.setup();

  render(<App />);
  await user.click(await screen.findByRole('button', { name: '查看' }));

  await screen.findByRole('heading', { name: '登录 PinK 图标工作台' });
  expect(screen.queryByText(hidden.title)).toBeNull();
});

test('the expected icon name uses only local checks and never performs a name preview request', async () => {
  saveProfile();
  const fetchMock = vi.fn();
  stubFetch(fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  await addOneSvgChange(user);

  expect(screen.getByLabelText(/^期望图标名称/)).toBeTruthy();
  expect(screen.getByText('最终名称会在开发审核时确认。')).toBeTruthy();
  expect(screen.queryByText(/仓库最终名称预览/)).toBeNull();
  expect(fetchMock.mock.calls.some(([path]) => String(path).includes('/names/preview'))).toBe(false);
});

test('an expected icon name with path characters is rejected locally without a network check', async () => {
  saveProfile();
  const fetchMock = vi.fn();
  stubFetch(fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, svgFile('invalid.svg'));
  await screen.findByRole('button', { name: '选择 invalid.svg' });
  await user.type(screen.getByLabelText(/^期望图标名称/), 'bad/name');
  await user.type(screen.getByLabelText(/^用途说明/), '路径字符必须在浏览器内直接拦截。');
  await user.click(screen.getByRole('button', { name: '加入新增队列' }));

  expect(screen.getByText('期望图标名称不能包含空白或路径分隔符。')).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('replace opens the frozen catalog only when the designer asks for it', async () => {
  saveProfile();
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
    baseCommit: 'a'.repeat(40),
    page: 1,
    pageSize: 24,
    total: 1,
    icons: [{
      primaryName: 'existing',
      aliases: ['existing-alias'],
      group: 'common',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h1v1H0z" /></svg>',
    }],
  }));
  stubFetch(fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  await user.click(screen.getByRole('tab', { name: '替换图标' }));
  expect(fetchMock).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '选择图标' }));
  await screen.findByText('existing');
  expect(fetchMock).toHaveBeenCalledWith('/api/catalog/page?group=all&page=1&pageSize=24', {});
  await user.click(screen.getByRole('button', { name: '选择 existing' }));

  expect(screen.getByRole('img', { name: 'existing 当前图标' })).toBeTruthy();
});

test('a replace target becomes unavailable after it is added to the same batch', async () => {
  saveProfile();
  stubFetch(draftApiHandler({
    baseCommit: 'a'.repeat(40), page: 1, pageSize: 24, total: 1,
    icons: [{ primaryName: 'existing', aliases: ['existing-alias'], group: 'common', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h1v1H0z" /></svg>' }],
  }));
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  await fillBatchMetadata(user);
  await user.click(screen.getByRole('tab', { name: '替换图标' }));
  await user.click(screen.getByRole('button', { name: '选择图标' }));
  await screen.findByText('existing');
  await user.click(screen.getByRole('button', { name: '选择 existing' }));
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, svgFile('replacement.svg'));
  await screen.findByRole('button', { name: '选择 replacement.svg' });
  await user.click(screen.getByRole('button', { name: '加入替换队列' }));
  await user.click(screen.getByRole('button', { name: '选择图标' }));

  const usedTarget = await screen.findByRole('button', { name: 'existing 已用于第 1 项替换' });
  expect((usedTarget as HTMLButtonElement).disabled).toBe(true);
});

test('multiple SVG files stay in the local queue until each is paired with a change', async () => {
  saveProfile();
  stubFetch(draftApiHandler());
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  await fillBatchMetadata(user);
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, [svgFile('one.svg'), svgFile('two.svg')]);
  await screen.findByRole('button', { name: '选择 one.svg' });
  expect(screen.getByRole('button', { name: '选择 two.svg' })).toBeTruthy();
  await user.type(screen.getByLabelText(/^期望图标名称/), 'pink-one');
  await user.type(screen.getByLabelText(/^用途说明/), '第一个图标。');
  await user.click(screen.getByRole('button', { name: '加入新增队列' }));

  expect(screen.getByText('本次变更 1 项')).toBeTruthy();
  expect(screen.getByRole('button', { name: '选择 two.svg' })).toBeTruthy();
});

test('delete only needs a catalog target and a design reason before it enters the queue', async () => {
  saveProfile();
  stubFetch(draftApiHandler({
    baseCommit: 'a'.repeat(40), page: 1, pageSize: 24, total: 1,
    icons: [{ primaryName: 'existing', aliases: ['existing-alias'], group: 'common', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h1v1H0z" /></svg>' }],
  }));
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  await fillBatchMetadata(user);
  await user.click(screen.getByRole('tab', { name: '删除图标' }));
  await user.click(screen.getByRole('button', { name: '选择图标' }));
  await screen.findByText('existing');
  await user.click(screen.getByRole('button', { name: '选择 existing' }));
  await user.type(screen.getByLabelText(/^删除原因/), '旧图标已废弃。');
  await user.click(screen.getByRole('button', { name: '加入删除队列' }));

  expect(screen.getByText('本次变更 1 项')).toBeTruthy();
});

test('the first queued item requires batch fields but design link is optional', async () => {
  saveProfile();
  const fetchMock = vi.fn();
  stubFetch(fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, svgFile('new-icon.svg'));
  await user.type(screen.getByLabelText(/^期望图标名称/), 'pink-new-icon');
  await user.type(screen.getByLabelText(/^用途说明/), '用于测试新增图标的设计稿。');
  await user.click(screen.getByRole('button', { name: '加入新增队列' }));

  expect(screen.getByText('请填写本次变更标题。')).toBeTruthy();
  expect(screen.getByText('请填写整体需求说明。')).toBeTruthy();
  expect(screen.queryByText('请填写有效的 HTTP(S) 设计稿链接。')).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('the first queued item rejects a malformed optional design link before it creates a batch', async () => {
  saveProfile();
  const fetchMock = vi.fn();
  stubFetch(fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  await fillBatchMetadata(user, 'https:www.123.com');
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, svgFile('new-icon.svg'));
  await user.type(screen.getByLabelText(/^期望图标名称/), 'pink-new-icon');
  await user.type(screen.getByLabelText(/^用途说明/), '用于测试新增图标的设计稿。');
  await user.click(screen.getByRole('button', { name: '加入新增队列' }));

  expect(screen.getByText('请填写有效的 HTTP(S) 设计稿链接。')).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('confirmation closes review, queues a DRAFT batch, and makes no preview or interactive validation request', async () => {
  saveProfile();
  const draft = batch({ items: [] });
  const item = { id: 'item-1', batchId: draft.id, action: 'add' as const, designName: 'pink-new-icon', description: '用于测试新增图标的设计稿。', sourceFile: 'items/item-1.svg' };
  const queued = batch({ id: draft.id, state: 'QUEUED', items: [item] });
  const fetchMock = vi.fn((path: string, _options?: RequestInit) => {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/batches') return Promise.resolve(jsonResponse(draft));
    if (url.pathname === `/api/batches/${draft.id}/items`) return Promise.resolve(jsonResponse(item));
    if (url.pathname === `/api/batches/${draft.id}` && _options?.method === 'PUT') return Promise.resolve(jsonResponse({ ...draft, items: [item] }));
    if (url.pathname === `/api/batches/${draft.id}/submit`) return Promise.resolve(jsonResponse(queued));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  await addOneSvgChange(user);
  await openReview(user);
  await user.click(screen.getByRole('button', { name: '确认提交' }));

  expect(screen.queryByRole('dialog', { name: '让开发准确理解这次设计' })).toBeNull();
  await screen.findByRole('heading', { name: '已提交' });
  expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
    '/api/batches',
    `/api/batches/${draft.id}/items`,
    `/api/batches/${draft.id}`,
    `/api/batches/${draft.id}/submit`,
  ]);
  const createOptions = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect(JSON.parse(createOptions.body as string)).toMatchObject({ title: '模型入口图标', description: '新增模型入口图标。' });
  expect(JSON.parse(createOptions.body as string)).not.toHaveProperty('designUrl');
  expect(fetchMock.mock.calls.some(([path]) => String(path).includes('/validate') || String(path).includes('/names/preview'))).toBe(false);
});

test('a final validation failure shows Chinese diagnostics and can return to editing', async () => {
  saveProfile();
  const failed = batch({
    id: 'ICON-INVALID',
    state: 'FAILED',
    validation: { valid: false, errors: [{ code: 'SVG_MULTIPLE_COLORS', message: 'SVG contains more than one literal paint color.', itemId: 'item-1' }], warnings: [] },
    items: [{ id: 'item-1', batchId: 'ICON-INVALID', action: 'add', designName: 'pink-new-icon', description: '需要改为单色。', sourceFile: 'items/item-1.svg' }],
    error: { code: 'FINAL_VALIDATION_FAILED', message: 'Final validation failed.' },
  });
  const draft = batch({ id: failed.id, state: 'DRAFT', items: failed.items, validation: failed.validation, userStatus: 'needs_changes' });
  const fetchMock = vi.fn((path: string, _options?: RequestInit) => {
    if (path === '/api/batches/ICON-INVALID') return Promise.resolve(jsonResponse(failed));
    if (path === '/api/batches/ICON-INVALID/return-to-edit') return Promise.resolve(jsonResponse(draft));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [], failed);
  const user = userEvent.setup();

  render(<App />);
  await openActiveWorkbench(user, '返回修改');

  await screen.findByRole('heading', { name: '需要修改' });
  expect(screen.getByText('本次变更 1 项')).toBeTruthy();
  expect(screen.getByText('SVG 已保存')).toBeTruthy();
  expect(screen.getByText('图标包含多种颜色')).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith('/api/batches/ICON-INVALID/return-to-edit', { method: 'POST' });
});

test('a refreshed DRAFT batch restores server items as removable changes', async () => {
  saveProfile();
  const item = {
    id: 'item-restore',
    batchId: 'ICON-RESTORE',
    action: 'add' as const,
    designName: 'pink-restored-icon',
    description: 'Restored from the server after a refresh.',
    sourceFile: 'items/item-restore.svg',
  };
  const restored = batch({ id: 'ICON-RESTORE', items: [item] });
  const fetchMock = vi.fn((path: string, options?: RequestInit) => {
    if (path === '/api/batches/ICON-RESTORE') return Promise.resolve(jsonResponse(restored));
    if (path === '/api/batches/ICON-RESTORE/items/item-restore' && options?.method === 'DELETE') return Promise.resolve(jsonResponse(undefined, 204));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [], restored);
  const user = userEvent.setup();

  render(<App />);
  await openActiveWorkbench(user, '继续编辑');

  await screen.findByText('本次变更 1 项');
  expect(screen.getByText('SVG 已保存')).toBeTruthy();
  expect((screen.getByRole('button', { name: '确认本次变更' }) as HTMLButtonElement).disabled).toBe(false);
  await user.click(screen.getByRole('button', { name: '移除 pink-restored-icon' }));

  await screen.findByText('本次变更 0 项');
  expect(fetchMock).toHaveBeenCalledWith('/api/batches/ICON-RESTORE/items/item-restore', { method: 'DELETE' });
});

test('an infrastructure failure offers a manual delivery retry without exposing infrastructure details as the main message', async () => {
  saveProfile();
  const failed = batch({
    id: 'ICON-RETRY',
    executionMode: 'remote',
    state: 'FAILED',
    delivery: delivery({ checkpoint: 'COMMIT_PREPARED', commitSha: 'a'.repeat(40) }),
    error: { code: 'GIT_COMMAND_FAILED', message: 'git push exited with 128.' },
  });
  const queued = batch({ id: failed.id, executionMode: 'remote', state: 'QUEUED', delivery: failed.delivery });
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/batches/ICON-RETRY') return Promise.resolve(jsonResponse(failed));
    if (path === '/api/batches/ICON-RETRY/retry') return Promise.resolve(jsonResponse(queued));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [], failed);
  const user = userEvent.setup();

  render(<App />);
  await openActiveWorkbench(user, '恢复交付');
  await screen.findByRole('heading', { name: '交付暂时失败' });
  expect(screen.getByText('本次交付暂未完成。确认技术问题后可手动重新尝试，不会自动重复交付。')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '重新尝试交付' }));

  await screen.findByRole('heading', { name: '已提交' });
  expect(fetchMock).toHaveBeenCalledWith('/api/batches/ICON-RETRY/retry', { method: 'POST' });
});

test('abandonment releases the workbench even when an older processing poll resolves afterwards', async () => {
  saveProfile();
  const active = batch({
    id: 'ICON-ABANDON-POLL',
    executionMode: 'remote',
    state: 'QUEUED',
    userStatus: 'processing',
    canAbandon: true,
  });
  const abandoned = batch({
    ...active,
    state: 'ABANDONED',
    userStatus: 'abandoned',
    canAbandon: false,
    error: { code: 'BATCH_ABANDONED', message: 'The submitter abandoned this unsubmitted batch.' },
  });
  const stalePoll = deferred<Response>();
  const abandonResponse = deferred<Response>();
  const pollRegistered = deferred<void>();
  const pollStarted = deferred<void>();
  let poll: (() => void) | undefined;
  let reads = 0;
  vi.spyOn(window, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number) => {
    if (delay === 1_500) {
      poll = callback as () => void;
      pollRegistered.resolve();
    }
    return 1 as unknown as number;
  }) as typeof window.setInterval);
  vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);
  const fetchMock = vi.fn((path: string, options?: RequestInit) => {
    if (path === '/api/batches/' + active.id) {
      reads += 1;
      if (reads === 1) return Promise.resolve(jsonResponse(active));
      pollStarted.resolve();
      return stalePoll.promise;
    }
    if (path === '/api/batches/' + active.id + '/abandon' && options?.method === 'POST') return abandonResponse.promise;
    throw new Error('Unexpected request: ' + path);
  });
  stubFetch(fetchMock, [summary({ id: active.id, title: active.title, userStatus: 'processing' })], active);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();

  render(<App />);
  await pollRegistered.promise;
  await openActiveWorkbench(user, '查看处理中');
  await screen.findByRole('button', { name: '放弃未交付批次' });
  await act(async () => {
    poll!();
    await pollStarted.promise;
  });

  await user.click(screen.getByRole('button', { name: '放弃未交付批次' }));
  abandonResponse.resolve(jsonResponse(abandoned));
  await screen.findByText('已放弃未交付批次，可以重新创建图标变更。');
  expect(screen.getByRole('button', { name: '新建图标变更' })).toBeTruthy();
  expect((screen.getByRole('button', { name: '返回首页' }) as HTMLButtonElement).disabled).toBe(false);

  await act(async () => {
    stalePoll.resolve(jsonResponse(active));
    await Promise.resolve();
  });
  expect(window.location.pathname).toBe('/');
  expect(screen.getByRole('button', { name: '新建图标变更' })).toBeTruthy();
});

test('a 409 abandonment response refreshes the current batch instead of leaving stale controls disabled', async () => {
  saveProfile();
  const queued = batch({
    id: 'ICON-ABANDON-409',
    executionMode: 'remote',
    state: 'QUEUED',
    userStatus: 'processing',
    canAbandon: true,
  });
  const running = batch({
    ...queued,
    state: 'RUNNING',
    userStatus: 'processing',
    canAbandon: false,
  });
  let reads = 0;
  const fetchMock = vi.fn((path: string, options?: RequestInit) => {
    if (path === '/api/batches/' + queued.id) {
      reads += 1;
      return Promise.resolve(jsonResponse(reads === 1 ? queued : running));
    }
    if (path === '/api/batches/' + queued.id + '/abandon' && options?.method === 'POST') {
      return Promise.resolve(jsonResponse({ error: { code: 'BATCH_NOT_ABANDONABLE', message: 'The worker already claimed this batch.' } }, 409));
    }
    throw new Error('Unexpected request: ' + path);
  });
  stubFetch(fetchMock, [summary({ id: queued.id, title: queued.title, userStatus: 'processing' })], queued);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();

  render(<App />);
  await openActiveWorkbench(user, '查看处理中');
  await screen.findByRole('button', { name: '放弃未交付批次' });
  await user.click(screen.getByRole('button', { name: '放弃未交付批次' }));

  await screen.findByRole('heading', { name: '正在最终校验' });
  expect(screen.getByText('批次状态已变化，无法放弃未交付批次。')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '放弃未交付批次' })).toBeNull();
  expect((screen.getByRole('button', { name: '返回首页' }) as HTMLButtonElement).disabled).toBe(false);
  expect(window.location.pathname).toBe('/workbench');
  expect(fetchMock).toHaveBeenCalledWith('/api/batches/' + queued.id + '/abandon', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
});

test('the server-approved DRAFT plus failed-job compatibility state exposes abandonment', async () => {
  saveProfile();
  const draft = batch({
    id: 'ICON-ABANDON-DRAFT',
    executionMode: 'remote',
    state: 'DRAFT',
    userStatus: 'draft',
    canAbandon: true,
  });
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/batches/' + draft.id) return Promise.resolve(jsonResponse(draft));
    throw new Error('Unexpected request: ' + path);
  });
  stubFetch(fetchMock, [], draft);
  const user = userEvent.setup();

  render(<App />);
  await openActiveWorkbench(user, '继续编辑');
  expect(await screen.findByRole('button', { name: '放弃未交付批次' })).toBeTruthy();
});

test('delivery evidence does not expose abandonment controls', async () => {
  saveProfile();
  const pushed = batch({
    id: 'ICON-ABANDON-PUSHED',
    executionMode: 'remote',
    state: 'FAILED',
    userStatus: 'delivery_retryable',
    delivery: delivery({ checkpoint: 'BRANCH_PUSHED', branch: 'bot/ICON-ABANDON-PUSHED', commitSha: 'a'.repeat(40) }),
    error: { code: 'GIT_COMMAND_FAILED', message: 'Draft PR creation failed.' },
    canAbandon: false,
  });
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/batches/' + pushed.id) return Promise.resolve(jsonResponse(pushed));
    throw new Error('Unexpected request: ' + path);
  });
  stubFetch(fetchMock, [], pushed);
  const user = userEvent.setup();

  render(<App />);
  await openActiveWorkbench(user, '恢复交付');
  await screen.findByRole('heading', { name: '分支已推送，Draft PR 创建失败' });
  expect(screen.queryByRole('button', { name: '放弃未交付批次' })).toBeNull();
});

test('abandoned history remains read-only without abandonment controls', async () => {
  saveProfile();
  const abandoned = batch({
    id: 'ICON-ABANDONED-HISTORY',
    executionMode: 'remote',
    state: 'ABANDONED',
    userStatus: 'abandoned',
    canAbandon: false,
    error: { code: 'BATCH_ABANDONED', message: 'The submitter abandoned this unsubmitted batch.' },
  });
  window.history.replaceState({}, '', '/workbench?batch=' + abandoned.id);
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/batches/' + abandoned.id) return Promise.resolve(jsonResponse(abandoned));
    throw new Error('Unexpected request: ' + path);
  });
  stubFetch(fetchMock);

  render(<App />);
  await screen.findByRole('heading', { name: '本次变更已放弃' });
  expect(screen.getByText('未创建 commit、push 或 Draft PR。设计记录保留在历史中，仅供查看。')).toBeTruthy();
  expect(screen.queryByText('正在查看历史批次。')).toBeNull();
  expect(screen.queryByText('这是历史批次，仅供查看。')).toBeNull();
  expect(screen.queryByRole('button', { name: '放弃未交付批次' })).toBeNull();
  expect(screen.queryByRole('button', { name: '继续编辑' })).toBeNull();
  expect(screen.queryByRole('button', { name: /重新尝试/ })).toBeNull();
});

test('a refreshed pushed branch failure offers a Draft PR-only retry', async () => {
  saveProfile();
  const failed = batch({
    id: 'ICON-PR-RETRY',
    executionMode: 'remote',
    state: 'FAILED',
    baseCommit: 'b'.repeat(40),
    delivery: delivery({ checkpoint: 'BRANCH_PUSHED', branch: 'bot/ICON-PR-RETRY', commitSha: 'a'.repeat(40) }),
    error: { code: 'GIT_COMMAND_FAILED', message: 'Target fetch failed before Draft PR creation.' },
  });
  const queued = batch({ id: failed.id, executionMode: 'remote', state: 'QUEUED', delivery: failed.delivery });
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/batches/ICON-PR-RETRY') return Promise.resolve(jsonResponse(failed));
    if (path === '/api/batches/ICON-PR-RETRY/retry') return Promise.resolve(jsonResponse(queued));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [], failed);
  const user = userEvent.setup();

  render(<App />);
  await openActiveWorkbench(user, '恢复交付');

  await screen.findByRole('heading', { name: '分支已推送，Draft PR 创建失败' });
  expect(screen.getByText('图标变更已安全推送。你可以仅重新尝试创建 Draft PR，不会重新提交图标变更。')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '重新尝试交付' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '重新尝试创建 Draft PR' }));

  await screen.findByRole('heading', { name: '已提交' });
  expect(fetchMock).toHaveBeenCalledWith('/api/batches/ICON-PR-RETRY/retry', { method: 'POST' });
});

test.each([
  'FINAL_VALIDATION_FAILED',
  'TARGET_BASE_ADVANCED',
  'PR_BRANCH_ALREADY_EXISTS',
  'REMOTE_BRANCH_DIVERGED',
  'WORKER_UNEXPECTED',
])('a refreshed non-recoverable post-push failure %s requires developer handling', async (errorCode) => {
  saveProfile();
  window.history.replaceState({}, '', `/workbench?batch=ICON-NO-RETRY-${errorCode}`);
  const failed = batch({
    id: `ICON-NO-RETRY-${errorCode}`,
    executionMode: 'remote',
    state: 'FAILED',
    baseCommit: 'b'.repeat(40),
    delivery: delivery({ checkpoint: 'BRANCH_PUSHED', branch: `bot/ICON-NO-RETRY-${errorCode}`, commitSha: 'a'.repeat(40) }),
    error: { code: errorCode, message: `Non-recoverable ${errorCode}.` },
  });
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(failed));
  stubFetch(fetchMock);
  render(<App />);

  await screen.findByRole('heading', { name: 'Draft PR 创建无法自动恢复' });
  expect(screen.getByText('当前交付状态需要开发处理；平台不会重新提交图标变更。')).toBeTruthy();
  expect(screen.getByText(errorCode)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '重新尝试创建 Draft PR' })).toBeNull();
  expect(screen.queryByRole('button', { name: '重新尝试交付' })).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('a refreshed post-push failure with missing recovery evidence requires developer handling', async () => {
  saveProfile();
  window.history.replaceState({}, '', '/workbench?batch=ICON-NO-EVIDENCE');
  const failed = batch({
    id: 'ICON-NO-EVIDENCE',
    executionMode: 'remote',
    state: 'FAILED',
    baseCommit: null,
    delivery: delivery({ checkpoint: 'BRANCH_PUSHED', branch: 'bot/ICON-NO-EVIDENCE', commitSha: 'a'.repeat(40) }),
    error: { code: 'GIT_COMMAND_FAILED', message: 'Target fetch failed before Draft PR creation.' },
    userStatus: 'developer_attention',
  });
  stubFetch(vi.fn().mockResolvedValue(jsonResponse(failed)));
  render(<App />);

  await screen.findByRole('heading', { name: 'Draft PR 创建无法自动恢复' });
  expect(screen.getByText('当前交付状态需要开发处理；平台不会重新提交图标变更。')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '重新尝试创建 Draft PR' })).toBeNull();
  expect(screen.queryByRole('button', { name: '重新尝试交付' })).toBeNull();
});

test('unchanged final-validation failures need an explicit confirmation before resubmission', async () => {
  saveProfile();
  const draft = batch({ items: [] });
  const item = { id: 'item-1', batchId: draft.id, action: 'add' as const, designName: 'pink-new-icon', description: '用于测试新增图标的设计稿。', sourceFile: 'items/item-1.svg' };
  const queued = batch({ id: draft.id, state: 'QUEUED', items: [item] });
  let submitCount = 0;
  const fetchMock = vi.fn((path: string, _options?: RequestInit) => {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/batches') return Promise.resolve(jsonResponse(draft));
    if (url.pathname === `/api/batches/${draft.id}/items`) return Promise.resolve(jsonResponse(item));
    if (url.pathname === `/api/batches/${draft.id}` && _options?.method === 'PUT') return Promise.resolve(jsonResponse({ ...draft, items: [item] }));
    if (url.pathname === `/api/batches/${draft.id}/submit`) {
      submitCount += 1;
      return submitCount === 1
        ? Promise.resolve(jsonResponse({ error: { code: 'REPEATED_SUBMISSION_CONFIRMATION_REQUIRED', message: 'Confirm unchanged submission.' } }, 409))
        : Promise.resolve(jsonResponse(queued));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  await addOneSvgChange(user);
  await openReview(user);
  await user.click(screen.getByRole('button', { name: '确认提交' }));
  await screen.findByRole('button', { name: '仍要按原内容再次提交' });
  await user.click(screen.getByRole('button', { name: '仍要按原内容再次提交' }));

  await screen.findByRole('heading', { name: '已提交' });
  const submitCalls = fetchMock.mock.calls.filter(([path]) => path === `/api/batches/${draft.id}/submit`);
  expect(submitCalls).toHaveLength(2);
  expect(JSON.parse((submitCalls[1]?.[1] as RequestInit).body as string)).toEqual({ confirmRepeatedSubmission: true });
});

test('a failed second item save preserves the first item and retries only the unsaved item', async () => {
  saveProfile();
  const batchId = 'ICON-PARTIAL';
  const serverItems: Array<{
    id: string;
    batchId: string;
    action: 'add';
    designName: string;
    description: string;
    sourceFile: string;
  }> = [];
  let failSecondCreate = true;
  const snapshot = (state: BatchDetails['state'] = 'DRAFT') => batch({ id: batchId, state, items: [...serverItems] });
  const itemFromRequest = (options: RequestInit | undefined) => {
    const body = options?.body;
    if (!(body instanceof FormData)) throw new Error('Expected the SVG item request to use multipart form data.');
    return JSON.parse(String(body.get('item'))) as { action: 'add'; designName: string; description: string };
  };
  const fetchMock = vi.fn((path: string, options?: RequestInit) => {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/batches' && options?.method === 'POST') return Promise.resolve(jsonResponse(snapshot()));
    if (url.pathname === `/api/batches/${batchId}` && options?.method === 'PUT') return Promise.resolve(jsonResponse(snapshot()));
    if (url.pathname === `/api/batches/${batchId}`) return Promise.resolve(jsonResponse(snapshot()));
    if (url.pathname === `/api/batches/${batchId}/items` && options?.method === 'POST') {
      const input = itemFromRequest(options);
      if (serverItems.length === 1 && failSecondCreate) {
        failSecondCreate = false;
        return Promise.resolve(jsonResponse({ error: { code: 'UPLOAD_FAILED', message: 'The second upload failed.' } }, 500));
      }
      const item = {
        id: `item-${serverItems.length + 1}`,
        batchId,
        action: 'add' as const,
        designName: input.designName,
        description: input.description,
        sourceFile: `items/item-${serverItems.length + 1}.svg`,
      };
      serverItems.push(item);
      return Promise.resolve(jsonResponse(item));
    }
    if (url.pathname === `/api/batches/${batchId}/items/item-1` && options?.method === 'PUT') {
      return Promise.resolve(jsonResponse(serverItems[0]));
    }
    if (url.pathname === `/api/batches/${batchId}/submit` && options?.method === 'POST') return Promise.resolve(jsonResponse(snapshot('QUEUED')));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  await addOneSvgChange(user);
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, svgFile('second-icon.svg'));
  await screen.findByRole('button', { name: '选择 second-icon.svg' });
  await user.type(screen.getByLabelText(/^期望图标名称/), 'pink-second-icon');
  await user.type(screen.getByLabelText(/^用途说明/), '第二项用于验证部分上传失败后的服务端对账。');
  await user.click(screen.getByRole('button', { name: '加入新增队列' }));

  await screen.findByText('草稿保存失败：The second upload failed.');
  expect(serverItems).toHaveLength(1);
  expect(serverItems[0]?.designName).toBe('pink-new-icon');
  expect(screen.getByText('本次变更 1 项')).toBeTruthy();
  expect((screen.getByLabelText(/^期望图标名称/) as HTMLInputElement).value).toBe('pink-second-icon');

  await user.click(screen.getByRole('button', { name: '加入新增队列' }));
  await screen.findByText('本次变更 2 项');
  await openReview(user);
  await user.click(screen.getByRole('button', { name: '确认提交' }));

  await screen.findByRole('heading', { name: '已提交' });
  expect(serverItems).toHaveLength(2);
  expect(serverItems.map((item) => item.id)).toEqual(['item-1', 'item-2']);
  expect(serverItems.map((item) => item.designName)).toEqual(['pink-new-icon', 'pink-second-icon']);
});

test('a restored local result never promises a Draft PR', async () => {
  saveProfile();
  window.history.replaceState({}, '', '/workbench?batch=ICON-LOCAL');
  const local = batch({
    id: 'ICON-LOCAL',
    state: 'LOCAL_DIFF_READY',
    localDiff: { changedFiles: ['src/icons/pink-new-icon.svg'], patch: '' },
  });
  stubFetch(vi.fn().mockResolvedValue(jsonResponse(local)));
  render(<App />);

  await screen.findByRole('heading', { name: '本地预览已完成' });
  expect(screen.getByText('此模式不会创建 PR。')).toBeTruthy();
  expect(screen.queryByText('正在创建 Draft PR')).toBeNull();
});

test.each([
  ['生成 commit', batch({ id: 'ICON-COMMITTING', executionMode: 'remote', state: 'RUNNING', validation: { valid: true, errors: [], warnings: [] }, job: { state: 'RUNNING' } }), '正在生成交付 commit', '最终校验已通过，正在生成本次交付 commit。'],
  ['推送分支', batch({ id: 'ICON-PUSHING', executionMode: 'remote', state: 'COMMIT_PREPARED', delivery: delivery({ checkpoint: 'COMMIT_PREPARED', branch: 'bot/ICON-PUSHING', commitSha: 'a'.repeat(40) }), job: { state: 'RUNNING' } }), '正在推送交付分支', '已生成交付 commit，正在推送专用分支。'],
  ['创建 Draft PR 前', batch({ id: 'ICON-BRANCH', executionMode: 'remote', state: 'BRANCH_PUSHED', delivery: delivery({ checkpoint: 'BRANCH_PUSHED', branch: 'bot/ICON-BRANCH', commitSha: 'a'.repeat(40) }), job: { state: 'RUNNING' } }), '分支已推送，正在创建 Draft PR', '图标变更已推送，正在创建 Draft PR。'],
  ['创建 Draft PR', batch({ id: 'ICON-PR-CREATING', executionMode: 'remote', state: 'PR_CREATING', delivery: delivery({ checkpoint: 'PR_CREATING', branch: 'bot/ICON-PR-CREATING', commitSha: 'a'.repeat(40) }), job: { state: 'RUNNING' } }), 'Draft PR 创建中', '正在向 GitHub 创建 Draft PR；请勿重复提交。'],
  ['只交付分支', batch({ id: 'ICON-BRANCH-COMPLETE', executionMode: 'remote', state: 'BRANCH_PUSHED', delivery: delivery({ checkpoint: 'BRANCH_PUSHED', branch: 'bot/ICON-BRANCH-COMPLETE', commitSha: 'a'.repeat(40) }), job: { state: 'COMPLETED' } }), '分支已推送', '交付分支已推送；当前批次尚未创建 Draft PR。'],
])('a remote delivery checkpoint shows the specific user-facing stage: %s', async (_name, inProgress, headline, description) => {
  saveProfile();
  stubFetch(vi.fn(() => Promise.resolve(jsonResponse(inProgress))), [], inProgress);
  const user = userEvent.setup();

  render(<App />);
  await openActiveWorkbench(user, '查看处理中');

  await screen.findByRole('heading', { name: headline });
  expect(screen.getByText(description)).toBeTruthy();
  expect(screen.queryByText(/bot\/ICON/)).toBeNull();
});
test('a restored PR-created batch shows the Draft PR handoff link', async () => {
  saveProfile();
  window.history.replaceState({}, '', '/workbench?batch=ICON-PR');
  const completed = batch({
    id: 'ICON-PR',
    executionMode: 'remote',
    state: 'PR_CREATED',
    delivery: delivery({
      checkpoint: 'PR_CREATED',
      pullRequest: { number: 42, url: 'https://github.example.invalid/pull/42', state: 'open', isDraft: true, createdAt: '2026-08-10T00:00:00.000Z' },
      handoffAt: '2026-08-10T00:00:00.000Z',
    }),
  });
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completed));
  stubFetch(fetchMock);
  render(<App />);

  const link = await screen.findByRole('link', { name: '打开开发审核记录' });
  expect(link.getAttribute('href')).toBe('https://github.example.invalid/pull/42');
  expect(screen.queryByRole('button', { name: '基于此新建批次' })).toBeNull();
  expect(fetchMock).toHaveBeenCalledWith('/api/batches/ICON-PR', {});
});

test('home lists internal recent batches with user-facing status and action counts', async () => {
  saveProfile();
  stubFetch(vi.fn(), [
    summary({ id: 'ICON-DRAFT', title: '草稿图标', userStatus: 'draft', itemCounts: { total: 1, add: 1, replace: 0, delete: 0 } }),
    summary({ id: 'ICON-RUNNING', title: '处理中图标', userStatus: 'processing', itemCounts: { total: 1, add: 0, replace: 1, delete: 0 } }),
    summary({ id: 'ICON-VALIDATION', title: '需要修改图标', userStatus: 'needs_changes' }),
    summary({ id: 'ICON-RETRY', title: '可恢复交付', userStatus: 'delivery_retryable' }),
    summary({ id: 'ICON-DEVELOPER', title: '开发处理', userStatus: 'developer_attention' }),
    summary({ id: 'ICON-PR', title: '已交开发审核', userStatus: 'submitted_review', itemCounts: { total: 2, add: 1, replace: 0, delete: 1 } }),
  ]);

  renderBase(<App />);

  await screen.findByRole('heading', { name: '最近 20 条批次' });
  await screen.findAllByText(/新增 1/);
  expect(screen.queryByText(/不按设计师账号隔离/)).toBeNull();
  expect(screen.getAllByText(/新增 1/).length).toBeGreaterThan(0);
  expect(screen.getByText(/替换 1/)).toBeTruthy();
  expect(screen.getByText('需要修改')).toBeTruthy();
  expect(screen.getByText('交付暂时失败')).toBeTruthy();
  expect(screen.getByText('需要开发处理')).toBeTruthy();
  expect(screen.getByText('已提交开发审核')).toBeTruthy();
  expect(screen.queryByText(/bot\/ICON/)).toBeNull();
});

test.each([
  ['草稿', batch({ state: 'DRAFT' }), '继续编辑'],
  ['排队中', batch({ state: 'QUEUED' }), '查看处理中'],
  ['运行中', batch({ state: 'RUNNING' }), '查看处理中'],
  ['提交准备中', batch({ state: 'COMMIT_PREPARED' }), '查看处理中'],
  ['分支交付中', batch({ executionMode: 'remote', state: 'BRANCH_PUSHED', delivery: delivery({ checkpoint: 'BRANCH_PUSHED', branch: 'bot/ICON-TEST', commitSha: 'a'.repeat(40) }) }), '查看处理中'],
  ['最终校验待修改', batch({ state: 'FAILED', validation: { valid: false, errors: [], warnings: [] } }), '返回修改'],
  ['可人工恢复的失败', batch({ state: 'FAILED', error: { code: 'GIT_COMMAND_FAILED', message: 'Retry manually.' } }), '恢复交付'],
])('an active %s batch replaces the new-work entry using the server-owned activity state', async (_name, active, actionLabel) => {
  saveProfile();
  const fetchMock = vi.fn((path: string) => {
    if (path === `/api/batches/${active.id}`) return Promise.resolve(jsonResponse(active));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [], active);

  render(<App />);

  await screen.findAllByRole('button', { name: actionLabel });
  expect(screen.queryByRole('button', { name: '新建图标变更' })).toBeNull();
});

test('an active batch blocks a different history record but can reopen itself', async () => {
  saveProfile();
  const active = batch({ id: 'ICON-ACTIVE-LOCK', title: '当前草稿' });
  const historical = batch({ id: 'ICON-HISTORY-OTHER', title: '其他历史', state: 'PR_CREATED', delivery: delivery({ checkpoint: 'PR_CREATED' }) });
  const fetchMock = vi.fn((path: string) => {
    if (path === `/api/batches/${active.id}`) return Promise.resolve(jsonResponse(active));
    if (path === `/api/batches/${historical.id}`) return Promise.resolve(jsonResponse(historical));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [summary({ id: active.id, title: active.title }), summary({ id: historical.id, title: historical.title, userStatus: 'submitted_review' })], active);
  const user = userEvent.setup();

  render(<App />);
  const historyButtons = await screen.findAllByRole('button', { name: '查看' });
  await user.click(historyButtons[1]!);
  expect(screen.getByRole('status').textContent).toBe('请先完成当前批次。');
  expect(fetchMock).not.toHaveBeenCalledWith(`/api/batches/${historical.id}`, {});

  await user.click(historyButtons[0]!);
  await screen.findByRole('heading', { name: '完成设计，交给开发' });
});

test('a historical DRAFT record is read-only and never becomes the browser active batch', async () => {
  saveProfile();
  const historical = batch({ id: 'ICON-HISTORY-DRAFT', title: '历史草稿' });
  const fetchMock = vi.fn((path: string) => {
    if (path === `/api/batches/${historical.id}`) return Promise.resolve(jsonResponse(historical));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [summary({ id: historical.id, title: historical.title })]);
  const user = userEvent.setup();

  render(<App />);
  await user.click(await screen.findByRole('button', { name: '查看' }));

  await screen.findByText('这是历史批次，仅供查看。');
  expect((screen.getByLabelText(/^期望图标名称/) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: '确认本次变更' }) as HTMLButtonElement).disabled).toBe(true);
});

test('a historical item without SVG content hides internal upload paths and uses a preview placeholder', async () => {
  saveProfile();
  const historical = batch({
    id: 'ICON-HISTORY-NO-SVG',
    title: '历史新增图标',
    items: [{
      id: 'item-history-no-svg',
      batchId: 'ICON-HISTORY-NO-SVG',
      action: 'add',
      designName: 'pink-history-icon',
      description: '历史记录不再保存可渲染 SVG 内容。',
      sourceFile: 'uploads/item-history-no-svg-4b10a4c8.svg',
    }],
  });
  const fetchMock = vi.fn((path: string) => {
    if (path === `/api/batches/${historical.id}`) return Promise.resolve(jsonResponse(historical));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [summary({ id: historical.id, title: historical.title })]);
  const user = userEvent.setup();

  render(<App />);
  await user.click(await screen.findByRole('button', { name: '查看' }));

  expect(await screen.findByText('SVG 预览不可用')).toBeTruthy();
  expect(screen.getByText('新增 · pink-history-icon')).toBeTruthy();
  expect(screen.queryByText(/uploads\/item-history-no-svg/)).toBeNull();
  expect(document.querySelector('.change-card.no-preview')).toBeTruthy();
  expect(document.querySelector('.change-card img')).toBeNull();
});
test('a historical item uses this browser cache for its SVG preview', async () => {
  saveProfile();
  const historical = batch({
    id: 'ICON-HISTORY-CACHED-SVG',
    title: '带本地预览的历史图标',
    items: [{
      id: 'item-history-cached-svg',
      batchId: 'ICON-HISTORY-CACHED-SVG',
      action: 'add',
      designName: 'pink-cached-history-icon',
      description: '本机缓存的 SVG 预览。',
      sourceFile: 'uploads/private.svg',
    }],
  });
  getSvgPreviewMock.mockResolvedValue(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" />'], { type: 'image/svg+xml' }));
  const originalUrl = URL;
  vi.stubGlobal('URL', Object.assign(class extends originalUrl {}, {
    createObjectURL: vi.fn(() => 'blob:cached-history-svg'),
    revokeObjectURL: vi.fn(),
  }));
  stubFetch(vi.fn((path: string) => {
    if (path === `/api/batches/${historical.id}`) return Promise.resolve(jsonResponse(historical));
    throw new Error(`Unexpected request: ${path}`);
  }), [summary({ id: historical.id, title: historical.title })]);
  const user = userEvent.setup();

  render(<App />);
  await user.click(await screen.findByRole('button', { name: '查看' }));

  expect(await screen.findByAltText('pink-cached-history-icon SVG 预览')).toBeTruthy();
  expect(getSvgPreviewMock).toHaveBeenCalledWith('user-designer', historical.id, 'item-history-cached-svg');
  expect(screen.queryByText('SVG 预览不可用')).toBeNull();
  expect(screen.queryByText(/uploads\/private/)).toBeNull();
});

test('an uploaded SVG cache failure does not block saving the draft item', async () => {
  saveProfile();
  putSvgPreviewMock.mockRejectedValueOnce(new Error('Storage quota exceeded.'));
  stubFetch(draftApiHandler());
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  await addOneSvgChange(user);

  await screen.findByText('已保存到当前草稿。其余 SVG 会继续保留在待处理队列。');
  await waitFor(() => expect(putSvgPreviewMock).toHaveBeenCalledWith(
    'user-designer',
    'ICON-DRAFT',
    'item-1',
    expect.any(File),
  ));
});

test('leaving a workbench clears local SVG and catalog selection state before a legal new batch', async () => {
  saveProfile();
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
    baseCommit: 'a'.repeat(40), page: 1, pageSize: 24, total: 1,
    icons: [{ primaryName: 'existing', aliases: [], group: 'common', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h1v1H0z" /></svg>' }],
  }));
  stubFetch(fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, svgFile('transient.svg'));
  await screen.findByRole('button', { name: '选择 transient.svg' });
  await user.click(screen.getByRole('tab', { name: '替换图标' }));
  await user.click(screen.getByRole('button', { name: '选择图标' }));
  await user.click(await screen.findByRole('button', { name: '选择 existing' }));
  await user.click(screen.getByRole('button', { name: '返回首页' }));
  await screen.findByRole('heading', { name: '把图标设计交给开发审核' });
  await openNewWorkbench(user);

  expect(screen.queryByRole('button', { name: '选择 transient.svg' })).toBeNull();
  await user.click(screen.getByRole('tab', { name: '替换图标' }));
  expect(screen.getByRole('button', { name: '选择图标' })).toBeTruthy();
  expect(screen.queryByText(/已选择 existing/)).toBeNull();
});

test('an invalid workbench URL falls back home and a URL history record cannot replace an active batch', async () => {
  saveProfile();
  const active = batch({ id: 'ICON-URL-ACTIVE', title: 'URL 当前批次' });
  window.history.replaceState({}, '', '/workbench?batch=ICON-URL-HISTORY');
  const fetchMock = vi.fn((path: string) => {
    if (path === `/api/batches/${active.id}`) return Promise.resolve(jsonResponse(active));
    if (path === '/api/batches/ICON-URL-HISTORY') throw new Error('The active batch must block this history read.');
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [], active);

  render(<App />);
  await screen.findByText('请先完成当前批次。');
  expect(`${window.location.pathname}${window.location.search}`).toBe('/');
  expect(fetchMock).not.toHaveBeenCalledWith('/api/batches/ICON-URL-HISTORY', {});
});

test('an invalid workbench batch URL returns home without using a stale browser activity value', async () => {
  saveProfile();
  window.localStorage.setItem('pink-icon-submit.active-batch.v1', 'ICON-MISSING');
  window.history.replaceState({}, '', '/workbench?batch=ICON-MISSING');
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/batches/ICON-MISSING') {
      return Promise.resolve(jsonResponse({ error: { code: 'BATCH_NOT_FOUND', message: 'Unknown batch.' } }, 404));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock);

  render(<App />);

  await screen.findByRole('heading', { name: '把图标设计交给开发审核' });
  expect(`${window.location.pathname}${window.location.search}`).toBe('/');
  expect(window.localStorage.getItem('pink-icon-submit.active-batch.v1')).toBe('ICON-MISSING');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('server active-batch recovery ignores a stale browser activity preference', async () => {
  const active = batch({
    id: 'ICON-SERVER-ACTIVE',
    items: [{ id: 'item-server-active', batchId: 'ICON-SERVER-ACTIVE', action: 'add', designName: 'pink-server-active', description: '服务端恢复。', sourceFile: 'items/item-server-active.svg' }],
  });
  window.localStorage.setItem('pink-icon-submit.active-batch.v1', 'ICON-STALE-BROWSER-PREFERENCE');
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/batches/ICON-STALE-BROWSER-PREFERENCE') throw new Error('The browser preference must not select the active batch.');
    if (path === `/api/batches/${active.id}`) return Promise.resolve(jsonResponse(active));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [summary({ id: active.id, title: active.title })], active);
  const user = userEvent.setup();

  render(<App />);
  await screen.findAllByRole('button', { name: '继续编辑' });
  await openActiveWorkbench(user, '继续编辑');
  await screen.findByText('SVG 已保存');
  expect(fetchMock).not.toHaveBeenCalledWith('/api/batches/ICON-STALE-BROWSER-PREFERENCE', {});
});

test('browser popstate switches between home and a blank workbench without replacing an activity id', async () => {
  saveProfile();
  stubFetch(vi.fn());
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  expect(window.location.pathname).toBe('/workbench');

  window.history.replaceState({}, '', '/');
  fireEvent.popState(window);
  await screen.findByRole('heading', { name: '把图标设计交给开发审核' });

  window.history.replaceState({}, '', '/workbench');
  fireEvent.popState(window);
  await screen.findByRole('heading', { name: '完成设计，交给开发' });
});

test('a home-screen active delivery polls to PR_CREATED and refreshes the server-owned activity summary', async () => {
  saveProfile();
  const queued = batch({ id: 'ICON-HOME-POLL', title: '后台轮询', executionMode: 'remote', state: 'QUEUED' });
  const handedOff = batch({
    ...queued,
    state: 'PR_CREATED',
    userStatus: 'submitted_review',
    delivery: delivery({ checkpoint: 'PR_CREATED', pullRequest: { number: 5, url: 'https://github.example.invalid/pull/5', state: 'open', isDraft: true, createdAt: '2026-08-10T00:00:00.000Z' } }),
  });
  let reads = 0;
  let summaryReads = 0;
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/auth/me') return Promise.resolve(jsonResponse({ user: { id: 'user-designer', username: 'designer@example.invalid' } }));
    if (path === '/api/batches/active') {
      reads += 1;
      return Promise.resolve(jsonResponse(queued));
    }
    if (path === '/api/batches?limit=20') {
      summaryReads += 1;
      return Promise.resolve(jsonResponse([summary({ id: queued.id, title: queued.title, userStatus: 'processing' })]));
    }
    if (path === `/api/batches/${queued.id}`) {
      reads += 1;
      return Promise.resolve(jsonResponse(reads === 1 ? queued : handedOff));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<App />);
  await screen.findAllByRole('button', { name: '查看处理中' });
  await waitFor(() => expect(screen.getByText('暂时没有活动批次')).toBeTruthy(), { timeout: 3_000 });
  expect(screen.getByRole('heading', { name: '把图标设计交给开发审核' })).toBeTruthy();
  expect(summaryReads).toBeGreaterThanOrEqual(2);
});

test('home restores one active DRAFT batch and continues editing it in the workbench', async () => {
  saveProfile();
  const active = batch({ id: 'ICON-ACTIVE-DRAFT', title: '继续修改的图标', items: [{
    id: 'item-active', batchId: 'ICON-ACTIVE-DRAFT', action: 'add', designName: 'pink-active', description: 'Restored work.', sourceFile: 'items/item-active.svg',
  }] });
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/batches/ICON-ACTIVE-DRAFT') return Promise.resolve(jsonResponse(active));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [summary({ id: active.id, title: active.title })], active);
  const user = userEvent.setup();

  renderBase(<App />);

  await screen.findAllByRole('button', { name: '继续编辑' });
  await openActiveWorkbench(user, '继续编辑');
  expect(screen.getByText('本次变更 1 项')).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith('/api/batches/ICON-ACTIVE-DRAFT', {});
});

test('returning a final-validation failure restores saved metadata and server items after going home and continuing', async () => {
  saveProfile();
  const item = {
    id: 'item-return-edit', batchId: 'ICON-RETURN-EDIT', action: 'add' as const,
    designName: 'pink-return-edit', description: '修正后仍需保留的图标。', sourceFile: 'items/item-return-edit.svg',
  };
  const failed = batch({
    id: 'ICON-RETURN-EDIT', title: '修正单色图标', description: '请将图标修改为单色。', designUrl: 'https://figma.example.invalid/return-edit',
    state: 'FAILED', items: [item], validation: { valid: false, errors: [{ code: 'SVG_MULTIPLE_COLORS', message: '需改为单色。', itemId: item.id }], warnings: [] },
    error: { code: 'FINAL_VALIDATION_FAILED', message: 'Final validation failed.' },
  });
  const draft = batch({ ...failed, state: 'DRAFT', error: null, userStatus: 'needs_changes' });
  let current = failed;
  const fetchMock = vi.fn((path: string, options?: RequestInit) => {
    if (path === `/api/batches/${current.id}`) return Promise.resolve(jsonResponse(current));
    if (path === `/api/batches/${current.id}/return-to-edit` && options?.method === 'POST') {
      current = draft;
      return Promise.resolve(jsonResponse(draft));
    }
    if (path === `/api/batches/${current.id}/items/${item.id}` && options?.method === 'DELETE') return Promise.resolve(jsonResponse(undefined, 204));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [summary({ id: current.id, title: current.title, userStatus: 'needs_changes' })], failed);
  const user = userEvent.setup();

  render(<App />);
  await openActiveWorkbench(user, '返回修改');
  await screen.findByRole('heading', { name: '需要修改' });
  expect(screen.getByText('SVG 已保存')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  expect((screen.getByLabelText(/^本次变更标题/) as HTMLInputElement).value).toBe(draft.title);
  expect((screen.getByLabelText(/^整体需求说明/) as HTMLTextAreaElement).value).toBe(draft.description);
  expect((screen.getByLabelText(/^设计稿链接/) as HTMLInputElement).value).toBe(draft.designUrl);
  await user.click(screen.getByRole('button', { name: '关闭' }));

  await user.click(screen.getByRole('button', { name: '返回首页' }));
  await screen.findByRole('heading', { name: '把图标设计交给开发审核' });
  await openActiveWorkbench(user, '继续编辑');
  await screen.findByText('SVG 已保存');
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  expect((screen.getByLabelText(/^本次变更标题/) as HTMLInputElement).value).toBe(draft.title);
  expect((screen.getByLabelText(/^整体需求说明/) as HTMLTextAreaElement).value).toBe(draft.description);
  expect((screen.getByLabelText(/^设计稿链接/) as HTMLInputElement).value).toBe(draft.designUrl);
  await user.click(screen.getByRole('button', { name: '关闭' }));
  await user.click(screen.getByRole('button', { name: '移除 pink-return-edit' }));
  expect(fetchMock).toHaveBeenCalledWith(`/api/batches/${draft.id}/items/${item.id}`, { method: 'DELETE' });
});

test('an active DRAFT restores its saved form and items after a home round trip', async () => {
  saveProfile();
  const active = batch({
    id: 'ICON-DRAFT-ROUND-TRIP', title: '已保存的草稿标题', description: '已保存的草稿说明。', designUrl: 'https://figma.example.invalid/draft-round-trip',
    items: [{ id: 'item-draft-round-trip', batchId: 'ICON-DRAFT-ROUND-TRIP', action: 'add', designName: 'pink-draft-round-trip', description: '已保存的图标项。', sourceFile: 'items/item-draft-round-trip.svg' }],
  });
  stubFetch(vi.fn((path: string) => {
    if (path === `/api/batches/${active.id}`) return Promise.resolve(jsonResponse(active));
    throw new Error(`Unexpected request: ${path}`);
  }), [summary({ id: active.id, title: active.title })], active);
  const user = userEvent.setup();

  render(<App />);
  await openActiveWorkbench(user, '继续编辑');
  await screen.findByText('SVG 已保存');
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  expect((screen.getByLabelText(/^本次变更标题/) as HTMLInputElement).value).toBe(active.title);
  expect((screen.getByLabelText(/^整体需求说明/) as HTMLTextAreaElement).value).toBe(active.description);
  expect((screen.getByLabelText(/^设计稿链接/) as HTMLInputElement).value).toBe(active.designUrl);
  await user.click(screen.getByRole('button', { name: '关闭' }));

  await user.click(screen.getByRole('button', { name: '返回首页' }));
  await screen.findByRole('heading', { name: '把图标设计交给开发审核' });
  await openActiveWorkbench(user, '继续编辑');
  await screen.findByText('SVG 已保存');
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  expect((screen.getByLabelText(/^本次变更标题/) as HTMLInputElement).value).toBe(active.title);
  expect((screen.getByLabelText(/^整体需求说明/) as HTMLTextAreaElement).value).toBe(active.description);
  expect((screen.getByLabelText(/^设计稿链接/) as HTMLInputElement).value).toBe(active.designUrl);
});

test('popstate from a historical query to a blank workbench clears the historical details', async () => {
  saveProfile();
  const historical = batch({
    id: 'ICON-HISTORY-BACK', title: '只读历史批次', state: 'PR_CREATED',
    delivery: delivery({ checkpoint: 'PR_CREATED' }),
  });
  window.history.replaceState({}, '', `/workbench?batch=${historical.id}`);
  stubFetch(vi.fn((path: string) => {
    if (path === `/api/batches/${historical.id}`) return Promise.resolve(jsonResponse(historical));
    throw new Error(`Unexpected request: ${path}`);
  }));

  render(<App />);
  await screen.findByText('这是历史批次，仅供查看。');
  window.history.replaceState({}, '', '/workbench');
  fireEvent.popState(window);

  await waitFor(() => expect(screen.queryByText('这是历史批次，仅供查看。')).toBeNull());
  expect(screen.getByText('本次变更 0 项')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Draft PR 已创建' })).toBeNull();
  expect(`${window.location.pathname}${window.location.search}`).toBe('/workbench');
});

test('a direct blank workbench route restores the active batch from this browser', async () => {
  saveProfile();
  const active = batch({
    id: 'ICON-DIRECT-ACTIVE', title: '直接恢复的草稿', description: '直接进入工作台时恢复。', designUrl: 'https://figma.example.invalid/direct-active',
    items: [{ id: 'item-direct-active', batchId: 'ICON-DIRECT-ACTIVE', action: 'add', designName: 'pink-direct-active', description: '直接恢复的项目。', sourceFile: 'items/item-direct-active.svg' }],
  });
  window.history.replaceState({}, '', '/workbench');
  stubFetch(vi.fn((path: string) => {
    if (path === `/api/batches/${active.id}`) return Promise.resolve(jsonResponse(active));
    throw new Error(`Unexpected request: ${path}`);
  }), [summary({ id: active.id, title: active.title })], active);
  const user = userEvent.setup();

  render(<App />);
  await screen.findByText('SVG 已保存');
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  expect((screen.getByLabelText(/^本次变更标题/) as HTMLInputElement).value).toBe(active.title);
  expect((screen.getByLabelText(/^整体需求说明/) as HTMLTextAreaElement).value).toBe(active.description);
  expect((screen.getByLabelText(/^设计稿链接/) as HTMLInputElement).value).toBe(active.designUrl);
});

test('an initial PR_CREATED active batch immediately returns a direct workbench refresh to home', async () => {
  saveProfile();
  const completed = batch({
    id: 'ICON-INITIAL-PR-CREATED', title: '已完成的开发审核', executionMode: 'remote', state: 'PR_CREATED',
    delivery: delivery({ checkpoint: 'PR_CREATED', pullRequest: { number: 55, url: 'https://github.example.invalid/pull/55', state: 'open', isDraft: true, createdAt: '2026-08-10T00:00:00.000Z' } }),
  });
  window.history.replaceState({}, '', '/workbench');
  let summaryReads = 0;
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/auth/me') return Promise.resolve(jsonResponse({ user: { id: 'user-designer', username: 'designer@example.invalid' } }));
    if (path === '/api/batches/active') return Promise.resolve(jsonResponse(completed));
    if (path === '/api/batches?limit=20') {
      summaryReads += 1;
      return Promise.resolve(jsonResponse([summary({ id: completed.id, title: completed.title, userStatus: 'submitted_review' })]));
    }
    if (path === `/api/batches/${completed.id}`) return Promise.resolve(jsonResponse(completed));
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<App />);

  await screen.findByRole('heading', { name: '把图标设计交给开发审核' });
  await waitFor(() => expect(screen.getByText('暂时没有活动批次')).toBeTruthy());
  await waitFor(() => expect(summaryReads).toBeGreaterThanOrEqual(2));
  expect(screen.queryByRole('heading', { name: '完成设计，交给开发' })).toBeNull();
  expect(screen.getAllByRole('status').map((node) => node.textContent)).toEqual(['已提交开发审核。']);
  expect(`${window.location.pathname}${window.location.search}`).toBe('/');
});

test('a stale historical hydration cannot overwrite the batch reopened by forward navigation', async () => {
  saveProfile();
  const oldBatch = batch({
    id: 'ICON-HISTORY-OLD', title: '旧历史批次', state: 'PR_CREATED', delivery: delivery({ checkpoint: 'PR_CREATED' }),
    items: [{ id: 'item-history-old', batchId: 'ICON-HISTORY-OLD', action: 'add', designName: 'pink-history-old', description: '旧响应。', sourceFile: 'items/item-history-old.svg' }],
  });
  const newBatch = batch({
    id: 'ICON-HISTORY-NEW', title: '新历史批次', state: 'PR_CREATED', delivery: delivery({ checkpoint: 'PR_CREATED' }),
    items: [{ id: 'item-history-new', batchId: 'ICON-HISTORY-NEW', action: 'add', designName: 'pink-history-new', description: '新响应。', sourceFile: 'items/item-history-new.svg' }],
  });
  const oldResponse = deferred<Response>();
  const newResponse = deferred<Response>();
  window.history.replaceState({}, '', `/workbench?batch=${oldBatch.id}`);
  const fetchMock = vi.fn((path: string) => {
    if (path === `/api/batches/${oldBatch.id}`) return oldResponse.promise;
    if (path === `/api/batches/${newBatch.id}`) return newResponse.promise;
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock);

  render(<App />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/batches/${oldBatch.id}`, {}));
  window.history.replaceState({}, '', '/workbench');
  fireEvent.popState(window);
  await waitFor(() => expect(screen.getByText('本次变更 0 项')).toBeTruthy());
  window.history.replaceState({}, '', `/workbench?batch=${newBatch.id}`);
  fireEvent.popState(window);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/batches/${newBatch.id}`, {}));

  newResponse.resolve(jsonResponse(newBatch));
  await screen.findByText(/pink-history-new/);
  oldResponse.resolve(jsonResponse(oldBatch));
  await waitFor(() => expect(screen.getByText(/pink-history-new/)).toBeTruthy());
  expect(screen.queryByText(/pink-history-old/)).toBeNull();
  expect(`${window.location.pathname}${window.location.search}`).toBe(`/workbench?batch=${newBatch.id}`);
});

test.each([
  ['DRAFT', batch({ id: 'ICON-STALE-DRAFT', state: 'DRAFT', userStatus: 'draft' }), '本次交付尚未提交'],
  ['FAILED', batch({ id: 'ICON-STALE-FAILED', state: 'FAILED', userStatus: 'developer_attention', error: { code: 'CATALOG_INTEGRITY_MISMATCH', message: 'Catalog is invalid.' } }), '需要开发处理'],
  ['PR_CREATED', batch({ id: 'ICON-STALE-PR', executionMode: 'remote', state: 'PR_CREATED', userStatus: 'submitted_review', delivery: delivery({ checkpoint: 'PR_CREATED', pullRequest: { number: 7, url: 'https://github.example.invalid/pull/7', state: 'open', isDraft: true, createdAt: null } }) }), '把图标设计交给开发审核'],
])('a slow processing poll cannot overwrite a newer %s hydration', async (_state, target, expectedHeading) => {
  saveProfile();
  const initial = batch({ id: target.id, executionMode: 'remote', state: 'RUNNING', userStatus: 'processing' });
  const stalePoll = deferred<Response>();
  const pollRegistered = deferred<void>();
  const pollStarted = deferred<void>();
  const hydrationStarted = deferred<void>();
  let reads = 0;
  let poll: (() => void) | undefined;
  vi.spyOn(window, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number) => {
    if (delay === 1_500) {
      poll = callback as () => void;
      pollRegistered.resolve();
    }
    return 1 as unknown as number;
  }) as typeof window.setInterval);
  vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);
  const fetchMock = vi.fn((path: string) => {
    if (path === `/api/batches/${initial.id}`) {
      reads += 1;
      if (reads === 1) {
        pollStarted.resolve();
        return stalePoll.promise;
      }
      hydrationStarted.resolve();
      return Promise.resolve(jsonResponse(target));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [summary({ id: initial.id, title: initial.title, userStatus: 'processing' })], initial);

  render(<App />);
  await pollRegistered.promise;
  await act(async () => {
    poll!();
    await pollStarted.promise;
  });
  await act(async () => {
    window.history.replaceState({}, '', `/workbench?batch=${initial.id}`);
    fireEvent.popState(window);
    await hydrationStarted.promise;
  });
  expect(screen.getByRole('heading', { name: expectedHeading })).toBeTruthy();

  await act(async () => {
    stalePoll.resolve(jsonResponse(initial));
    await Promise.resolve();
  });
  expect(screen.getByRole('heading', { name: expectedHeading })).toBeTruthy();
});

test('a completed Draft PR returns the current workbench to home and keeps its result available', async () => {
  saveProfile();
  const queued = batch({ id: 'ICON-HANDOFF', title: '等待开发审核', executionMode: 'remote', state: 'QUEUED' });
  const handedOff = batch({
    id: queued.id,
    title: queued.title,
    executionMode: 'remote',
    state: 'PR_CREATED',
    delivery: delivery({ checkpoint: 'PR_CREATED', pullRequest: { number: 8, url: 'https://github.example.invalid/pull/8', state: 'open', isDraft: true, createdAt: '2026-08-10T00:00:00.000Z' } }),
  });
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/batches/ICON-HANDOFF') {
      return Promise.resolve(jsonResponse(handedOff));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [summary({ id: queued.id, title: queued.title, userStatus: 'processing' })], queued);
  const user = userEvent.setup();

  renderBase(<App />);
  await openActiveWorkbench(user, '查看处理中');
  await screen.findByRole('heading', { name: '把图标设计交给开发审核' }, { timeout: 3_000 });
  expect(screen.getByRole('status').textContent).toBe('已提交开发审核。');
  fireEvent.click(screen.getByRole('button', { name: '查看' }));
  const link = await screen.findByRole('link', { name: '打开开发审核记录' });
  expect(link.getAttribute('href')).toBe('https://github.example.invalid/pull/8');
});

test('the first queued item is a server draft and survives home navigation, remount, and account login', async () => {
  const server = statefulDraftServer();
  const user = userEvent.setup();
  const firstRender = render(<App />);
  await openNewWorkbench(user);
  await addOneSvgChange(user);

  await screen.findByText('本次变更 1 项');
  expect(server.current()?.items).toHaveLength(1);
  expect(server.current()?.state).toBe('DRAFT');
  expect(server.counts()).toMatchObject({ create: 1, add: 1, submit: 0 });

  const title = screen.getByLabelText(/^本次变更标题/);
  await user.clear(title);
  await user.type(title, '返回首页前保存的新标题');
  const pendingInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(pendingInput, svgFile('not-added.svg'));
  await screen.findByRole('button', { name: '选择 not-added.svg' });
  await user.click(screen.getByRole('button', { name: '返回首页' }));
  expect(server.current()?.title).toBe('返回首页前保存的新标题');
  await openActiveWorkbench(user, '继续编辑');
  expect(await screen.findByText('本次变更 1 项')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '选择 not-added.svg' })).toBeNull();

  await user.click(screen.getByRole('button', { name: '退出登录' }));
  await screen.findByRole('heading', { name: '登录 PinK 图标工作台' });
  await user.type(screen.getByLabelText(/^账号/), 'designer@example.invalid');
  await user.type(screen.getByLabelText(/^密码/), 'secret');
  await user.click(screen.getByRole('button', { name: '登录' }));
  expect((await screen.findAllByRole('button', { name: '继续编辑' })).length).toBeGreaterThan(0);

  firstRender.unmount();
  render(<App />);
  expect((await screen.findAllByRole('button', { name: '继续编辑' })).length).toBeGreaterThan(0);
  expect(server.counts()).toMatchObject({ create: 1, add: 1, submit: 0 });
});

test('lost create and add responses reconcile the unique server draft without duplicate writes', async () => {
  const server = statefulDraftServer({ loseCreateResponse: true, loseAddResponse: true });
  const user = userEvent.setup();
  render(<App />);
  await openNewWorkbench(user);
  await addOneSvgChange(user);

  expect(await screen.findByText('本次变更 1 项')).toBeTruthy();
  expect(server.current()?.items).toHaveLength(1);
  expect(server.counts()).toMatchObject({ create: 1, add: 1, submit: 0 });
  expect(screen.queryByText(/草稿保存失败/)).toBeNull();
});

test('an uncertain add write reconciles on manual retry before issuing another POST', async () => {
  const server = statefulDraftServer({ loseAddResponse: true, failFirstReconciliationGet: true });
  const user = userEvent.setup();
  render(<App />);
  await openNewWorkbench(user);
  await addOneSvgChange(user);

  expect(await screen.findByText('草稿保存失败：The add response was lost.')).toBeTruthy();
  expect(server.current()?.items).toHaveLength(1);
  expect(server.counts()).toMatchObject({ create: 1, add: 1, submit: 0 });

  await user.click(screen.getByRole('button', { name: '加入新增队列' }));
  expect(await screen.findByText('本次变更 1 项')).toBeTruthy();
  expect(server.current()?.items).toHaveLength(1);
  expect(server.counts()).toMatchObject({ create: 1, add: 1, submit: 0 });
});

test('leaving during the first create still exposes the new active draft on home', async () => {
  const createResponse = deferred<Response>();
  let active: BatchDetails | undefined;
  const created = batch({ id: 'ICON-CREATE-ROUTE', title: '首次创建路由恢复', description: '创建期间返回首页。' });
  stubFetch(vi.fn((path: string, request?: RequestInit) => {
    if (path === '/api/batches' && request?.method === 'POST') return createResponse.promise;
    throw new Error(`Unexpected request: ${path}`);
  }), [], () => active);
  const user = userEvent.setup();
  render(<App />);
  await openNewWorkbench(user);
  await user.type(screen.getByLabelText(/^本次变更标题/), created.title);
  await user.type(screen.getByLabelText(/^整体需求说明/), created.description);
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, svgFile('new-icon.svg'));
  await user.type(screen.getByLabelText(/^期望图标名称/), 'pink-new-icon');
  await user.type(screen.getByLabelText(/^用途说明/), '验证创建期间路由变化。');
  await user.click(screen.getByRole('button', { name: '加入新增队列' }));

  window.history.replaceState({}, '', '/');
  window.dispatchEvent(new PopStateEvent('popstate'));
  active = created;
  await act(async () => { createResponse.resolve(jsonResponse(created)); });

  expect(await screen.findByRole('heading', { name: created.title })).toBeTruthy();
  expect(screen.getByText('草稿')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '新建图标变更' })).toBeNull();
  expect(window.location.pathname).toBe('/');
});

test('a failed first item upload keeps one empty server draft and all editor input for retry', async () => {
  const server = statefulDraftServer({ failAddBeforeWrite: true });
  const user = userEvent.setup();
  render(<App />);
  await openNewWorkbench(user);
  await addOneSvgChange(user);

  expect(await screen.findByText('草稿保存失败：The upload failed before storage.')).toBeTruthy();
  expect(server.current()?.items).toHaveLength(0);
  expect(server.counts()).toMatchObject({ create: 1, add: 1, submit: 0 });
  expect((screen.getByLabelText(/^期望图标名称/) as HTMLInputElement).value).toBe('pink-new-icon');
  expect(screen.getByRole('button', { name: '选择 new-icon.svg' })).toBeTruthy();

  await user.click(screen.getByRole('button', { name: '加入新增队列' }));
  expect(await screen.findByText('本次变更 1 项')).toBeTruthy();
  expect(server.current()?.items).toHaveLength(1);
  expect(server.counts()).toMatchObject({ create: 1, add: 2, submit: 0 });
  expect(server.itemMutationIds()).toHaveLength(2);
  expect(new Set(server.itemMutationIds()).size).toBe(1);
});

test('a metadata save failure keeps the designer in the workbench with the server draft unchanged', async () => {
  const server = statefulDraftServer({ failMetadataSave: true });
  const user = userEvent.setup();
  render(<App />);
  await openNewWorkbench(user);
  await addOneSvgChange(user);
  await screen.findByText('本次变更 1 项');

  const title = screen.getByLabelText(/^本次变更标题/);
  await user.clear(title);
  await user.type(title, '修改后的批次标题');
  await user.click(screen.getByRole('button', { name: '返回首页' }));

  expect(await screen.findByText('草稿保存失败：Metadata save failed.')).toBeTruthy();
  expect(screen.getByRole('heading', { name: '完成设计，交给开发' })).toBeTruthy();
  expect(window.location.pathname).toBe('/workbench');
  expect(server.current()?.title).toBe('模型入口图标');
});

test('double-clicking add and confirming review create one batch, one item, and one submission', async () => {
  const server = statefulDraftServer();
  const user = userEvent.setup();
  render(<App />);
  await openNewWorkbench(user);
  await fillBatchMetadata(user);
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, svgFile('new-icon.svg'));
  await user.type(screen.getByLabelText(/^期望图标名称/), 'pink-new-icon');
  await user.type(screen.getByLabelText(/^用途说明/), '用于验证双击不会产生重复写入。');
  await user.dblClick(screen.getByRole('button', { name: '加入新增队列' }));
  await screen.findByText('本次变更 1 项');

  await openReview(user);
  await user.click(screen.getByRole('button', { name: '确认提交' }));
  await screen.findByRole('heading', { name: '已提交' });

  expect(server.current()?.items).toHaveLength(1);
  expect(server.counts()).toEqual({ create: 1, add: 1, metadataSave: 1, submit: 1 });
});

test('an in-flight draft response cannot restore the previous account after authentication expires', async () => {
  const createResponse = deferred<Response>();
  const created = batch({ id: 'ICON-STALE-AUTH', title: '模型入口图标', description: '新增模型入口图标。' });
  stubFetch(vi.fn((path: string, request?: RequestInit) => {
    if (path === '/api/batches' && request?.method === 'POST') return createResponse.promise;
    throw new Error(`Unexpected request: ${path}`);
  }));
  const user = userEvent.setup();
  render(<App />);
  await openNewWorkbench(user);
  await fillBatchMetadata(user);
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, svgFile('new-icon.svg'));
  await user.type(screen.getByLabelText(/^期望图标名称/), 'pink-new-icon');
  await user.type(screen.getByLabelText(/^用途说明/), '用于验证失效会话不会回写。');
  await user.click(screen.getByRole('button', { name: '加入新增队列' }));
  expect((screen.getByRole('button', { name: '退出登录' }) as HTMLButtonElement).disabled).toBe(true);

  window.dispatchEvent(new Event('pink-icon-submit.authentication-required'));
  await screen.findByRole('heading', { name: '登录 PinK 图标工作台' });
  await act(async () => { createResponse.resolve(jsonResponse(created)); });

  await waitFor(() => expect(screen.getByRole('heading', { name: '登录 PinK 图标工作台' })).toBeTruthy());
  expect(screen.queryByText('模型入口图标')).toBeNull();
  expect(window.location.pathname).toBe('/');
});
