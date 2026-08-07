import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import { App } from './App';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function catalogResponse() {
  return {
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
  };
}

function namePreviewResponse(name: string) {
  return {
    schemaVersion: 1,
    baseCommit: 'a'.repeat(40),
    input: name,
    normalizedName: name === 'pink-new-icon' ? 'pink-new-icon' : name === 'pink-one' ? 'pink-one' : name,
    valid: true,
    collision: null,
  };
}

function mockNamePreview(): ReturnType<typeof vi.fn> {
  return vi.fn((path: string) => {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/names/preview') {
      return Promise.resolve(jsonResponse(namePreviewResponse(url.searchParams.get('name') ?? '')));
    }
    return Promise.resolve(jsonResponse({}));
  });
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

async function addOneSvgChange(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, svgFile('new-icon.svg'));
  await user.type(screen.getByLabelText(/^图标建议名称/), 'pink-new-icon');
  await user.type(screen.getByLabelText(/^用途说明/), '用于测试新增图标的设计稿。');
  await screen.findByText(/最终名称：/);
  await user.click(screen.getByRole('button', { name: '加入新增队列' }));
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
  expect(screen.getByText('这不是登录。填写一次设计师信息，后续提交会自动带入；你可以在右上角随时修改。')).toBeTruthy();
  await user.type(screen.getByLabelText(/^姓名/), '设计师');
  await user.type(screen.getByLabelText(/^公司邮箱/), 'designer@example.invalid');
  await user.click(screen.getByRole('button', { name: '开始编辑图标' }));

  expect(window.localStorage.getItem('pink-icon-submit.designer-profile.v1')).toContain('designer@example.invalid');
  expect(screen.queryByRole('dialog', { name: '开始前，认识一下你' })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('replace opens the catalog on demand and closes it after choosing a canonical target', async () => {
  saveProfile();
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(catalogResponse()));
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);

  expect(fetchMock).not.toHaveBeenCalled();
  await user.click(screen.getByRole('tab', { name: '替换图标' }));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog', { name: '图标目录' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '选择图标' }));
  await screen.findByText('existing');
  expect(fetchMock).toHaveBeenCalledWith('/api/catalog/page?group=all&page=1&pageSize=24', {});
  await user.click(screen.getByRole('button', { name: '选择 existing' }));

  expect(screen.queryByRole('dialog', { name: '图标目录' })).toBeNull();
  expect(screen.getByRole('img', { name: 'existing 当前图标' })).toBeTruthy();
  expect(screen.getByText('待替换图标 · existing-alias')).toBeTruthy();
});

test('a replace target becomes unavailable after it is added to the same batch', async () => {
  saveProfile();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(catalogResponse())));
  const user = userEvent.setup();

  render(<App />);
  await user.click(screen.getByRole('tab', { name: '替换图标' }));
  await user.click(screen.getByRole('button', { name: '选择图标' }));
  await screen.findByText('existing');
  await user.click(screen.getByRole('button', { name: '选择 existing' }));
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, svgFile('replacement.svg'));
  await user.click(screen.getByRole('button', { name: '加入替换队列' }));

  await user.click(screen.getByRole('button', { name: '选择图标' }));
  await screen.findByText('existing');
  const usedTarget = screen.getByRole('button', { name: 'existing 已用于第 1 项替换' });
  expect((usedTarget as HTMLButtonElement).disabled).toBe(true);
  expect(usedTarget.getAttribute('title')).toContain('不能在同一批次重复修改');
});

test('multiple SVG files stay in the pending queue until each is paired with a change', async () => {
  saveProfile();
  vi.stubGlobal('fetch', mockNamePreview());
  const user = userEvent.setup();

  render(<App />);
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, [svgFile('one.svg'), svgFile('two.svg')]);
  expect(await screen.findByText('待处理 SVG')).toBeTruthy();
  expect(screen.getByRole('button', { name: '选择 one.svg' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '选择 two.svg' })).toBeTruthy();
  await user.type(screen.getByLabelText(/^图标建议名称/), 'pink-one');
  await user.type(screen.getByLabelText(/^用途说明/), '第一个图标。');
  await screen.findByText(/最终名称：/);
  await user.click(screen.getByRole('button', { name: '加入新增队列' }));

  expect(screen.getByText('本次变更 1 项')).toBeTruthy();
  expect(screen.getByRole('button', { name: '选择 two.svg' })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'one.svg 预览' })).toBeTruthy();
});

