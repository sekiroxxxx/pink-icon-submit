import type { ApiItem, Diagnostic, ItemAction } from './api';

export interface DisplayDiagnostic {
  title: string;
  reason: string;
  suggestion: string;
  itemName: string | null;
  location: string | null;
  technical: { code: string; message: string };
}

interface DiagnosticCopy {
  title: string;
  reason: string;
  suggestion: string;
}

const diagnosticCopy: Record<string, DiagnosticCopy> = {
  REQUEST_SCHEMA_INVALID: { title: '提交内容格式不正确', reason: '本次提交缺少必填信息或字段格式不符合要求。', suggestion: '检查标题、设计说明、设计稿链接和每项图标信息后重新校验。' },
  DUPLICATE_ITEM_ID: { title: '变更项重复', reason: '同一批次中出现了重复的变更项标识。', suggestion: '移除重复项后重新提交。' },
  BATCH_ACTION_CONFLICT: { title: '变更操作互相冲突', reason: '同一图标被安排了冲突的操作，或新增名称重复。', suggestion: '拆分冲突操作或修改重复名称后重新校验。' },
  SOURCE_FILE_MISSING: { title: '缺少 SVG 文件', reason: '新增或替换图标没有可用的 SVG 源文件。', suggestion: '重新上传对应 SVG 文件。' },
  SVG_INVALID_XML: { title: 'SVG 文件无法解析', reason: '上传的文件不是可安全解析的 SVG。', suggestion: '从设计工具重新导出 SVG 后再上传。' },
  SVG_MISSING_VIEWBOX: { title: 'SVG 缺少有效 viewBox', reason: 'SVG 没有四个有效数值的 viewBox，或宽高不为正数。', suggestion: '在设计工具中补齐 viewBox 后重新导出。' },
  SVG_SCRIPT: { title: 'SVG 包含不安全脚本', reason: 'SVG 中包含脚本、事件属性或脚本 URL。', suggestion: '删除脚本内容，保留静态路径后重新导出。' },
  SVG_EXTERNAL_RESOURCE: { title: 'SVG 引用了外部资源', reason: 'SVG 依赖网络、文件路径或其他外部资源。', suggestion: '将内容改为 SVG 内的静态路径，或重新导出。' },
  SVG_EMBEDDED_BITMAP: { title: 'SVG 包含位图', reason: 'SVG 中含有 image、base64 或 data URI 位图。', suggestion: '改用矢量路径 SVG。' },
  SVG_GRADIENT: { title: 'SVG 包含渐变或纹理', reason: '图标使用了 gradient、pattern 等非单色效果。', suggestion: '调整为单色路径图标。' },
  SVG_STYLE_ELEMENT: { title: 'SVG 包含样式表', reason: 'MVP 不支持 style 元素或其中的 CSS 规则。', suggestion: '删除样式表，使用已校验的展示属性或重新导出。' },
  SVG_MULTIPLE_COLORS: { title: '图标包含多种颜色', reason: 'SVG 解析后发现多个实际非透明颜色。', suggestion: '调整为单色图标后重新导出。' },
  ADD_NAME_COLLISION: { title: '新增图标名称已被使用', reason: '建议名称与现有图标主名称或别名冲突。', suggestion: '换一个未使用的图标名称后重新校验。' },
  ADD_CODEPOINT_EXHAUSTED: { title: '图标编码范围已用尽', reason: 'PinK 当前可分配的编码范围没有剩余位置。', suggestion: '请联系仓库维护者确认后续编码范围。' },
  TARGET_NOT_FOUND: { title: '未找到目标图标', reason: '替换或删除的图标不在当前目录中。', suggestion: '刷新目录后重新选择目标图标。' },
  CATALOG_TARGET_NOT_FOUND: { title: '目标图标不在当前目录基线中', reason: '替换或删除的目标不在本次校验使用的固定目录快照内。', suggestion: '重新从目录选择目标图标后再校验。' },
  TARGET_REPOSITORY_INVALID: { title: '目标仓库配置无效', reason: '自动化没有收到合法的目标仓库信息。', suggestion: '请联系平台维护者修正配置后重新校验。' },
  TARGET_REPOSITORY_MISMATCH: { title: '目标仓库与批次不一致', reason: '当前校验目标与批次绑定的目标仓库不同。', suggestion: '请联系平台维护者恢复与批次一致的目标后重试。' },
  MAPPING_SOURCE_INVALID: { title: '图标映射无法解析', reason: '仓库中的 mapping 与 SVG source 不能唯一对应。', suggestion: '请联系仓库维护者修复映射后重试。' },
  RETIRED_CODEPOINT_ACTIVE: { title: '仓库编码记录冲突', reason: '同一编码同时被标记为在用和已退役。', suggestion: '请联系仓库维护者修复编码记录。' },
  DELETE_TARGET_IS_ALIAS: { title: '删除目标是别名', reason: '系统无法安全判断删除别名还是整个图标编码。', suggestion: '请选择主名称图标，或交由开发手工处理。' },
  BASE_COMMIT_CHANGED: { title: '图标仓库基线已变化', reason: '校验或计划期间目标仓库已有新提交。', suggestion: '按最新内容重新校验后再生成修改。' },
  SOURCE_HASH_CHANGED: { title: 'SVG 文件已变化', reason: '计划生成后，上传的 SVG 内容发生了变化。', suggestion: '重新上传最新 SVG 并重新校验。' },
  PLAN_REQUEST_MISSING: { title: '缺少原始校验请求', reason: '系统无法取得生成计划所需的原始请求文件。', suggestion: '请重新校验本批次。' },
  REQUEST_HASH_CHANGED: { title: '校验请求已变化', reason: '当前请求与生成计划时的内容不一致。', suggestion: '请重新校验并重新生成计划。' },
  PLAN_REQUEST_INVALID: { title: '计划内容已不再有效', reason: '生成修改时，当前请求或 SVG 未能再次通过校验。', suggestion: '修正内容后重新校验。' },
  PLAN_REQUEST_MISMATCH: { title: '计划与当前请求不一致', reason: '保存的计划不是基于当前请求和仓库基线生成的。', suggestion: '丢弃旧计划后重新校验。' },
  APPLY_OUTSIDE_ALLOWLIST: { title: '生成修改超出允许范围', reason: '自动化检测到计划外的文件修改。', suggestion: '请停止处理并联系平台维护者检查。' },
  NAME_FORMAT_NONSTANDARD: { title: '图标名称格式需要确认', reason: '名称不完全符合仓库的常用命名格式。', suggestion: '确认最终名称是否应规范化，开发审核时会再次检查。' },
  NAME_SEMANTIC_UNCLEAR: { title: '图标名称或用途不够清晰', reason: '名称与用途说明难以判断图标表达的语义。', suggestion: '补充更清晰的用途说明，或与开发确认命名。' },
  SVG_LITERAL_COLOR: { title: '图标使用了固定颜色', reason: 'SVG 使用了单一固定颜色，而不是 currentColor。', suggestion: '建议改为 currentColor，保持图标在不同主题中的一致性。' },
  SVG_STROKE_PRESENT: { title: '图标使用了描边', reason: 'SVG 包含非 none 的 stroke，字体渲染时可能出现差异。', suggestion: '请开发审核描边在字体中的显示效果。' },
  SVG_MASK_PRESENT: { title: '图标使用了遮罩或裁剪', reason: 'SVG 包含 mask 或 clip-path，字体构建兼容性需要确认。', suggestion: '请开发审核构建后的显示效果。' },
  SVG_COMPLEX_TRANSFORM: { title: '图标包含复杂变换', reason: 'SVG 使用了复杂 transform，预览与字体轮廓可能不同。', suggestion: '请开发审核构建后的轮廓。' },
  SVG_OPACITY_PRESENT: { title: '图标使用了透明度', reason: 'SVG 包含 opacity、fill-opacity 或 stroke-opacity。', suggestion: '请开发确认实际视觉是否符合单色图标要求。' },
  TARGET_IS_ALIAS: { title: '替换目标使用了别名', reason: '系统已将别名解析到主名称，但需要确认目标是否正确。', suggestion: '请开发审核解析后的目标图标。' },
  DELETE_POSSIBLE_USAGE: { title: '删除可能影响现有调用', reason: '自动化无法证明没有下游代码仍在使用该图标。', suggestion: '请开发在合入前检查调用方；必要时提供替代图标。' },
  DELETE_TARGET_HAS_ALIASES: { title: '删除会同时移除别名', reason: '删除主名称会移除同一编码下的所有别名。', suggestion: '请开发确认所有别名都可以一起移除。' },
};

