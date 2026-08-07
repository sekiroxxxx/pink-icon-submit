import { AppError } from './errors.js';
import type { BatchDetails, StoredItem } from './types.js';

export interface PullRequestDraft {
  title: string;
  body: string;
  marker: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inline(value: string): string {
  return value.replace(/[\r\n|`]/g, ' ').replace(/\s+/g, ' ').trim();
}

function codepoint(value: unknown): string {
  return typeof value === 'number' && Number.isInteger(value) ? `U+${value.toString(16).toUpperCase().padStart(4, '0')}` : '—';
}

function planItems(plan: unknown): Map<string, Record<string, unknown>> {
  if (!isObject(plan) || !Array.isArray(plan.items)) {
    throw new AppError('PLAN_INVALID', 'A valid plan is required before creating a Draft PR.', 409);
  }
  const items = new Map<string, Record<string, unknown>>();
  for (const item of plan.items) {
    if (!isObject(item) || typeof item.id !== 'string') {
      throw new AppError('PLAN_INVALID', 'The saved plan has an invalid item.', 409);
    }
    items.set(item.id, item);
  }
  return items;
}

function itemSummary(item: StoredItem, planned: Record<string, unknown>): string {
  const requested = item.action === 'add'
    ? item.designName
    : item.targetName;
  const plannedName = typeof planned.plannedName === 'string'
    ? planned.plannedName
    : typeof planned.targetName === 'string'
      ? planned.targetName
      : requested;
  const detail = item.action === 'delete'
    ? (item.replacementName ? `删除；建议替代：${item.replacementName}` : '删除')
    : item.action === 'replace'
      ? '替换 SVG'
      : item.description ?? '新增 SVG';
  return `| ${item.action} | ${inline(requested ?? '—')} | ${inline(plannedName ?? '—')} | ${codepoint(planned.codepoint)} | ${inline(detail)} |`;
}

function warnings(validation: unknown): string[] {
  if (!isObject(validation) || !Array.isArray(validation.warnings)) {
    return [];
  }
  return validation.warnings.flatMap((warning) => {
    if (!isObject(warning) || typeof warning.code !== 'string' || typeof warning.message !== 'string') {
      return [];
    }
    return [`- \`${inline(warning.code)}\`：${inline(warning.message)}`];
  });
}

export function draftPullRequestForBatch(batch: BatchDetails): PullRequestDraft {
  const branch = batch.delivery.branch;
  const commitSha = batch.delivery.commitSha;
  if (!branch || !commitSha || !batch.baseCommit || !batch.targetRepository || !batch.pushRepository) {
    throw new AppError('DELIVERY_CHECKPOINT_INVALID', `Batch ${batch.id} is missing required Draft PR delivery metadata.`, 409);
  }
  const marker = `<!-- pink-icon-submit:batch=${batch.id} -->`;
  const planned = planItems(batch.plan);
  const rows = batch.items.map((item) => {
    const itemPlan = planned.get(item.id);
    if (!itemPlan) {
      throw new AppError('PLAN_INVALID', `The saved plan is missing item ${item.id}.`, 409);
    }
    return itemSummary(item, itemPlan);
  });
  const warningLines = warnings(batch.validation);
  const title = `chore(icons): ${inline(batch.title).slice(0, 160)}`;
  return {
    title,
    marker,
    body: [
      marker,
      '',
      '## PinK 图标批次',
      '',
      `- 批次：\`${batch.id}\``,
      `- 设计稿：<${batch.designUrl}>`,
      `- 提交人：${inline(batch.submitter.name)} <${batch.submitter.email}>（身份未经系统认证）`,
      `- 上游基线：\`${batch.baseCommit}\``,
      `- 机器人分支：\`${batch.pushRepository}:${branch}\``,
      `- 机器人提交：\`${commitSha}\``,
      '',
      '## 设计说明',
      '',
      batch.description.trim(),
      '',
      '## 计划修改',
      '',
      '| 操作 | 设计输入 | 计划名称 | Codepoint | 说明 |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
      '',
      '## 开发审核提醒',
      '',
      ...(warningLines.length > 0 ? warningLines : ['- 无。']),
      '',
      '---',
      '',
      '此 PR 以 Draft 方式创建。创建成功后，平台不再 push 或修改该分支；后续调整由开发接管。',
    ].join('\n'),
  };
}