test('an add name collision returned by Stage 1 cannot be added to the batch', async () => {
  saveProfile();
  vi.stubGlobal('fetch', vi.fn((path: string) => {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/names/preview') {
      return Promise.resolve(jsonResponse({
        ...namePreviewResponse(url.searchParams.get('name') ?? ''),
        normalizedName: 'existing',
        collision: { primaryName: 'existing', aliases: ['existing-alias'] },
      }));
    }
    throw new Error(`Unexpected request: ${path}`);
  }));
  const user = userEvent.setup();
  render(<App />);
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, svgFile('collision.svg'));
  await user.type(screen.getByLabelText(/^图标建议名称/), 'Existing');
  await user.type(screen.getByLabelText(/^用途说明/), '验证名称冲突。');
  await screen.findByText(/已与 existing/);
  await user.click(screen.getByRole('button', { name: '加入新增队列' }));

  expect(screen.getByText(/最终名称 existing 已被 existing/)).toBeTruthy();
  expect(screen.getByText('本次变更 0 项')).toBeTruthy();
});

test('delete only needs a target and design reason before it enters the queue', async () => {
  saveProfile();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(catalogResponse())));
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole('tab', { name: '删除图标' }));
  await user.click(screen.getByRole('button', { name: '选择图标' }));
  await screen.findByText('existing');
  await user.click(screen.getByRole('button', { name: '选择 existing' }));
  await user.type(screen.getByLabelText(/^删除原因/), '旧图标已废弃。');
  await user.click(screen.getByRole('button', { name: '加入删除队列' }));

  expect(screen.getByText('本次变更 1 项')).toBeTruthy();
  expect(screen.queryByText(/删除可能影响现有调用方/)).toBeNull();
});

test('review drawer blocks incomplete batch details before any batch is created', async () => {
  saveProfile();
  const fetchMock = mockNamePreview();
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await addOneSvgChange(user);
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  expect(screen.getByRole('dialog', { name: '让开发准确理解这次设计' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '进入校验' }));

  expect(screen.getByText('请填写本次变更标题。')).toBeTruthy();
  expect(screen.getByText('请填写整体需求说明。')).toBeTruthy();
  expect(screen.getByText('请填写有效的 HTTP(S) 设计稿链接。')).toBeTruthy();
  expect(screen.getByText('请确认本次变更内容。')).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/names/preview?name=pink-new-icon');
});

