import assert from 'node:assert/strict';
import test from 'node:test';

import { draftPullRequestForBatch } from '../src/pull-request-template.js';
import type { BatchDetails } from '../src/types.js';

test('Draft PR template leads with designer-facing Chinese review content and retains its audit details', () => {
  const batch: BatchDetails = {
    id: 'ICON-20260806-ABCDEF12',
    title: '图标批量更新',
    description: '新增、替换和删除图标。',
    designUrl: 'https://design.example.invalid/batch',
    submitter: { name: '设计师', email: 'designer@example.invalid' },
    catalogBaseline: null,
    targetRepository: { repository: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test', branch: 'main' },
    executionMode: 'remote',
    pushRepository: 'sud-icon-bot/sekiroxxxx-pink-codicons-automation-test',
    pushBranchPrefix: 'bot/',
    delivery: {
      checkpoint: 'PR_CREATING',
      branch: 'bot/ICON-20260806-ABCDEF12',
      commitSha: 'a'.repeat(40),
      pullRequest: null,
      handoffAt: null,
    },
    state: 'PR_CREATING',
    validation: {
      requestSha256: 'b'.repeat(64),
      warnings: [{ code: 'SVG_STROKE_PRESENT', message: 'Stroke usage requires review.' }],
    },
    warningsAcknowledged: false,
    plan: {
      items: [
        { id: 'add', plannedName: 'new-icon', codepoint: 50001 },
        { id: 'replace', targetName: 'existing-icon', codepoint: 50000 },
        { id: 'delete', targetName: 'old-icon', codepoint: 50002 },
      ],
    },
    baseCommit: 'c'.repeat(40),
    localDiff: null,
    error: null,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    items: [
      { id: 'add', batchId: 'ICON-20260806-ABCDEF12', action: 'add', designName: 'new-icon', description: '新增图标', sourceFile: 'items/add.svg', createdAt: '2026-08-06T00:00:00.000Z' },
      { id: 'replace', batchId: 'ICON-20260806-ABCDEF12', action: 'replace', targetName: 'existing-icon', sourceFile: 'items/replace.svg', createdAt: '2026-08-06T00:00:00.000Z' },
      { id: 'delete', batchId: 'ICON-20260806-ABCDEF12', action: 'delete', targetName: 'old-icon', reason: '已废弃', replacementName: 'new-icon', sourceFile: null, createdAt: '2026-08-06T00:00:00.000Z' },
    ],
    job: null,
    failureHistory: [],
  };

  const draft = draftPullRequestForBatch(batch);

  assert.equal(draft.title, 'chore(icons): 图标批量更新');
  assert.equal(draft.marker, '<!-- pink-icon-submit:batch=ICON-20260806-ABCDEF12 -->');
  assert.match(draft.body, /## 变更摘要[\s\S]*## 设计说明[\s\S]*## 图标变更明细[\s\S]*## 开发审核提醒/);
  assert.match(draft.body, /本次包含 3 项图标变更：新增 1 项、替换 1 项、删除 1 项。/);
  assert.match(draft.body, /\| 新增 \| new-icon \| new-icon \| U\+C351 \| 新增图标 \|/);
  assert.match(draft.body, /\| 替换 \| existing-icon \| existing-icon \| U\+C350 \| 替换 SVG \|/);
  assert.match(draft.body, /\| 删除 \| old-icon \| old-icon \| U\+C352 \| 删除；建议替代：new-icon \|/);
  assert.match(draft.body, /图标使用了描边：请确认字体渲染后的显示效果。/);
  assert.match(draft.body, /<summary>技术详情与审计信息<\/summary>/);
  assert.match(draft.body, /提交人：设计师 <designer@example.invalid>（身份未经系统认证）/);
  assert.match(draft.body, /上游基线：`c{40}`/);
  assert.match(draft.body, /机器人分支：`sud-icon-bot\/sekiroxxxx-pink-codicons-automation-test:bot\/ICON-20260806-ABCDEF12`/);
  assert.match(draft.body, /SVG_STROKE_PRESENT/);
  assert.match(draft.body, /平台不再 push 或修改该分支/);
});

test('Draft PR template omits an optional design link when the batch has none', () => {
  const batch: BatchDetails = {
    id: 'ICON-20260806-NODESIGN',
    title: '无设计稿链接',
    description: '设计稿链接选填。',
    submitter: { name: '设计师', email: 'designer@example.invalid' },
    catalogBaseline: null,
    targetRepository: { repository: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test', branch: 'main' },
    executionMode: 'remote',
    pushRepository: 'sud-icon-bot/sekiroxxxx-pink-codicons-automation-test',
    pushBranchPrefix: 'bot/',
    delivery: { checkpoint: 'PR_CREATING', branch: 'bot/ICON-20260806-NODESIGN', commitSha: 'a'.repeat(40), pullRequest: null, handoffAt: null },
    state: 'PR_CREATING',
    validation: { requestSha256: 'b'.repeat(64), warnings: [] },
    warningsAcknowledged: false,
    plan: { items: [{ id: 'add', plannedName: 'new-icon', codepoint: 50001 }] },
    baseCommit: 'c'.repeat(40),
    localDiff: null,
    error: null,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    items: [{ id: 'add', batchId: 'ICON-20260806-NODESIGN', action: 'add', designName: 'new-icon', description: '新增图标', sourceFile: 'items/add.svg', createdAt: '2026-08-06T00:00:00.000Z' }],
    job: null,
    failureHistory: [],
  };

  assert.doesNotMatch(draftPullRequestForBatch(batch).body, /设计稿：/);
});
