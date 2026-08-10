import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import { App } from './App';
import type { BatchDetails } from './api';

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
    localDiff: null,
    delivery: delivery(),
    error: null,
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

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

test('first use asks for a local designer profile and stores it in this browser', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
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
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await addOneSvgChange(user);

  expect(screen.getByLabelText(/^期望图标名称/)).toBeTruthy();
  expect(screen.getByText('最终名称会在开发审核时确认。')).toBeTruthy();
  expect(screen.queryByText(/仓库最终名称预览/)).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('an expected icon name with path characters is rejected locally without a network check', async () => {
  saveProfile();
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
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
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
    baseCommit: 'a'.repeat(40), page: 1, pageSize: 24, total: 1,
    icons: [{ primaryName: 'existing', aliases: ['existing-alias'], group: 'common', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h1v1H0z" /></svg>' }],
  })));
  const user = userEvent.setup();

  render(<App />);
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
  vi.stubGlobal('fetch', vi.fn());
  const user = userEvent.setup();

  render(<App />);
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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
    baseCommit: 'a'.repeat(40), page: 1, pageSize: 24, total: 1,
    icons: [{ primaryName: 'existing', aliases: ['existing-alias'], group: 'common', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h1v1H0z" /></svg>' }],
  })));
  const user = userEvent.setup();

  render(<App />);
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
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
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
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
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
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
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
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await screen.findByRole('heading', { name: '需要修改' });
  expect(screen.getByText('图标包含多种颜色')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '返回编辑并修正' }));

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
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);

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
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await screen.findByRole('heading', { name: '交付失败' });
  expect(screen.getByText('本次交付没有完成。请在确认技术问题后，手动重新尝试交付。')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '重新尝试交付' }));

  await screen.findByRole('heading', { name: '已提交' });
  expect(fetchMock).toHaveBeenCalledWith('/api/batches/ICON-RETRY/retry', { method: 'POST' });
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
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
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
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
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
  window.localStorage.setItem('pink-icon-submit.active-batch.v1', 'ICON-LOCAL');
  const local = batch({
    id: 'ICON-LOCAL',
    state: 'LOCAL_DIFF_READY',
    localDiff: { changedFiles: ['src/icons/pink-new-icon.svg'], patch: '' },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(local)));

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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(inProgress)));

  render(<App />);

  await screen.findByRole('heading', { name: '正在交付' });
  expect(screen.queryByText(/bot\/ICON-BRANCH/)).toBeNull();
});

test('a restored PR-created batch shows the Draft PR handoff link', async () => {
  saveProfile();
  window.localStorage.setItem('pink-icon-submit.active-batch.v1', 'ICON-PR');
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
  vi.stubGlobal('fetch', fetchMock);

  render(<App />);

  const link = await screen.findByRole('link', { name: '打开 Draft PR #42' });
  expect(link.getAttribute('href')).toBe('https://github.example.invalid/pull/42');
  expect(fetchMock).toHaveBeenCalledWith('/api/batches/ICON-PR', {});
});
