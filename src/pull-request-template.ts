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
  const action = item.action === 'add' ? '新增' : item.action === 'replace' ? '替换' : '删除';
  return `| ${action} | ${inline(requested ?? '—')} | ${inline(plannedName ?? '—')} | ${codepoint(planned.codepoint)} | ${inline(detail)} |`;
}

function warningReviewCopy(code: string): string {
  const copy: Record<string, string> = {
    NAME_FORMAT_NONSTANDARD: '图标名称格式需要确认：请确认最终名称是否符合仓库命名习惯。',
    NAME_SEMANTIC_UNCLEAR: '图标名称或用途不够清晰：请结合设计说明确认语义。',
    SVG_LITERAL_COLOR: '图标使用了固定颜色：建议确认是否应改为 currentColor。',
    SVG_STROKE_PRESENT: '图标使用了描边：请确认字体渲染后的显示效果。',
    SVG_MASK_PRESENT: '图标使用了遮罩或裁剪：请确认字体构建兼容性。',
    SVG_COMPLEX_TRANSFORM: '图标包含复杂变换：请确认构建后的轮廓。',
    SVG_OPACITY_PRESENT: '图标使用了透明度：请确认实际视觉是否符合预期。',
    TARGET_IS_ALIAS: '替换目标使用了别名：请确认解析后的主名称是否正确。',
    DELETE_POSSIBLE_USAGE: '删除可能影响现有调用：请在合入前检查下游调用方。',
    DELETE_TARGET_HAS_ALIASES: '删除会同时移除别名：请确认同一编码下的全部名称都可移除。',
  };
  return copy[code] ?? '存在需要开发确认的自动化提醒，请查看技术详情中的原始规则。';
}

function warnings(validation: unknown): { review: string[]; technical: string[] } {
  if (!isObject(validation) || !Array.isArray(validation.warnings)) {
    return { review: [], technical: [] };
  }
  const entries = validation.warnings.flatMap((warning) => {
    if (!isObject(warning) || typeof warning.code !== 'string' || typeof warning.message !== 'string') {
      return [];
    }
    return [{ code: warning.code, message: warning.message }];
  });
  return {
    review: entries.map((warning) => `- ${warningReviewCopy(warning.code)}`),
    technical: entries.map((warning) => `- \`${inline(warning.code)}\`：${inline(warning.message)}`),
  };
}

function auditRequestHash(validation: unknown): string | null {
  return isObject(validation) && typeof validation.requestSha256 === 'string'
    ? validation.requestSha256
    : null;
}

function changeSummary(items: StoredItem[]): string {
  const counts = items.reduce<Record<StoredItem['action'], number>>((result, item) => {
    result[item.action] += 1;
    return result;
  }, { add: 0, replace: 0, delete: 0 });
  return [
    counts.add ? `新增 ${counts.add} 项` : null,
    counts.replace ? `替换 ${counts.replace} 项` : null,
    counts.delete ? `删除 ${counts.delete} 项` : null,
  ].filter(Boolean).join('、') || '无变更项';
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
  const requestHash = auditRequestHash(batch.validation);
  const title = `chore(icons): ${inline(batch.title).slice(0, 160)}`;
  return {
    title,
    marker,
    body: [
      marker,
      '',
      '## 变更摘要',
      '',
      `**${inline(batch.title)}**`,
      '',
      `本次包含 ${batch.items.length} 项图标变更：${changeSummary(batch.items)}。`,
      ...(batch.designUrl ? [`- 设计稿：<${batch.designUrl}>`] : []),
      '',
      '## 设计说明',
      '',
      batch.description.trim(),
      '',
      '## 图标变更明细',
      '',
      '| 操作 | 设计输入 | 计划名称 | Codepoint | 说明 |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
      '',
      '## 开发审核提醒',
      '',
      ...(warningLines.review.length > 0 ? warningLines.review : ['- 无额外自动化提醒。']),
      '',
      '<details>',
      '<summary>技术详情与审计信息</summary>',
      '',
      `- 批次：\`${batch.id}\``,
      `- 提交人：${inline(batch.submitter.name)} <${batch.submitter.email}>（身份未经系统认证）`,
      `- 目标仓库：\`${batch.targetRepository.repository}:${batch.targetRepository.branch}\``,
      `- 上游基线：\`${batch.baseCommit}\``,
      `- 机器人分支：\`${batch.pushRepository}:${branch}\``,
      `- 机器人提交：\`${commitSha}\``,
      ...(requestHash ? [`- 校验请求 SHA256：\`${inline(requestHash)}\``] : []),
      '',
      '### 原始校验提醒',
      '',
      ...(warningLines.technical.length > 0 ? warningLines.technical : ['- 无。']),
      '',
      '</details>',
      '',
      '---',
      '',
      '此 PR 以 Draft 方式创建。创建成功后，平台不再 push 或修改该分支；后续调整由开发接管。',
    ].join('\n'),
  };
}