test('review drawer rejects a malformed HTTP(S) URL before a batch is created', async () => {
  saveProfile();
  const fetchMock = mockNamePreview();
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await addOneSvgChange(user);
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  await user.type(screen.getByLabelText(/^本次变更标题/), '错误链接测试');
  await user.type(screen.getByLabelText(/^整体需求说明/), '链接必须使用明确协议分隔符。');
  await user.type(screen.getByLabelText(/^设计稿链接/), 'https:www.123.com');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: '进入校验' }));

  expect(screen.getByText('请填写有效的 HTTP(S) 设计稿链接。')).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('revalidation hides stale diagnostics and syncs latest batch metadata before items and validation', async () => {
  saveProfile();
  let resolveSecondValidation!: (response: Response) => void;
  let validationCount = 0;
  const item = { id: 'item-1', batchId: 'ICON-RECHECK', action: 'add', designName: 'pink-new-icon', description: '用于测试新增图标的设计稿。', sourceFile: 'items/item-1.svg' };
  const draft = { id: 'ICON-RECHECK', executionMode: 'local', state: 'DRAFT', items: [item], validation: null, warningsAcknowledged: false, localDiff: null, delivery: { branch: null, commitSha: null, pullRequest: null, handoffAt: null }, error: null };
  const fetchMock = vi.fn((path: string) => {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/names/preview') return Promise.resolve(jsonResponse(namePreviewResponse(url.searchParams.get('name') ?? '')));
    if (url.pathname === '/api/batches') return Promise.resolve(jsonResponse({ ...draft, items: [] }));
    if (url.pathname === '/api/batches/ICON-RECHECK') return Promise.resolve(jsonResponse(draft));
    if (url.pathname === '/api/batches/ICON-RECHECK/items' || url.pathname === '/api/batches/ICON-RECHECK/items/item-1') return Promise.resolve(jsonResponse(item));
    if (url.pathname === '/api/batches/ICON-RECHECK/validate') {
      validationCount += 1;
      if (validationCount === 1) {
        return Promise.resolve(jsonResponse({
          ...draft,
          validation: {
            valid: false,
            errors: [{ code: 'SVG_MULTIPLE_COLORS', message: 'SVG contains more than one literal paint color.', itemId: 'item-1' }],
            warnings: [],
          },
        }));
      }
      return new Promise<Response>((resolve) => { resolveSecondValidation = resolve; });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await addOneSvgChange(user);
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  await user.type(screen.getByLabelText(/^本次变更标题/), '首次校验');
  await user.type(screen.getByLabelText(/^整体需求说明/), '首次校验会失败。');
  await user.type(screen.getByLabelText(/^设计稿链接/), 'https://design.example.invalid/first');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: '进入校验' }));

  await screen.findByText('图标包含多种颜色');
  expect(screen.getByText('对应图标：新增图标：pink-new-icon')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  await user.clear(screen.getByLabelText(/^本次变更标题/));
  await user.type(screen.getByLabelText(/^本次变更标题/), '更新后的标题');
  await user.clear(screen.getByLabelText(/^整体需求说明/));
  await user.type(screen.getByLabelText(/^整体需求说明/), '已根据错误更新设计说明。');
  await user.clear(screen.getByLabelText(/^设计稿链接/));
  await user.type(screen.getByLabelText(/^设计稿链接/), 'https://design.example.invalid/updated');
  await user.click(screen.getByRole('button', { name: '进入校验' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/batches/ICON-RECHECK', expect.objectContaining({ method: 'PUT' })));
  expect(screen.getByText('正在按最新修改重新校验…')).toBeTruthy();
  expect(screen.queryByText('图标包含多种颜色')).toBeNull();
  const updateBatchCall = fetchMock.mock.calls.find((call) => call[0] === '/api/batches/ICON-RECHECK') as unknown as [string, RequestInit] | undefined;
  expect(updateBatchCall).toBeDefined();
  expect(JSON.parse(updateBatchCall![1].body as string)).toEqual({
    title: '更新后的标题',
    description: '已根据错误更新设计说明。',
    designUrl: 'https://design.example.invalid/updated',
  });
  const updateIndex = fetchMock.mock.calls.findIndex((call) => call[0] === '/api/batches/ICON-RECHECK');
  const itemUpdateIndex = fetchMock.mock.calls.findIndex((call, index) => index > updateIndex && call[0] === '/api/batches/ICON-RECHECK/items/item-1');
  const secondValidationIndex = fetchMock.mock.calls.findIndex((call, index) => index > itemUpdateIndex && call[0] === '/api/batches/ICON-RECHECK/validate');
  expect(updateIndex).toBeLessThan(itemUpdateIndex);
  expect(itemUpdateIndex).toBeLessThan(secondValidationIndex);
  expect(fetchMock.mock.calls.filter((call) => call[0] === '/api/batches')).toHaveLength(1);

  resolveSecondValidation(jsonResponse({
    ...draft,
    state: 'READY',
    validation: { valid: true, errors: [], warnings: [] },
  }));
  await screen.findByText(/已按最新内容重新校验/);
  expect(screen.getByText(/最新校验完成时间：/)).toBeTruthy();
});

test('a confirmed change creates a batch, uploads its SVG, and starts validation', async () => {
  saveProfile();
  const fetchMock = vi.fn((path: string) => {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/names/preview') {
      return Promise.resolve(jsonResponse(namePreviewResponse(url.searchParams.get('name') ?? '')));
    }
    if (url.pathname === '/api/batches') {
      return Promise.resolve(jsonResponse({ id: 'ICON-TEST', state: 'DRAFT', items: [], validation: null, warningsAcknowledged: false, localDiff: null, error: null }));
    }
    if (url.pathname === '/api/batches/ICON-TEST/items') {
      return Promise.resolve(jsonResponse({ id: 'item-1', batchId: 'ICON-TEST', action: 'add', sourceFile: 'items/item-1.svg' }));
    }
    if (url.pathname === '/api/batches/ICON-TEST/validate') {
      return Promise.resolve(jsonResponse({
        id: 'ICON-TEST',
        state: 'READY',
        items: [],
        validation: { valid: true, errors: [], warnings: [] },
        warningsAcknowledged: false,
        localDiff: null,
        error: null,
      }));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await addOneSvgChange(user);
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  await user.type(screen.getByLabelText(/^本次变更标题/), '模型入口图标');
  await user.type(screen.getByLabelText(/^整体需求说明/), '新增模型入口图标。');
  await user.type(screen.getByLabelText(/^设计稿链接/), 'https://design.example.invalid/icon');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: '进入校验' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/batches');
  expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/batches/ICON-TEST/items');
  expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/batches/ICON-TEST/validate');
  expect(screen.getByText('校验通过，可以生成本地修改。')).toBeTruthy();
});

test('validation warnings remain visible without requiring a designer acknowledgement', async () => {
  saveProfile();
  const fetchMock = vi.fn((path: string) => {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/names/preview') {
      return Promise.resolve(jsonResponse(namePreviewResponse(url.searchParams.get('name') ?? '')));
    }
    if (url.pathname === '/api/batches') {
      return Promise.resolve(jsonResponse({ id: 'ICON-WARNING', state: 'DRAFT', items: [], validation: null, warningsAcknowledged: false, localDiff: null, error: null }));
    }
    if (url.pathname === '/api/batches/ICON-WARNING/items') {
      return Promise.resolve(jsonResponse({ id: 'item-1', batchId: 'ICON-WARNING', action: 'add', sourceFile: 'items/item-1.svg' }));
    }
    if (url.pathname === '/api/batches/ICON-WARNING/validate') {
      return Promise.resolve(jsonResponse({
        id: 'ICON-WARNING',
        state: 'READY',
        items: [],
        validation: { valid: true, errors: [], warnings: [{ code: 'TEST_WARNING', message: '需要开发审核。' }] },
        warningsAcknowledged: false,
        localDiff: null,
        error: null,
      }));
    }
    if (url.pathname === '/api/batches/ICON-WARNING/submit') {
      return Promise.resolve(jsonResponse({ id: 'ICON-WARNING', state: 'QUEUED', items: [], validation: { valid: true, errors: [], warnings: [{ code: 'TEST_WARNING', message: '需要开发审核。' }] }, warningsAcknowledged: false, localDiff: null, error: null }));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await addOneSvgChange(user);
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  await user.type(screen.getByLabelText(/^本次变更标题/), '模型入口图标');
  await user.type(screen.getByLabelText(/^整体需求说明/), '新增模型入口图标。');
  await user.type(screen.getByLabelText(/^设计稿链接/), 'https://design.example.invalid/icon');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: '进入校验' }));

  await screen.findByText('开发审核提醒');
  expect(screen.queryByRole('button', { name: '我已阅读并确认全部提醒' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '生成本地修改' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/batches/ICON-WARNING/submit', { method: 'POST' }));
});

test('a completed remote batch shows its Draft PR link and handoff boundary', async () => {
  saveProfile();
  const draftDelivery = {
    branch: 'bot/ICON-PR',
    commitSha: 'a'.repeat(40),
    pullRequest: {
      number: 42,
      url: 'https://github.example.invalid/sekiroxxxx/sekiroxxxx-pink-codicons-automation-test/pull/42',
      state: 'open',
      isDraft: true,
      createdAt: '2026-08-06T00:00:00.000Z',
    },
    handoffAt: '2026-08-06T00:00:00.000Z',
  };
  const fetchMock = vi.fn((path: string) => {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/names/preview') return Promise.resolve(jsonResponse(namePreviewResponse(url.searchParams.get('name') ?? '')));
    if (url.pathname === '/api/batches') return Promise.resolve(jsonResponse({ id: 'ICON-PR', executionMode: 'remote', state: 'DRAFT', items: [], validation: null, warningsAcknowledged: false, localDiff: null, delivery: { ...draftDelivery, pullRequest: null }, error: null }));
    if (url.pathname === '/api/batches/ICON-PR/items') return Promise.resolve(jsonResponse({ id: 'item-1', batchId: 'ICON-PR', action: 'add', sourceFile: 'items/item-1.svg' }));
    if (url.pathname === '/api/batches/ICON-PR/validate') return Promise.resolve(jsonResponse({ id: 'ICON-PR', executionMode: 'remote', state: 'READY', items: [], validation: { valid: true, errors: [], warnings: [] }, warningsAcknowledged: false, localDiff: null, delivery: { ...draftDelivery, pullRequest: null }, error: null }));
    if (url.pathname === '/api/batches/ICON-PR/submit') return Promise.resolve(jsonResponse({ id: 'ICON-PR', executionMode: 'remote', state: 'PR_CREATED', items: [], validation: { valid: true, errors: [], warnings: [] }, warningsAcknowledged: false, localDiff: { changedFiles: ['src/icons/pink-new-icon.svg'], patch: '' }, delivery: draftDelivery, error: null }));
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await addOneSvgChange(user);
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  await user.type(screen.getByLabelText(/^本次变更标题/), 'PR 结果展示');
  await user.type(screen.getByLabelText(/^整体需求说明/), '验证 Draft PR 链接。');
  await user.type(screen.getByLabelText(/^设计稿链接/), 'https://design.example.invalid/pr');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: '进入校验' }));
  await screen.findByText('校验通过，可以生成本地修改。');
  await user.click(screen.getByRole('button', { name: '生成本地修改' }));

  const link = await screen.findByRole('link', { name: '打开 Draft PR #42' });
  expect(link.getAttribute('href')).toBe(draftDelivery.pullRequest.url);
  expect(screen.getByText('平台已停止写入该机器人分支；后续调整请直接在 PR 中完成。')).toBeTruthy();
});

test('a completed local preview never promises a Draft PR', async () => {
  saveProfile();
  const localDelivery = { branch: null, commitSha: null, pullRequest: null, handoffAt: null };
  const fetchMock = vi.fn((path: string) => {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/names/preview') return Promise.resolve(jsonResponse(namePreviewResponse(url.searchParams.get('name') ?? '')));
    if (url.pathname === '/api/batches') return Promise.resolve(jsonResponse({ id: 'ICON-LOCAL', executionMode: 'local', state: 'DRAFT', items: [], validation: null, warningsAcknowledged: false, localDiff: null, delivery: localDelivery, error: null }));
    if (url.pathname === '/api/batches/ICON-LOCAL/items') return Promise.resolve(jsonResponse({ id: 'item-1', batchId: 'ICON-LOCAL', action: 'add', sourceFile: 'items/item-1.svg' }));
    if (url.pathname === '/api/batches/ICON-LOCAL/validate') return Promise.resolve(jsonResponse({ id: 'ICON-LOCAL', executionMode: 'local', state: 'READY', items: [], validation: { valid: true, errors: [], warnings: [] }, warningsAcknowledged: false, localDiff: null, delivery: localDelivery, error: null }));
    if (url.pathname === '/api/batches/ICON-LOCAL/submit') return Promise.resolve(jsonResponse({ id: 'ICON-LOCAL', executionMode: 'local', state: 'LOCAL_DIFF_READY', items: [], validation: { valid: true, errors: [], warnings: [] }, warningsAcknowledged: false, localDiff: { changedFiles: ['src/icons/pink-new-icon.svg'], patch: '' }, delivery: localDelivery, error: null }));
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await addOneSvgChange(user);
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  await user.type(screen.getByLabelText(/^本次变更标题/), '本地预览结果');
  await user.type(screen.getByLabelText(/^整体需求说明/), '验证 local 模式不会创建 PR。');
  await user.type(screen.getByLabelText(/^设计稿链接/), 'https://design.example.invalid/local');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: '进入校验' }));
  await screen.findByText('校验通过，可以生成本地修改。');
  await user.click(screen.getByRole('button', { name: '生成本地修改' }));

  await screen.findByText('本地预览已完成，此模式不会创建 PR');
  expect(screen.queryByText('等待创建 Draft PR')).toBeNull();
  expect(screen.queryByText('正在创建 Draft PR')).toBeNull();
});

test('only a remote bot branch checkpoint shows Draft PR creation progress', async () => {
  saveProfile();
  const delivery = { branch: 'bot/ICON-BRANCH', commitSha: 'a'.repeat(40), pullRequest: null, handoffAt: null };
  const fetchMock = vi.fn((path: string) => {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/names/preview') return Promise.resolve(jsonResponse(namePreviewResponse(url.searchParams.get('name') ?? '')));
    if (url.pathname === '/api/batches') return Promise.resolve(jsonResponse({ id: 'ICON-BRANCH', executionMode: 'remote', state: 'DRAFT', items: [], validation: null, warningsAcknowledged: false, localDiff: null, delivery, error: null }));
    if (url.pathname === '/api/batches/ICON-BRANCH/items') return Promise.resolve(jsonResponse({ id: 'item-1', batchId: 'ICON-BRANCH', action: 'add', sourceFile: 'items/item-1.svg' }));
    if (url.pathname === '/api/batches/ICON-BRANCH/validate') return Promise.resolve(jsonResponse({ id: 'ICON-BRANCH', executionMode: 'remote', state: 'READY', items: [], validation: { valid: true, errors: [], warnings: [] }, warningsAcknowledged: false, localDiff: null, delivery, error: null }));
    if (url.pathname === '/api/batches/ICON-BRANCH/submit') return Promise.resolve(jsonResponse({ id: 'ICON-BRANCH', executionMode: 'remote', state: 'BRANCH_PUSHED', items: [], validation: { valid: true, errors: [], warnings: [] }, warningsAcknowledged: false, localDiff: { changedFiles: ['src/icons/pink-new-icon.svg'], patch: '' }, delivery, error: null }));
    if (url.pathname === '/api/batches/ICON-BRANCH') return Promise.resolve(jsonResponse({ id: 'ICON-BRANCH', executionMode: 'remote', state: 'BRANCH_PUSHED', items: [], validation: { valid: true, errors: [], warnings: [] }, warningsAcknowledged: false, localDiff: { changedFiles: ['src/icons/pink-new-icon.svg'], patch: '' }, delivery, error: null }));
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await addOneSvgChange(user);
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  await user.type(screen.getByLabelText(/^本次变更标题/), '远程交付进度');
  await user.type(screen.getByLabelText(/^整体需求说明/), '验证机器人分支后的 PR 状态。');
  await user.type(screen.getByLabelText(/^设计稿链接/), 'https://design.example.invalid/branch');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: '进入校验' }));
  await screen.findByText('校验通过，可以生成本地修改。');
  await user.click(screen.getByRole('button', { name: '生成本地修改' }));

  await screen.findByText('正在创建 Draft PR');
});

test('a remote delivery failure explains that no PR was created and offers the remote retry', async () => {
  saveProfile();
  const delivery = { branch: 'bot/ICON-FAILED', commitSha: 'a'.repeat(40), pullRequest: null, handoffAt: null };
  const fetchMock = vi.fn((path: string) => {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/names/preview') return Promise.resolve(jsonResponse(namePreviewResponse(url.searchParams.get('name') ?? '')));
    if (url.pathname === '/api/batches') return Promise.resolve(jsonResponse({ id: 'ICON-FAILED', executionMode: 'remote', state: 'DRAFT', items: [], validation: null, warningsAcknowledged: false, localDiff: null, delivery, error: null }));
    if (url.pathname === '/api/batches/ICON-FAILED/items') return Promise.resolve(jsonResponse({ id: 'item-1', batchId: 'ICON-FAILED', action: 'add', sourceFile: 'items/item-1.svg' }));
    if (url.pathname === '/api/batches/ICON-FAILED/validate') return Promise.resolve(jsonResponse({ id: 'ICON-FAILED', executionMode: 'remote', state: 'READY', items: [], validation: { valid: true, errors: [], warnings: [] }, warningsAcknowledged: false, localDiff: null, delivery, error: null }));
    if (url.pathname === '/api/batches/ICON-FAILED/submit') return Promise.resolve(jsonResponse({ id: 'ICON-FAILED', executionMode: 'remote', state: 'FAILED', items: [], validation: { valid: true, errors: [], warnings: [] }, warningsAcknowledged: false, localDiff: null, delivery, error: { code: 'REMOTE_BRANCH_DIVERGED', message: 'Remote branch changed.' } }));
    if (url.pathname === '/api/batches/ICON-FAILED/retry') return Promise.resolve(jsonResponse({ id: 'ICON-FAILED', executionMode: 'remote', state: 'QUEUED', items: [], validation: { valid: true, errors: [], warnings: [] }, warningsAcknowledged: false, localDiff: null, delivery, error: null }));
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await addOneSvgChange(user);
  await user.click(screen.getByRole('button', { name: '确认本次变更' }));
  await user.type(screen.getByLabelText(/^本次变更标题/), '远程失败结果');
  await user.type(screen.getByLabelText(/^整体需求说明/), '验证远程失败的重试入口。');
  await user.type(screen.getByLabelText(/^设计稿链接/), 'https://design.example.invalid/failed');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: '进入校验' }));
  await screen.findByText('校验通过，可以生成本地修改。');
  await user.click(screen.getByRole('button', { name: '生成本地修改' }));

  await screen.findByText('远程交付未完成');
  expect(screen.getByText('未创建或恢复 Draft PR；请修正问题后重试远程交付。')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '重试远程交付' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/batches/ICON-FAILED/retry', { method: 'POST' }));
});
