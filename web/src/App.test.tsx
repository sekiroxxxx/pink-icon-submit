import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import { App } from './App';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

test('loads the catalog and lets a designer add another operation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
    icons: [{ primaryName: 'existing', sourceName: 'existing', aliases: ['existing-alias'], sourceFile: 'src/icons/existing.svg' }],
  })));
  const user = userEvent.setup();

  render(<App />);

  expect(await screen.findByText('图标目录已加载 1 个图标。')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '添加操作' }));
  expect(screen.getByRole('region', { name: '图标操作 2' })).toBeTruthy();
});

test('only requests a current-icon preview after an exact catalog match', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
    icons: [{ primaryName: 'existing', sourceName: 'existing', aliases: [], sourceFile: 'src/icons/existing.svg' }],
  })));
  const user = userEvent.setup();

  render(<App />);
  await screen.findByText('图标目录已加载 1 个图标。');
  await user.selectOptions(screen.getByLabelText('操作'), 'replace');
  const picker = screen.getByLabelText('需要替换的图标');
  await user.type(picker, 'ex');
  expect(screen.queryByRole('img', { name: 'existing 的当前图标' })).toBeNull();
  await user.clear(picker);
  await user.type(picker, 'existing');
  expect(screen.getByRole('img', { name: 'existing 的当前图标' })).toBeTruthy();
});

test('submits a DRAFT batch and shows returned validation feedback', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ icons: [] }))
    .mockResolvedValueOnce(jsonResponse({ id: 'ICON-TEST', state: 'DRAFT' }))
    .mockResolvedValueOnce(jsonResponse({ id: 'item-1' }))
    .mockResolvedValueOnce(jsonResponse({
      id: 'ICON-TEST',
      state: 'DRAFT',
      validation: {
        valid: false,
        errors: [{ code: 'SVG_INVALID_XML', message: 'SVG 不是有效 XML。', itemId: 'item-1' }],
        warnings: [{ code: 'NAME_FORMAT_NONSTANDARD', message: '名称将由开发确认。', itemId: 'item-1' }],
      },
    }));
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<App />);
  await screen.findByText('正在加载最新图标目录…');
  await user.type(screen.getByLabelText('批次标题'), '模型入口图标');
  await user.type(screen.getByLabelText('需求说明'), '校验反馈测试');
  await user.type(screen.getByLabelText('设计稿链接'), 'https://design.example.invalid/icon');
  await user.type(screen.getByLabelText('提交人姓名'), '设计师');
  await user.type(screen.getByLabelText('公司邮箱'), 'designer@example.invalid');
  await user.type(screen.getByLabelText('设计建议名称'), 'model-entry');
  await user.type(screen.getByLabelText('用途说明'), '模型入口');
  await user.click(screen.getByRole('button', { name: '校验批次' }));

  expect(await screen.findByText('SVG 不是有效 XML。')).toBeTruthy();
  expect(screen.getByText('名称将由开发确认。')).toBeTruthy();
  expect(fetchMock).toHaveBeenLastCalledWith('/api/batches/ICON-TEST/validate', { method: 'POST' });
});