function itemName(item: ApiItem | undefined): string | null {
  if (!item) return null;
  const name = item.action === 'add' ? item.designName : item.targetName;
  const action = item.action === 'add' ? '新增图标' : item.action === 'replace' ? '替换图标' : '删除图标';
  return name ? `${action}：${name}` : null;
}

function itemFromDiagnostic(diagnostic: Diagnostic, items: ApiItem[]): ApiItem | undefined {
  if (diagnostic.itemId) return items.find((item) => item.id === diagnostic.itemId);
  const itemIndex = diagnostic.path?.match(/(?:^|[.[])items\[(\d+)\]/)?.[1];
  return itemIndex === undefined ? undefined : items[Number(itemIndex)];
}

function locationFromPath(path: string | undefined): string | null {
  if (!path) return null;
  const field = path.match(/(?:\.|\[)\s*(designName|targetName|description|reason|replacementName|sourceFile|designUrl|title)\s*\]?$/)?.[1];
  const label = field === 'designName' ? '期望图标名称'
    : field === 'targetName' ? '目标图标'
      : field === 'description' ? '说明'
        : field === 'reason' ? '删除原因'
          : field === 'replacementName' ? '替代图标'
            : field === 'sourceFile' ? 'SVG 文件'
              : field === 'designUrl' ? '设计稿链接'
                : field === 'title' ? '变更标题'
                  : undefined;
  return label ? `字段：${label}` : `定位：${path}`;
}

export function displayDiagnostic(diagnostic: Diagnostic, items: ApiItem[]): DisplayDiagnostic {
  const copy = diagnosticCopy[diagnostic.code] ?? {
    title: '发现需要进一步确认的校验问题',
    reason: '自动校验返回了暂未识别的规则，平台无法安全地给出具体修改说明。',
    suggestion: '请查看技术详情，并联系开发或平台维护者协助处理。',
  };
  return {
    ...copy,
    itemName: itemName(itemFromDiagnostic(diagnostic, items)),
    location: locationFromPath(diagnostic.path),
    technical: { code: diagnostic.code, message: diagnostic.message },
  };
}

export function operationLabel(action: ItemAction): string {
  return { add: '新增', replace: '替换', delete: '删除' }[action];
}
