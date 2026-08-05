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

test('replace requests the catalog only after its action is selected and chooses a canonical target', async () => {
  saveProfile();
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(catalogResponse()));
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);

  expect(fetchMock).not.toHaveBeenCalled();
  await user.click(screen.getByRole('tab', { name: '替换图标' }));
  await screen.findByText('existing');
  expect(fetchMock).toHaveBeenCalledWith('/api/catalog/page?group=all&page=1&pageSize=24', {});
  await user.click(screen.getByRole('button', { name: '选择 existing' }));

  expect(screen.getByRole('img', { name: 'existing 当前图标' })).toBeTruthy();
  expect(screen.getByText('待替换图标 · existing-alias')).toBeTruthy();
});

test('multiple SVG files stay in the pending queue until each is paired with a change', async () => {
  saveProfile();
  vi.stubGlobal('fetch', vi.fn());
  const user = userEvent.setup();

  render(<App />);
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, [svgFile('one.svg'), svgFile('two.svg')]);
  expect(await screen.findByText('待处理 SVG')).toBeTruthy();
  expect(screen.getByRole('button', { name: '选择 one.svg' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '选择 two.svg' })).toBeTruthy();
  await user.type(screen.getByLabelText(/^图标建议名称/), 'pink-one');
  await user.type(screen.getByLabelText(/^用途说明/), '第一个图标。');
  await user.click(screen.getByRole('button', { name: '加入新增队列' }));

  expect(screen.getByText('本次变更 1 项')).toBeTruthy();
  expect(screen.getByRole('button', { name: '选择 two.svg' })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'one.svg 预览' })).toBeTruthy();
});

test('review drawer blocks incomplete batch details before any batch is created', async () => {
  saveProfile();
  const fetchMock = vi.fn();
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
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a confirmed change creates a batch, uploads its SVG, and starts validation', async () => {
  saveProfile();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ id: 'ICON-TEST', state: 'DRAFT', items: [], validation: null, localDiff: null, error: null }))
    .mockResolvedValueOnce(jsonResponse({ id: 'item-1', batchId: 'ICON-TEST', action: 'add', sourceFile: 'items/item-1.svg' }))
    .mockResolvedValueOnce(jsonResponse({
      id: 'ICON-TEST',
      state: 'READY',
      items: [],
      validation: { valid: true, errors: [], warnings: [] },
      localDiff: null,
      error: null,
    }));
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

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/batches');
  expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/batches/ICON-TEST/items');
  expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/batches/ICON-TEST/validate');
  expect(screen.getByText('校验通过，可以生成本地修改。')).toBeTruthy();
});
