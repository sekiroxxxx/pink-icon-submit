import { expect, test } from 'vitest';

import { displayDiagnostic } from './diagnostics';

const items = [
  { id: 'item-add', batchId: 'ICON-TEST', action: 'add' as const, designName: 'new-icon', description: '新增图标', sourceFile: 'uploads/item-add.svg' },
  { id: 'item-delete', batchId: 'ICON-TEST', action: 'delete' as const, targetName: 'old-icon', reason: '已废弃', sourceFile: null },
];

test('known Stage 1 diagnostics receive a Chinese title, reason, suggestion, and item name', () => {
  const multipleColors = displayDiagnostic({ code: 'SVG_MULTIPLE_COLORS', message: 'SVG contains more than one literal paint color.', itemId: 'item-add' }, items);
  expect(multipleColors).toMatchObject({
    title: '图标包含多种颜色',
    reason: 'SVG 解析后发现多个实际非透明颜色。',
    suggestion: '调整为单色图标后重新导出。',
    itemName: '新增图标：new-icon',
  });

  expect(displayDiagnostic({ code: 'REQUEST_SCHEMA_INVALID', message: 'request is invalid' }, items).title).toBe('提交内容格式不正确');
  expect(displayDiagnostic({ code: 'SVG_LITERAL_COLOR', message: 'literal color', itemId: 'item-add' }, items).title).toBe('图标使用了固定颜色');
  expect(displayDiagnostic({ code: 'DELETE_POSSIBLE_USAGE', message: 'downstream usage unknown', itemId: 'item-delete' }, items).title).toBe('删除可能影响现有调用');
});

test('unknown diagnostics use a safe Chinese fallback while retaining technical details', () => {
  const displayed = displayDiagnostic({ code: 'FUTURE_RULE', message: 'Future validator message.', itemId: 'missing' }, items);
  expect(displayed.title).toBe('发现需要进一步确认的校验问题');
  expect(displayed.reason).toContain('暂未识别');
  expect(displayed.suggestion).toContain('技术详情');
  expect(displayed.itemName).toBeNull();
  expect(displayed.technical).toEqual({ code: 'FUTURE_RULE', message: 'Future validator message.' });
});
