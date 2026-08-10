import { fireEvent, render as renderBase, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { App } from './App';
import type { BatchDetails, BatchSummary } from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function saveProfile(): void {
  window.localStorage.setItem('pink-icon-submit.designer-profile.v1', JSON.stringify({
    version: 1,
    name: '设计师',
    email: 'designer@example.invalid',
  }));
}

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
  return {
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
    createdAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

function stubFetch(handler: (path: string, options?: RequestInit) => unknown, summaries: BatchSummary[] = []): void {
  vi.stubGlobal('fetch', vi.fn((path: string, options?: RequestInit) => {
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
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, svgFile('new-icon.svg'));
  await screen.findByRole('button', { name: '选择 new-icon.svg' });
  await user.type(screen.getByLabelText(/^期望图标名称/), 'pink-new-icon');
  await user.type(screen.getByLabelText(/^用途说明/), '用于测试新增图标的设计稿。');
  await user.click(screen.getByRole('button', { name: '加入新增队列' }));
}

async function openReview(user: ReturnType<typeof userEvent.setup>, designUrl?: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  await user.type(screen.getByLabelText(/^本次变更标题/), '模型入口图标');
  await user.type(screen.getByLabelText(/^整体需求说明/), '新增模型入口图标。');
  if (designUrl) await user.type(screen.getByLabelText(/^设计稿链接/), designUrl);
  await user.click(screen.getByRole('checkbox'));
}

async function openActiveWorkbench(user: ReturnType<typeof userEvent.setup>, label: string): Promise<void> {
  const buttons = await screen.findAllByRole('button', { name: label });
  await user.click(buttons.at(-1)!);
}

afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('first use asks for a local designer profile and stores it in this browser', async () => {
  const fetchMock = vi.fn();
  stubFetch(fetchMock);
  const user = userEvent.setup();

  render(<App />);

  expect(screen.getByRole('dialog', { name: '开始前，认识一下你' })).toBeTruthy();
  await user.type(screen.getByLabelText(/^姓名/), '设计师');
  await user.type(screen.getByLabelText(/^公司邮箱/), 'designer@example.invalid');
  await user.click(screen.getByRole('button', { name: '开始编辑图标' }));

  expect(window.localStorage.getItem('pink-icon-submit.designer-profile.v1')).toContain('designer@example.invalid');
  expect(fetchMock).not.toHaveBeenCalled();
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
  expect(fetchMock).not.toHaveBeenCalled();
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
  stubFetch(vi.fn().mockResolvedValue(jsonResponse({
    baseCommit: 'a'.repeat(40), page: 1, pageSize: 24, total: 1,
    icons: [{ primaryName: 'existing', aliases: ['existing-alias'], group: 'common', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h1v1H0z" /></svg>' }],
  })));
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
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
  stubFetch(vi.fn());
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
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
  stubFetch(vi.fn().mockResolvedValue(jsonResponse({
    baseCommit: 'a'.repeat(40), page: 1, pageSize: 24, total: 1,
    icons: [{ primaryName: 'existing', aliases: ['existing-alias'], group: 'common', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h1v1H0z" /></svg>' }],
  })));
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  await user.click(screen.getByRole('tab', { name: '删除图标' }));
  await user.click(screen.getByRole('button', { name: '选择图标' }));
  await screen.findByText('existing');
  await user.click(screen.getByRole('button', { name: '选择 existing' }));
  await user.type(screen.getByLabelText(/^删除原因/), '旧图标已废弃。');
  await user.click(screen.getByRole('button', { name: '加入删除队列' }));

  expect(screen.getByText('本次变更 1 项')).toBeTruthy();
});

test('review requires local batch fields but design link is optional', async () => {
  saveProfile();
  const fetchMock = vi.fn();
  stubFetch(fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  await addOneSvgChange(user);
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  await user.click(screen.getByRole('button', { name: '确认提交' }));

  expect(screen.getByText('请填写本次变更标题。')).toBeTruthy();
  expect(screen.getByText('请填写整体需求说明。')).toBeTruthy();
  expect(screen.getByText('请确认本次变更内容。')).toBeTruthy();
  expect(screen.queryByText('请填写有效的 HTTP(S) 设计稿链接。')).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('review rejects a malformed optional design link before it creates a batch', async () => {
  saveProfile();
  const fetchMock = vi.fn();
  stubFetch(fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await openNewWorkbench(user);
  await addOneSvgChange(user);
  await openReview(user, 'https:www.123.com');
  await user.click(screen.getByRole('button', { name: '确认提交' }));

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
    `/api/batches/${draft.id}/submit`,
  ]);
  const createOptions = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect(JSON.parse(createOptions.body as string)).toMatchObject({ title: '模型入口图标', description: '新增模型入口图标。' });
  expect(JSON.parse(createOptions.body as string)).not.toHaveProperty('designUrl');
  expect(fetchMock.mock.calls.some(([path]) => String(path).includes('/validate') || String(path).includes('/names/preview'))).toBe(false);
});

test('a final validation failure shows Chinese diagnostics and can return to editing', async () => {
  saveProfile();
  window.localStorage.setItem('pink-icon-submit.active-batch.v1', 'ICON-INVALID');
  const failed = batch({
    id: 'ICON-INVALID',
    state: 'FAILED',
    validation: { valid: false, errors: [{ code: 'SVG_MULTIPLE_COLORS', message: 'SVG contains more than one literal paint color.', itemId: 'item-1' }], warnings: [] },
    items: [{ id: 'item-1', batchId: 'ICON-INVALID', action: 'add', designName: 'pink-new-icon', description: '需要改为单色。', sourceFile: 'items/item-1.svg' }],
    error: { code: 'FINAL_VALIDATION_FAILED', message: 'Final validation failed.' },
  });
  const draft = batch({ id: failed.id, state: 'DRAFT', items: failed.items });
  const fetchMock = vi.fn((path: string, _options?: RequestInit) => {
    if (path === '/api/batches/ICON-INVALID') return Promise.resolve(jsonResponse(failed));
    if (path === '/api/batches/ICON-INVALID/return-to-edit') return Promise.resolve(jsonResponse(draft));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await openActiveWorkbench(user, '返回修改');

  await screen.findByRole('heading', { name: '本次交付尚未提交' });
  expect(screen.getByText('本次变更 1 项')).toBeTruthy();
  expect(screen.getByText('已上传：item-1.svg')).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith('/api/batches/ICON-INVALID/return-to-edit', { method: 'POST' });
});

test('a refreshed DRAFT batch restores server items as removable changes', async () => {
  saveProfile();
  window.localStorage.setItem('pink-icon-submit.active-batch.v1', 'ICON-RESTORE');
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
  stubFetch(fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await openActiveWorkbench(user, '继续编辑');

  await screen.findByText('本次变更 1 项');
  expect(screen.getByText('已上传：item-restore.svg')).toBeTruthy();
  expect((screen.getByRole('button', { name: '确认本次变更' }) as HTMLButtonElement).disabled).toBe(false);
  await user.click(screen.getByRole('button', { name: '移除 pink-restored-icon' }));

  await screen.findByText('本次变更 0 项');
  expect(fetchMock).toHaveBeenCalledWith('/api/batches/ICON-RESTORE/items/item-restore', { method: 'DELETE' });
});

test('an infrastructure failure offers a manual delivery retry without exposing infrastructure details as the main message', async () => {
  saveProfile();
  window.localStorage.setItem('pink-icon-submit.active-batch.v1', 'ICON-RETRY');
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
  stubFetch(fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await openActiveWorkbench(user, '恢复交付');
  await screen.findByRole('heading', { name: '交付失败' });
  expect(screen.getByText('本次交付没有完成。请在确认技术问题后，手动重新尝试交付。')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '重新尝试交付' }));

  await screen.findByRole('heading', { name: '已提交' });
  expect(fetchMock).toHaveBeenCalledWith('/api/batches/ICON-RETRY/retry', { method: 'POST' });
});

test('a refreshed pushed branch failure offers a Draft PR-only retry', async () => {
  saveProfile();
  window.localStorage.setItem('pink-icon-submit.active-batch.v1', 'ICON-PR-RETRY');
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
  stubFetch(fetchMock);
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

test('partial item sync reconciles server items before retrying without duplicate creation', async () => {
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
  await openReview(user);
  await user.click(screen.getByRole('button', { name: '确认提交' }));

  await screen.findByText('提交未完成：The second upload failed.');
  expect(serverItems).toHaveLength(1);
  expect(serverItems[0]?.designName).toBe('pink-new-icon');
  expect(screen.getByText('本次变更 2 项')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
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

test('a restored remote branch checkpoint reports delivery progress without exposing branch internals', async () => {
  saveProfile();
  window.localStorage.setItem('pink-icon-submit.active-batch.v1', 'ICON-BRANCH');
  const inProgress = batch({
    id: 'ICON-BRANCH',
    executionMode: 'remote',
    state: 'BRANCH_PUSHED',
    validation: { valid: true, errors: [], warnings: [] },
    delivery: delivery({ checkpoint: 'BRANCH_PUSHED', branch: 'bot/ICON-BRANCH', commitSha: 'a'.repeat(40) }),
  });
  stubFetch(vi.fn().mockResolvedValue(jsonResponse(inProgress)));
  const user = userEvent.setup();

  render(<App />);
  await openActiveWorkbench(user, '查看处理中');

  await screen.findByRole('heading', { name: '正在交付' });
  expect(screen.queryByText(/bot\/ICON-BRANCH/)).toBeNull();
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
])('an active %s batch replaces the new-work entry without clearing its browser lock', async (_name, active, actionLabel) => {
  saveProfile();
  window.localStorage.setItem('pink-icon-submit.active-batch.v1', active.id);
  const fetchMock = vi.fn((path: string) => {
    if (path === `/api/batches/${active.id}`) return Promise.resolve(jsonResponse(active));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock);

  render(<App />);

  await screen.findAllByRole('button', { name: actionLabel });
  expect(screen.queryByRole('button', { name: '新建图标变更' })).toBeNull();
  expect(window.localStorage.getItem('pink-icon-submit.active-batch.v1')).toBe(active.id);
});

test('an active batch blocks a different history record but can reopen itself', async () => {
  saveProfile();
  const active = batch({ id: 'ICON-ACTIVE-LOCK', title: '当前草稿' });
  const historical = batch({ id: 'ICON-HISTORY-OTHER', title: '其他历史', state: 'PR_CREATED', delivery: delivery({ checkpoint: 'PR_CREATED' }) });
  window.localStorage.setItem('pink-icon-submit.active-batch.v1', active.id);
  const fetchMock = vi.fn((path: string) => {
    if (path === `/api/batches/${active.id}`) return Promise.resolve(jsonResponse(active));
    if (path === `/api/batches/${historical.id}`) return Promise.resolve(jsonResponse(historical));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [summary({ id: active.id, title: active.title }), summary({ id: historical.id, title: historical.title, userStatus: 'submitted_review' })]);
  const user = userEvent.setup();

  render(<App />);
  const historyButtons = await screen.findAllByRole('button', { name: '查看' });
  await user.click(historyButtons[1]!);
  expect(screen.getByRole('status').textContent).toBe('请先完成当前批次。');
  expect(fetchMock).not.toHaveBeenCalledWith(`/api/batches/${historical.id}`, {});
  expect(window.localStorage.getItem('pink-icon-submit.active-batch.v1')).toBe(active.id);

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
  expect(window.localStorage.getItem('pink-icon-submit.active-batch.v1')).toBeNull();
  expect((screen.getByLabelText(/^期望图标名称/) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: '确认本次变更' }) as HTMLButtonElement).disabled).toBe(true);
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
  window.localStorage.setItem('pink-icon-submit.active-batch.v1', active.id);
  window.history.replaceState({}, '', '/workbench?batch=ICON-URL-HISTORY');
  const fetchMock = vi.fn((path: string) => {
    if (path === `/api/batches/${active.id}`) return Promise.resolve(jsonResponse(active));
    if (path === '/api/batches/ICON-URL-HISTORY') throw new Error('The active batch must block this history read.');
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock);

  render(<App />);
  await screen.findByText('请先完成当前批次。');
  expect(`${window.location.pathname}${window.location.search}`).toBe('/');
  expect(window.localStorage.getItem('pink-icon-submit.active-batch.v1')).toBe(active.id);
  expect(fetchMock).not.toHaveBeenCalledWith('/api/batches/ICON-URL-HISTORY', {});
});

test('an invalid workbench batch URL clears a matching stale browser activity id and returns home', async () => {
  saveProfile();
  window.localStorage.setItem('pink-icon-submit.active-batch.v1', 'ICON-MISSING');
  window.history.replaceState({}, '', '/workbench?batch=ICON-MISSING');
  stubFetch(vi.fn((path: string) => {
    if (path === '/api/batches/ICON-MISSING') {
      return Promise.resolve(jsonResponse({ error: { code: 'BATCH_NOT_FOUND', message: 'Unknown batch.' } }, 404));
    }
    throw new Error(`Unexpected request: ${path}`);
  }));

  render(<App />);

  await screen.findByRole('heading', { name: '把图标设计交给开发审核' });
  expect(`${window.location.pathname}${window.location.search}`).toBe('/');
  expect(window.localStorage.getItem('pink-icon-submit.active-batch.v1')).toBeNull();
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
  expect(window.localStorage.getItem('pink-icon-submit.active-batch.v1')).toBeNull();
});

test('a home-screen active delivery polls to PR_CREATED, refreshes summaries, and clears the browser lock', async () => {
  saveProfile();
  const queued = batch({ id: 'ICON-HOME-POLL', title: '后台轮询', executionMode: 'remote', state: 'QUEUED' });
  const handedOff = batch({
    ...queued,
    state: 'PR_CREATED',
    delivery: delivery({ checkpoint: 'PR_CREATED', pullRequest: { number: 5, url: 'https://github.example.invalid/pull/5', state: 'open', isDraft: true, createdAt: '2026-08-10T00:00:00.000Z' } }),
  });
  window.localStorage.setItem('pink-icon-submit.active-batch.v1', queued.id);
  let reads = 0;
  let summaryReads = 0;
  const fetchMock = vi.fn((path: string) => {
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
  await waitFor(() => expect(window.localStorage.getItem('pink-icon-submit.active-batch.v1')).toBeNull(), { timeout: 3_000 });
  expect(screen.getByRole('heading', { name: '把图标设计交给开发审核' })).toBeTruthy();
  expect(summaryReads).toBeGreaterThanOrEqual(2);
});

test('home restores one active DRAFT batch and continues editing it in the workbench', async () => {
  saveProfile();
  window.localStorage.setItem('pink-icon-submit.active-batch.v1', 'ICON-ACTIVE-DRAFT');
  const active = batch({ id: 'ICON-ACTIVE-DRAFT', title: '继续修改的图标', items: [{
    id: 'item-active', batchId: 'ICON-ACTIVE-DRAFT', action: 'add', designName: 'pink-active', description: 'Restored work.', sourceFile: 'items/item-active.svg',
  }] });
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/batches/ICON-ACTIVE-DRAFT') return Promise.resolve(jsonResponse(active));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [summary({ id: active.id, title: active.title })]);
  const user = userEvent.setup();

  renderBase(<App />);

  await screen.findAllByRole('button', { name: '继续编辑' });
  await openActiveWorkbench(user, '继续编辑');
  expect(screen.getByText('本次变更 1 项')).toBeTruthy();
  expect(window.localStorage.getItem('pink-icon-submit.active-batch.v1')).toBe('ICON-ACTIVE-DRAFT');
  expect(fetchMock).toHaveBeenCalledWith('/api/batches/ICON-ACTIVE-DRAFT', {});
});

test('a completed Draft PR returns the current workbench to home and keeps its result available', async () => {
  saveProfile();
  window.localStorage.setItem('pink-icon-submit.active-batch.v1', 'ICON-HANDOFF');
  const queued = batch({ id: 'ICON-HANDOFF', title: '等待开发审核', executionMode: 'remote', state: 'QUEUED' });
  const handedOff = batch({
    id: queued.id,
    title: queued.title,
    executionMode: 'remote',
    state: 'PR_CREATED',
    delivery: delivery({ checkpoint: 'PR_CREATED', pullRequest: { number: 8, url: 'https://github.example.invalid/pull/8', state: 'open', isDraft: true, createdAt: '2026-08-10T00:00:00.000Z' } }),
  });
  let reads = 0;
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/batches/ICON-HANDOFF') {
      reads += 1;
      return Promise.resolve(jsonResponse(reads === 1 ? queued : handedOff));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  stubFetch(fetchMock, [summary({ id: queued.id, title: queued.title, userStatus: 'processing' })]);
  const user = userEvent.setup();

  renderBase(<App />);
  await openActiveWorkbench(user, '查看处理中');
  await screen.findByRole('heading', { name: '已提交' });
  await screen.findByRole('heading', { name: '把图标设计交给开发审核' }, { timeout: 3_000 });
  expect(screen.getByRole('status').textContent).toBe('已提交开发审核。');
  fireEvent.click(screen.getByRole('button', { name: '查看' }));
  const link = await screen.findByRole('link', { name: '打开开发审核记录' });
  expect(link.getAttribute('href')).toBe('https://github.example.invalid/pull/8');
});
