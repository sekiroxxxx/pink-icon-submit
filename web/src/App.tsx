import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { api, ApiError, type ApiItem, type AuthenticatedUser, type BatchDetails, type BatchSummary, type CatalogGroup, type CatalogPageIcon, type Diagnostic, type ItemAction, type ItemInput, type UserBatchStatus } from './api';
import { displayDiagnostic } from './diagnostics';

interface SvgDraft {
  id: string;
  file: File;
  previewUrl: string | undefined;
  content: string;
  warning?: string;
}

interface DraftCatalogIcon {
  primaryName: string;
  svg?: string;
}

interface DraftChange {
  clientId: string;
  serverId?: string;
  action: ItemAction;
  designName?: string;
  target?: DraftCatalogIcon;
  description?: string;
  reason?: string;
  replacement?: DraftCatalogIcon;
  svg?: SvgDraft;
  uploadedSourceFile?: string | null;
}

interface TargetUse {
  action: 'replace' | 'delete';
  itemNumber: number;
}

type FieldErrors = Record<string, string>;
type AppView = 'home' | 'workbench';
interface AppRoute {
  view: AppView;
  batchId?: string;
}

const pageSize = 24;
const defaultUploadLimit = 1024 * 1024;
const limits = {
  batchTitle: 200,
  batchDescription: 5_000,
  itemText: 1_000,
  name: 100,
};
let nextClientId = 1;

function uniqueId(prefix: string): string {
  return `${prefix}-${nextClientId++}`;
}

function routeFromLocation(): AppRoute {
  if (window.location.pathname !== '/workbench') return { view: 'home' };
  const batchId = new URLSearchParams(window.location.search).get('batch')?.trim();
  return batchId ? { view: 'workbench', batchId } : { view: 'workbench' };
}

function routePath(route: AppRoute): string {
  if (route.view === 'home') return '/';
  return route.batchId ? `/workbench?batch=${encodeURIComponent(route.batchId)}` : '/workbench';
}

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function svgPreviewUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function createSvgDraft(file: File): SvgDraft {
  const previewUrl = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined;
  return { id: uniqueId('svg'), file, previewUrl, content: '' };
}

function revokePreview(svg: SvgDraft | undefined): void {
  if (svg?.previewUrl && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(svg.previewUrl);
  }
}

function toItemInput(change: DraftChange): ItemInput {
  if (change.action === 'add') {
    return { action: 'add', designName: change.designName, description: change.description };
  }
  if (change.action === 'replace') {
    return { action: 'replace', targetName: change.target?.primaryName, ...(change.description ? { description: change.description } : {}) };
  }
  return {
    action: 'delete',
    targetName: change.target?.primaryName,
    reason: change.reason,
    ...(change.replacement ? { replacementName: change.replacement.primaryName } : {}),
  };
}

function draftIcon(primaryName: string | undefined): DraftCatalogIcon | undefined {
  return primaryName ? { primaryName } : undefined;
}

function draftChangeFromItem(item: ApiItem): DraftChange {
  return {
    clientId: uniqueId('change'),
    serverId: item.id,
    action: item.action,
    ...(item.designName ? { designName: item.designName } : {}),
    ...(item.targetName ? { target: draftIcon(item.targetName) } : {}),
    ...(item.description ? { description: item.description } : {}),
    ...(item.reason ? { reason: item.reason } : {}),
    ...(item.replacementName ? { replacement: draftIcon(item.replacementName) } : {}),
    uploadedSourceFile: item.sourceFile,
  };
}

function draftChangesFromBatch(batch: Pick<BatchDetails, 'items'>): DraftChange[] {
  return batch.items.map(draftChangeFromItem);
}

function savedDraftChange(change: DraftChange, item: ApiItem): DraftChange {
  return { ...change, serverId: item.id, uploadedSourceFile: item.sourceFile };
}

function itemMatchesDraft(item: ApiItem, change: DraftChange): boolean {
  const input = toItemInput(change);
  return item.action === input.action
    && (item.designName ?? undefined) === input.designName
    && (item.targetName ?? undefined) === input.targetName
    && (item.description ?? undefined) === input.description
    && (item.reason ?? undefined) === input.reason
    && (item.replacementName ?? undefined) === input.replacementName
    && Boolean(item.sourceFile) === Boolean(change.svg);
}

function draftChangesMatch(left: DraftChange, right: DraftChange): boolean {
  return JSON.stringify(toItemInput(left)) === JSON.stringify(toItemInput(right))
    && left.svg?.id === right.svg?.id;
}

function batchMetadataMatches(batch: BatchDetails, metadata: { title: string; description: string; designUrl?: string }): boolean {
  return batch.title === metadata.title
    && batch.description === metadata.description
    && (batch.designUrl ?? undefined) === metadata.designUrl;
}

function reconcileDraftChanges(batch: Pick<BatchDetails, 'items'>, currentChanges: DraftChange[]): DraftChange[] {
  const restored = draftChangesFromBatch(batch);
  const restoredByServerId = new Map(restored.map((change) => [change.serverId!, change]));
  const reconciled = currentChanges.flatMap((change) => {
    if (!change.serverId) return [change];
    const restoredChange = restoredByServerId.get(change.serverId);
    if (!restoredChange) return [];
    restoredByServerId.delete(change.serverId);
    return [{ ...restoredChange, clientId: change.clientId }];
  });
  return [...reconciled, ...restoredByServerId.values()];
}

function sourceFileLabel(sourceFile: string): string {
  return sourceFile.split(/[\\/]/).at(-1) ?? sourceFile;
}

function localNameIssue(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return '请填写期望图标名称。';
  if (trimmed.length > limits.name) return `期望图标名称不能超过 ${limits.name} 个字符。`;
  if (/\s/.test(value) || /[\\/]/.test(value)) return '期望图标名称不能包含空白或路径分隔符。';
  return undefined;
}

function fieldLengthIssue(value: string, field: string, maximumLength: number): string | undefined {
  return value.length > maximumLength ? `${field}不能超过 ${maximumLength} 个字符。` : undefined;
}

async function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read file.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(file);
  });
}

function validViewBox(value: string | null): boolean {
  if (!value) return false;
  const values = value.trim().split(/[\s,]+/).map(Number);
  return values.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0;
}

async function inspectSvg(file: File): Promise<{ content?: string; error?: string; warning?: string }> {
  if (!file.name.toLowerCase().endsWith('.svg')) {
    return { error: '请选择扩展名为 .svg 的文件。' };
  }
  if (file.size === 0) {
    return { error: 'SVG 文件不能为空。' };
  }
  let content: string;
  try {
    content = await readFileText(file);
  } catch {
    return { error: '无法读取这个 SVG 文件。' };
  }
  const document = new DOMParser().parseFromString(content, 'image/svg+xml');
  const root = document.documentElement;
  if (root.localName === 'parsererror' || document.querySelector('parsererror')) {
    return { error: '浏览器无法解析这个 SVG 文件。' };
  }
  if (root.localName.toLowerCase() !== 'svg') {
    return { error: '文件根节点必须是 <svg>。' };
  }
  if (!validViewBox(root.getAttribute('viewBox'))) {
    return { error: 'SVG 必须包含四个数值且宽高为正数的 viewBox。' };
  }
  return {
    content,
    ...(file.size > defaultUploadLimit ? { warning: '文件大于当前默认 1 MB 限制，上传接口可能拒绝它。' } : {}),
  };
}

function actionLabel(action: ItemAction): string {
  return { add: '新增', replace: '替换', delete: '删除' }[action];
}

function targetUseLabel(use: TargetUse): string {
  return `已用于第 ${use.itemNumber} 项${actionLabel(use.action)}`;
}

function RequiredMark() {
  return <span className="required-mark" aria-label="必填">*</span>;
}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="field-error" role="alert">{message}</p> : null;
}

function FieldCounter({ value, maximum }: { value: string; maximum: number }) {
  return <small className={`field-counter ${value.length > maximum ? 'over' : ''}`}>{value.length} / {maximum}</small>;
}

function LoginPage({ onLogin }: { onLogin: (input: { username: string; password: string }) => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError('请填写账号和密码。');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onLogin({ username: username.trim(), password });
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : '登录未完成，请稍后重试。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="identity-overlay" aria-labelledby="login-title">
      <section className="identity-dialog">
        <div className="brand-mark">P</div>
        <h1 id="login-title">登录 PinK 图标工作台</h1>
        <p>使用已由内部管理员预置的账号登录。登录后仅能查看和处理自己的批次。</p>
        <form onSubmit={(event) => void submit(event)}>
          <div className="form-field">
            <label htmlFor="login-username">账号（公司邮箱）<RequiredMark /></label>
            <input id="login-username" type="email" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="name@company.com" disabled={busy} />
          </div>
          <div className="form-field">
            <label htmlFor="login-password">密码<RequiredMark /></label>
            <input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
          </div>
          <FieldError message={error} />
          <div className="dialog-actions"><button className="button primary" type="submit" disabled={busy}>{busy ? '正在登录…' : '登录'}</button></div>
        </form>
      </section>
    </main>
  );
}

function SvgPreview({ svg, alt, className }: { svg: SvgDraft; alt: string; className?: string }) {
  if (!svg.previewUrl) {
    return <span className={className}>{svg.file.name.slice(0, 1).toUpperCase()}</span>;
  }
  return <img className={className} src={svg.previewUrl} alt={alt} />;
}

function CatalogBrowser({
  catalog,
  loading,
  error,
  query,
  group,
  selected,
  unavailableTargets,
  disabled,
  selectionCopy,
  onQueryChange,
  onGroupChange,
  onPageChange,
  onSelect,
  onClose,
}: {
  catalog?: Awaited<ReturnType<typeof api.getCatalogPage>>;
  loading: boolean;
  error?: string;
  query: string;
  group: CatalogGroup;
  selected?: CatalogPageIcon;
  unavailableTargets: ReadonlyMap<string, TargetUse>;
  disabled: boolean;
  selectionCopy: string;
  onQueryChange: (value: string) => void;
  onGroupChange: (value: CatalogGroup) => void;
  onPageChange: (page: number) => void;
  onSelect: (icon: CatalogPageIcon) => void;
  onClose: () => void;
}) {
  const totalPages = catalog ? Math.max(1, Math.ceil(catalog.total / catalog.pageSize)) : 1;
  const groups: Array<{ value: CatalogGroup; label: string }> = [
    { value: 'all', label: '全部' },
    { value: 'pink', label: 'PinK' },
    { value: 'toolbar', label: '工具栏' },
    { value: 'common', label: '通用' },
  ];

  return (
    <div className="catalog-overlay" role="presentation">
      <section className="catalog-browser" role="dialog" aria-modal="true" aria-labelledby="catalog-title">
      <div className="catalog-heading">
        <div>
          <p className="eyebrow">选择现有图标</p>
          <h3 id="catalog-title">图标目录</h3>
        </div>
        <div><span>{catalog ? `${catalog.total} 个结果` : '加载中…'}</span><button type="button" onClick={onClose} aria-label="关闭图标目录">×</button></div>
      </div>
      <p className="catalog-copy">{selectionCopy} 名称与 alias 都能搜索。</p>
      <label className="sr-only" htmlFor="catalog-search">搜索名称或别名</label>
      <input id="catalog-search" type="search" value={query} disabled={disabled} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索名称或别名，例如 pink、preview、logo" />
      <div className="filter-row" aria-label="图标分类">
        {groups.map((option) => <button key={option.value} className={`filter ${group === option.value ? 'active' : ''}`} type="button" disabled={disabled} onClick={() => onGroupChange(option.value)}>{option.label}</button>)}
      </div>
      {error && <p className="inline-error">图标目录加载失败：{error}</p>}
      <div className="catalog-grid" aria-busy={loading}>
        {loading && <p className="catalog-empty">正在读取最新图标目录…</p>}
        {!loading && catalog?.icons.length === 0 && <p className="catalog-empty">没有匹配的图标。试试其他搜索词或分类。</p>}
        {!loading && catalog?.icons.map((icon) => {
          const targetUse = unavailableTargets.get(icon.primaryName);
          const unavailable = targetUse !== undefined && selected?.primaryName !== icon.primaryName;
          return (
            <button
              key={icon.primaryName}
              className={`catalog-card ${selected?.primaryName === icon.primaryName ? 'selected' : ''} ${unavailable ? 'used' : ''}`}
              type="button"
              disabled={disabled || unavailable}
              onClick={() => onSelect(icon)}
              aria-label={unavailable ? `${icon.primaryName} ${targetUseLabel(targetUse)}` : `选择 ${icon.primaryName}`}
              title={unavailable ? `${icon.primaryName}${targetUseLabel(targetUse)}，不能在同一批次重复修改。` : undefined}
            >
              <img src={svgPreviewUrl(icon.svg)} alt="" />
              <strong>{icon.primaryName}</strong>
            </button>
          );
        })}
      </div>
      {catalog && totalPages > 1 && (
        <div className="catalog-pagination">
          <button type="button" disabled={disabled || catalog.page === 1} onClick={() => onPageChange(catalog.page - 1)}>上一页</button>
          <span>第 {catalog.page} / {totalPages} 页</span>
          <button type="button" disabled={disabled || catalog.page === totalPages} onClick={() => onPageChange(catalog.page + 1)}>下一页</button>
        </div>
      )}
      </section>
    </div>
  );
}

function TargetZone({ action, target, error, disabled, onOpenCatalog, onClear }: { action: 'replace' | 'delete'; target?: CatalogPageIcon; error?: string; disabled: boolean; onOpenCatalog: () => void; onClear: () => void }) {
  const label = action === 'replace' ? '需要替换的图标' : '需要删除的图标';
  return (
    <div className="form-field">
      <span className="field-label">{label}<RequiredMark /></span>
      <div className={`target-zone ${target ? 'has-target' : ''}`}>
        {target ? (
          <div className="target-card">
            <img src={svgPreviewUrl(target.svg)} alt={`${target.primaryName} 当前图标`} />
            <span><strong>{target.primaryName}</strong><small>{action === 'replace' ? '待替换图标' : '待删除图标'} · {target.aliases.join(' · ') || target.group}</small></span>
            <button type="button" disabled={disabled} onClick={() => { onClear(); onOpenCatalog(); }}>更换图标</button>
          </div>
        ) : (
          <div className="target-empty"><strong>尚未选择图标</strong><button className="button secondary" type="button" disabled={disabled} onClick={onOpenCatalog}>选择图标</button></div>
        )}
      </div>
      <FieldError message={error} />
    </div>
  );
}

function SvgQueue({ pending, activeSvgId, disabled, error, onQueue, onActivate, onRemove }: {
  pending: SvgDraft[];
  activeSvgId?: string;
  disabled: boolean;
  error?: string;
  onQueue: (files: FileList | File[]) => void;
  onActivate: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const active = pending.find((svg) => svg.id === activeSvgId);
  return (
    <div className="form-field">
      <span className="field-label">新的 SVG 文件<RequiredMark /></span>
      <label
        className={`upload-zone ${disabled ? 'disabled' : ''}`}
        onDragOver={(event) => { if (!disabled) event.preventDefault(); }}
        onDrop={(event) => {
          event.preventDefault();
          if (!disabled && event.dataTransfer.files.length) onQueue(event.dataTransfer.files);
        }}
      >
        <input type="file" accept="image/svg+xml,.svg" multiple disabled={disabled} onChange={(event) => { if (event.target.files?.length) onQueue(event.target.files); event.target.value = ''; }} />
        <strong>拖入一个或多个 SVG 到这里</strong>
        <span>或点击选择文件（可一次选择多个 .svg）</span>
      </label>
      {active && <div className="active-svg-preview"><SvgPreview svg={active} alt={`${active.file.name} 预览`} /><span><strong>{active.file.name}</strong><small>当前待处理 SVG</small>{active.warning && <small className="svg-warning">{active.warning}</small>}</span></div>}
      {pending.length > 0 && (
        <div className="pending-svg">
          <div className="pending-heading"><strong>待处理 SVG</strong><span>{pending.length} 个</span></div>
          <div className="pending-grid">
            {pending.map((svg) => (
              <div key={svg.id} className={`pending-card ${svg.id === activeSvgId ? 'active' : ''}`}>
                <button type="button" disabled={disabled} onClick={() => onActivate(svg.id)} aria-label={`选择 ${svg.file.name}`}>
                  <SvgPreview svg={svg} alt={`${svg.file.name} 预览`} />
                  <strong>{svg.file.name}</strong>
                  <span>{svg.id === activeSvgId ? '当前待处理' : '点击切换'}</span>
                </button>
                <button className="remove-pending" type="button" disabled={disabled} onClick={() => onRemove(svg.id)} aria-label={`移除 ${svg.file.name}`}>×</button>
              </div>
            ))}
          </div>
        </div>
      )}
      <p className="field-hint">每个 SVG 都会显示独立预览，可一次加入多个图标变更。</p>
      <FieldError message={error} />
    </div>
  );
}

function ChangeCard({ change, disabled, onRemove }: { change: DraftChange; disabled: boolean; onRemove: () => void }) {
  const label = { add: '新增', replace: '替换', delete: '删除' }[change.action];
  const uploadedFile = change.svg?.file.name ?? (change.uploadedSourceFile ? sourceFileLabel(change.uploadedSourceFile) : undefined);
  return (
    <article className={`change-card ${change.action}`}>
      {change.action === 'replace' && change.target?.svg && <img src={svgPreviewUrl(change.target.svg)} alt={`${change.target.primaryName} 当前图标`} />}
      {change.action === 'replace' && <span className="change-arrow">→</span>}
      {change.svg && <SvgPreview svg={change.svg} alt={`${change.svg.file.name} 预览`} className="change-preview" />}
      {change.action === 'delete' && change.target?.svg && <img src={svgPreviewUrl(change.target.svg)} alt={`${change.target.primaryName} 当前图标`} />}
      <span><strong>{label} · {change.action === 'add' ? change.designName : change.target?.primaryName}</strong><small>{change.action === 'delete' ? '将从图标仓库移除' : uploadedFile ? `已上传：${uploadedFile}` : 'SVG 将在提交时上传'}</small></span>
      <button type="button" disabled={disabled} onClick={onRemove} aria-label={`移除 ${change.action === 'add' ? change.designName : change.target?.primaryName}`}>×</button>
    </article>
  );
}

function DiagnosticList({ title, diagnostics, tone, items }: { title: string; diagnostics: Diagnostic[]; tone: 'error' | 'warning'; items: ApiItem[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <section className={`diagnostics ${tone}`} aria-label={title}>
      <h2>{title}</h2>
      <ul>{diagnostics.map((diagnostic, index) => {
        const displayed = displayDiagnostic(diagnostic, items);
        return (
          <li key={`${diagnostic.code}-${diagnostic.itemId ?? index}`}>
            <strong>{displayed.title}</strong>
            {displayed.itemName && <span>对应图标：{displayed.itemName}</span>}
            {displayed.location && <span>{displayed.location}</span>}
            <span>{displayed.reason}</span>
            <span>建议：{displayed.suggestion}</span>
            <details><summary>技术详情</summary><p>规则：<code>{displayed.technical.code}</code></p><p>{displayed.technical.message}</p></details>
          </li>
        );
      })}</ul>
    </section>
  );
}

function isFinalValidationFailure(batch: BatchDetails): boolean {
  return batch.state === 'FAILED'
    && batch.userStatus === 'needs_changes';
}

function canResumeDraftPullRequest(batch: BatchDetails): boolean {
  return batch.userStatus === 'delivery_retryable'
    && (batch.delivery.checkpoint === 'BRANCH_PUSHED' || batch.delivery.checkpoint === 'PR_CREATING')
    && batch.delivery.pullRequest === null;
}

function canRetryDelivery(batch: BatchDetails): boolean {
  return batch.userStatus === 'delivery_retryable';
}

function batchStatus(batch: BatchDetails): UserBatchStatus {
  return batch.userStatus;
}

function summaryStatus(batch: BatchSummary): UserBatchStatus {
  return batch.userStatus;
}

function isActiveBatch(batch: BatchDetails): boolean {
  const status = batchStatus(batch);
  return status === 'draft'
    || status === 'processing'
    || status === 'needs_changes'
    || status === 'delivery_retryable';
}

function statusLabel(status: UserBatchStatus): string {
  return {
    draft: '草稿',
    processing: '处理中',
    needs_changes: '需要修改',
    delivery_retryable: '交付暂时失败',
    developer_attention: '需要开发处理',
    submitted_review: '已提交开发审核',
    local_complete: '本地预览已完成',
  }[status];
}

function statusTone(status: UserBatchStatus): 'draft' | 'processing' | 'warning' | 'danger' | 'success' {
  if (status === 'draft') return 'draft';
  if (status === 'processing') return 'processing';
  if (status === 'needs_changes' || status === 'delivery_retryable') return 'warning';
  if (status === 'developer_attention') return 'danger';
  return 'success';
}

function formatBatchTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function itemCountSummary(counts: BatchSummary['itemCounts']): string {
  const pieces = [
    counts.add ? `新增 ${counts.add}` : '',
    counts.replace ? `替换 ${counts.replace}` : '',
    counts.delete ? `删除 ${counts.delete}` : '',
  ].filter(Boolean);
  return pieces.length > 0 ? pieces.join(' · ') : '尚未添加变更';
}

function HomePage({
  activeBatch,
  restoringActiveBatch,
  summaries,
  loading,
  error,
  notice,
  onNew,
  onOpenActive,
  onReturnToEdit,
  onOpenSummary,
}: {
  activeBatch?: BatchDetails;
  restoringActiveBatch: boolean;
  summaries: BatchSummary[];
  loading: boolean;
  error?: string;
  notice?: string;
  onNew: () => void;
  onOpenActive: () => void;
  onReturnToEdit: () => void;
  onOpenSummary: (batchId: string) => void;
}) {
  const activeStatus = activeBatch ? batchStatus(activeBatch) : undefined;
  const activeAction = !activeBatch
    ? { label: '新建图标变更', onClick: onNew }
    : activeStatus === 'draft'
      ? { label: '继续编辑', onClick: onOpenActive }
    : activeStatus === 'needs_changes'
        ? activeBatch.state === 'DRAFT'
          ? { label: '继续编辑', onClick: onOpenActive }
          : { label: '返回修改', onClick: onReturnToEdit }
        : activeStatus === 'processing'
          ? { label: '查看处理中', onClick: onOpenActive }
          : { label: '恢复交付', onClick: onOpenActive };

  return (
    <main className="page-shell home-page">
      <header className="page-header"><p className="eyebrow">PinK 图标设计交付</p><h1>把图标设计交给开发审核</h1><p>新建一次图标变更，或回到当前批次继续处理。</p></header>
      {notice && <p className="notice app-toast" role="status">{notice}</p>}
      <section className="home-hero" aria-labelledby="home-entry-title">
        <div><p className="eyebrow">开始一项新工作</p><h2 id="home-entry-title">创建图标变更</h2><p>在工作台中新增、替换或删除图标；确认提交后会进入最终校验和开发审核流程。</p></div>
        <button className="button primary" type="button" onClick={activeBatch ? activeAction.onClick : onNew}>{activeBatch ? activeAction.label : '新建图标变更'}</button>
      </section>
      <section className="active-batch-card" aria-labelledby="active-batch-title">
        <div>
          <p className="eyebrow">当前账号的活动批次</p>
          <h2 id="active-batch-title">{restoringActiveBatch ? '正在恢复本次交付' : activeBatch?.title ?? '暂时没有活动批次'}</h2>
          {restoringActiveBatch
            ? <p>正在恢复当前账号尚未完成的批次。</p>
            : activeBatch
              ? <p>{itemCountSummary({
                total: activeBatch.items.length,
                add: activeBatch.items.filter((item) => item.action === 'add').length,
                replace: activeBatch.items.filter((item) => item.action === 'replace').length,
                delete: activeBatch.items.filter((item) => item.action === 'delete').length,
              })} · 创建于 {formatBatchTime(activeBatch.createdAt)}</p>
              : <p>新建后可在登录账号下继续处理当前工作台。</p>}
        </div>
        {activeBatch && activeStatus && <div className="active-batch-actions"><span className={`status-pill ${statusTone(activeStatus)}`}>{statusLabel(activeStatus)}</span><button className="button secondary" type="button" onClick={activeAction.onClick}>{activeAction.label}</button></div>}
      </section>
      <section className="history-card" aria-labelledby="history-title">
        <div className="history-heading"><div><p className="eyebrow">最近记录</p><h2 id="history-title">最近 20 条批次</h2></div></div>
        {loading && <p className="history-empty">正在读取最近批次…</p>}
        {error && <p className="inline-error">{error}</p>}
        {!loading && !error && summaries.length === 0 && <p className="history-empty">还没有提交记录。创建第一个图标变更吧。</p>}
        {!loading && summaries.length > 0 && <ul className="history-list">{summaries.map((summary) => {
          const status = summaryStatus(summary);
          return <li key={summary.id}>
            <div><strong>{summary.title}</strong><span>{formatBatchTime(summary.createdAt)} · {itemCountSummary(summary.itemCounts)}</span></div>
            <div className="history-actions"><span className={`status-pill ${statusTone(status)}`}>{statusLabel(status)}</span><button className="button secondary" type="button" onClick={() => onOpenSummary(summary.id)}>查看</button></div>
          </li>;
        })}</ul>}
      </section>
    </main>
  );
}

function DeliveryStatusCard({
  batch,
  busy,
  readOnly,
  notice,
  repeatedSubmissionConfirmation,
  onReturnToEdit,
  onRetry,
  onClone,
  onConfirmRepeatedSubmission,
}: {
  batch: BatchDetails;
  busy: boolean;
  readOnly: boolean;
  notice?: string;
  repeatedSubmissionConfirmation: boolean;
  onReturnToEdit: () => void;
  onRetry: () => void;
  onClone: () => void;
  onConfirmRepeatedSubmission: () => void;
}) {
  const finalValidationFailure = isFinalValidationFailure(batch);
  const retainedValidation = batch.userStatus === 'needs_changes' && batch.validation?.valid === false;
  const draftPullRequestRecoveryFailure = batch.state === 'FAILED'
    && (batch.delivery.checkpoint === 'BRANCH_PUSHED' || batch.delivery.checkpoint === 'PR_CREATING');
  const canResumeDraftPr = canResumeDraftPullRequest(batch);
  const localResult = batch.state === 'LOCAL_DIFF_READY'
    && (batch.executionMode === 'local' || batch.executionMode === null);
  const draftPr = batch.delivery.pullRequest;
  const cloneableTerminal = batch.userStatus === 'developer_attention'
    || batch.userStatus === 'submitted_review'
    || batch.userStatus === 'local_complete';
  let headline = '本次交付尚未提交';
  let description = '你可以继续编辑本次变更，然后确认提交。';

  if (draftPr || batch.state === 'PR_CREATED') {
    headline = 'Draft PR 已创建';
    description = '已交给开发审核和接管；平台不会再写入这次交付。';
  } else if (localResult) {
    headline = batch.executionMode === null ? '历史本地结果已生成' : '本地预览已完成';
    description = batch.executionMode === null
      ? '此历史批次不会自动创建 PR；如需自动提 PR，请新建批次。'
      : '此模式不会创建 PR。';
  } else if (retainedValidation) {
    headline = '需要修改';
    description = batch.state === 'DRAFT'
      ? '最终校验发现需要修正的问题。修改内容后，旧诊断会自动失效。'
      : '最终校验发现需要修正的问题。返回编辑后修改内容，再次确认提交。';
  } else if (canResumeDraftPr) {
    headline = '分支已推送，Draft PR 创建失败';
    description = '图标变更已安全推送。你可以仅重新尝试创建 Draft PR，不会重新提交图标变更。';
  } else if (draftPullRequestRecoveryFailure) {
    headline = 'Draft PR 创建无法自动恢复';
    description = '当前交付状态需要开发处理；平台不会重新提交图标变更。';
  } else if (batch.userStatus === 'developer_attention') {
    headline = '需要开发处理';
    description = '本次失败不是可由设计内容直接修正的问题。请联系开发处理，或基于当前设计新建批次。';
  } else if (batch.userStatus === 'delivery_retryable') {
    headline = '交付暂时失败';
    description = '本次交付暂未完成。确认技术问题后可手动重新尝试，不会自动重复交付。';
  } else if (batch.state === 'QUEUED') {
    headline = '已提交';
    description = '已接收本次设计，正在等待最终校验。';
  } else if (batch.state === 'VALIDATING' || (batch.state === 'RUNNING' && !batch.validation)) {
    headline = '正在最终校验';
    description = '正在按最新提交内容执行最终校验。';
  } else if (batch.state === 'RUNNING' || ['COMMIT_PREPARED', 'BRANCH_PUSHED', 'PR_CREATING'].includes(batch.state)) {
    headline = '正在交付';
    description = '最终校验已通过，正在准备交付结果。';
  } else if (batch.state === 'READY') {
    headline = '已提交';
    description = '正在等待继续交付。';
  }

  return (
    <section className="result-card delivery-status-card" aria-live="polite" aria-label="本次交付">
      <p className="eyebrow">本次交付</p>
      <h2>{headline}</h2>
      <p>{description}</p>
      {notice && <p className="notice delivery-notice">{notice}</p>}
      {draftPr && <p><a className="secondary-link" href={draftPr.url} target="_blank" rel="noreferrer">打开开发审核记录</a></p>}
      {localResult && batch.localDiff && <details><summary>查看技术详情</summary><ul>{batch.localDiff.changedFiles.map((file) => <li key={file}>{file}</li>)}</ul></details>}
      {batch.state === 'FAILED' && !finalValidationFailure && batch.error && (
        <details><summary>技术详情</summary><p>规则：<code>{batch.error.code}</code></p><p>{batch.error.message}</p></details>
      )}
      {finalValidationFailure && !readOnly && <div className="post-validation-actions"><button className="button primary" type="button" disabled={busy} onClick={onReturnToEdit}>返回编辑并修正</button></div>}
      {batch.state === 'FAILED' && canRetryDelivery(batch) && (!draftPullRequestRecoveryFailure || canResumeDraftPr) && !readOnly && <div className="post-validation-actions"><button className="button primary" type="button" disabled={busy} onClick={onRetry}>{canResumeDraftPr ? '重新尝试创建 Draft PR' : '重新尝试交付'}</button></div>}
      {cloneableTerminal && <div className="post-validation-actions"><button className="button secondary" type="button" disabled={busy} onClick={onClone}>基于此新建批次</button></div>}
      {repeatedSubmissionConfirmation && batch.state === 'DRAFT' && !readOnly && (
        <div className="post-validation-actions"><button className="button primary" type="button" disabled={busy} onClick={onConfirmRepeatedSubmission}>仍要按原内容再次提交</button></div>
      )}
    </section>
  );
}

function ReviewDrawer({
  changes,
  user,
  errors,
  confirmed,
  busy,
  onConfirmedChange,
  onClose,
  onSubmit,
}: {
  changes: DraftChange[];
  user: AuthenticatedUser;
  errors: FieldErrors;
  confirmed: boolean;
  busy: boolean;
  onConfirmedChange: (value: boolean) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="review-overlay" role="presentation">
      <section className="review-drawer" role="dialog" aria-modal="true" aria-labelledby="review-title">
        <div className="drawer-heading"><div><p className="eyebrow">提交前确认</p><h2 id="review-title">让开发准确理解这次设计</h2></div><button type="button" onClick={onClose} aria-label="关闭">×</button></div>
        <p className="review-note">提交人会自动使用登录账号 <strong>{user.username}</strong>。最终校验和后续开发审核会一并记录本次设计变更。</p>
        <section className="review-list" aria-label="本次变更清单"><h3>本次变更清单</h3>{changes.map((change) => <div key={change.clientId}><strong>{({ add: '新增', replace: '替换', delete: '删除' })[change.action]}</strong><span>{change.action === 'add' ? change.designName : change.target?.primaryName}{change.svg ? ` · ${change.svg.file.name}` : ''}</span></div>)}</section>
        <label className="confirm-check"><input type="checkbox" disabled={busy} checked={confirmed} onChange={(event) => onConfirmedChange(event.target.checked)} /><span>我确认以上设计意图和 SVG 文件正确，并同意交由后续自动校验和开发审核。</span></label>
        <FieldError message={errors.confirmed} />
        <div className="dialog-actions"><button className="button secondary" type="button" disabled={busy} onClick={onClose}>继续编辑</button><button className="button primary" type="button" disabled={busy} onClick={onSubmit}>{busy ? '正在提交…' : '确认提交'}</button></div>
      </section>
    </div>
  );
}

export function App() {
  const [authenticatedUser, setAuthenticatedUser] = useState<AuthenticatedUser | null | undefined>(undefined);
  const [route, setRoute] = useState<AppRoute>(() => routeFromLocation());
  const view = route.view;
  const [action, setAction] = useState<ItemAction>('add');
  const [pendingSvgs, setPendingSvgs] = useState<SvgDraft[]>([]);
  const [activeSvgId, setActiveSvgId] = useState<string>();
  const [changes, setChanges] = useState<DraftChange[]>([]);
  const [target, setTarget] = useState<CatalogPageIcon>();
  const [addName, setAddName] = useState('');
  const [addDescription, setAddDescription] = useState('');
  const [replaceDescription, setReplaceDescription] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [replacement, setReplacement] = useState<CatalogPageIcon>();
  const [changeErrors, setChangeErrors] = useState<FieldErrors>({});
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogGroup, setCatalogGroup] = useState<CatalogGroup>('all');
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof api.getCatalogPage>>>();
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string>();
  const [catalogSelection, setCatalogSelection] = useState<'target' | 'replacement'>('target');
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [batch, setBatch] = useState<BatchDetails>();
  const [activeBatchId, setActiveBatchId] = useState<string | undefined>();
  const [restoringActiveBatch, setRestoringActiveBatch] = useState(true);
  const [batchSummaries, setBatchSummaries] = useState<BatchSummary[]>([]);
  const [batchSummariesLoading, setBatchSummariesLoading] = useState(false);
  const [batchSummariesError, setBatchSummariesError] = useState<string>();
  const [batchForm, setBatchForm] = useState({ title: '', description: '', designUrl: '' });
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewErrors, setReviewErrors] = useState<FieldErrors>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [repeatedSubmissionConfirmation, setRepeatedSubmissionConfirmation] = useState(false);
  const liveSvgDrafts = useRef(new Map<string, SvgDraft>());
  const previousView = useRef<AppView>(view);
  const workbenchHydrationVersion = useRef(0);
  const authGeneration = useRef(0);
  const activeBatchIdRef = useRef<string | undefined>(activeBatchId);
  const lastReconciledWorkbenchPath = useRef<string | undefined>(undefined);
  const skipNextWorkbenchHydrationPath = useRef<string | undefined>(undefined);
  const draftMutationInFlight = useRef(false);
  const uncertainItemWrite = useRef<{
    batchId: string;
    change: DraftChange;
    existingIds: Set<string>;
    originalError: unknown;
  } | undefined>(undefined);

  const resetWorkbenchTransientState = useCallback(() => {
    liveSvgDrafts.current.forEach(revokePreview);
    liveSvgDrafts.current.clear();
    setAction('add');
    setPendingSvgs([]);
    setActiveSvgId(undefined);
    setChanges([]);
    setTarget(undefined);
    setAddName('');
    setAddDescription('');
    setReplaceDescription('');
    setDeleteReason('');
    setReplacement(undefined);
    setChangeErrors({});
    setCatalogQuery('');
    setCatalogGroup('all');
    setCatalogPage(1);
    setCatalog(undefined);
    setCatalogLoading(false);
    setCatalogError(undefined);
    setCatalogSelection('target');
    setCatalogOpen(false);
    setBatchForm({ title: '', description: '', designUrl: '' });
    setReviewOpen(false);
    setReviewErrors({});
    setConfirmed(false);
    setRepeatedSubmissionConfirmation(false);
    uncertainItemWrite.current = undefined;
  }, []);

  const setBrowserActiveBatch = useCallback((batchId: string | undefined) => {
    if (activeBatchIdRef.current !== batchId) {
      workbenchHydrationVersion.current += 1;
    }
    activeBatchIdRef.current = batchId;
    setActiveBatchId(batchId);
  }, []);

  const navigate = useCallback((next: AppRoute, replace = false) => {
    const nextPath = routePath(next);
    if (`${window.location.pathname}${window.location.search}` !== nextPath) {
      workbenchHydrationVersion.current += 1;
      lastReconciledWorkbenchPath.current = undefined;
      window.history[replace ? 'replaceState' : 'pushState']({}, '', nextPath);
    }
    setRoute(next);
  }, []);

  const resetToLogin = useCallback((nextNotice?: string) => {
    authGeneration.current += 1;
    workbenchHydrationVersion.current += 1;
    setBrowserActiveBatch(undefined);
    resetWorkbenchTransientState();
    setBatch(undefined);
    setBatchSummaries([]);
    setBatchSummariesError(undefined);
    setRestoringActiveBatch(false);
    setAuthenticatedUser(null);
    setNotice(nextNotice);
    navigate({ view: 'home' }, true);
  }, [navigate, resetWorkbenchTransientState, setBrowserActiveBatch]);

  const login = useCallback(async (input: { username: string; password: string }) => {
    const response = await api.login(input);
    authGeneration.current += 1;
    setRestoringActiveBatch(true);
    setAuthenticatedUser(response.user);
    setNotice('登录成功。');
    navigate({ view: 'home' }, true);
  }, [navigate]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      resetToLogin('已退出登录。');
    }
  }, [resetToLogin]);

  const refreshBatchSummaries = useCallback(async () => {
    if (!authenticatedUser) return;
    const requestGeneration = authGeneration.current;
    setBatchSummariesLoading(true);
    setBatchSummariesError(undefined);
    try {
      const summaries = await api.getBatches();
      if (authGeneration.current === requestGeneration) setBatchSummaries(summaries);
    } catch (error) {
      if (authGeneration.current === requestGeneration) {
        setBatchSummariesError(error instanceof Error ? `无法读取最近批次：${error.message}` : '无法读取最近批次。');
      }
    } finally {
      if (authGeneration.current === requestGeneration) setBatchSummariesLoading(false);
    }
  }, [authenticatedUser]);

  const hydrateWorkbenchFromDetails = useCallback((restored: BatchDetails, nextNotice?: string) => {
    resetWorkbenchTransientState();
    setBatch(restored);
    setChanges(draftChangesFromBatch(restored));
    setBatchForm({ title: restored.title, description: restored.description, designUrl: restored.designUrl ?? '' });
    setNotice(nextNotice);
  }, [resetWorkbenchTransientState]);

  const hydrateWorkbenchBatch = useCallback(async (
    batchId: string,
    options: { notice?: string; busy?: boolean } = {},
  ): Promise<BatchDetails | undefined> => {
    const hydrationVersion = workbenchHydrationVersion.current + 1;
    workbenchHydrationVersion.current = hydrationVersion;
    if (options.busy) setBusy(true);
    try {
      const restored = await api.getBatch(batchId);
      if (workbenchHydrationVersion.current !== hydrationVersion) return undefined;
      hydrateWorkbenchFromDetails(restored, options.notice);
      return restored;
    } catch (error) {
      if (workbenchHydrationVersion.current !== hydrationVersion) return undefined;
      throw error;
    } finally {
      if (options.busy && workbenchHydrationVersion.current === hydrationVersion) setBusy(false);
    }
  }, [hydrateWorkbenchFromDetails]);

  const completeActiveBatch = useCallback((completed: BatchDetails) => {
    if (isActiveBatch(completed) || activeBatchIdRef.current !== completed.id) return;
    lastReconciledWorkbenchPath.current = undefined;
    setBrowserActiveBatch(undefined);
    void refreshBatchSummaries();
    if (completed.state === 'PR_CREATED' && routeFromLocation().view === 'workbench') {
      setNotice('已提交开发审核。');
      navigate({ view: 'home' });
    }
  }, [navigate, refreshBatchSummaries, setBrowserActiveBatch]);

  const viewingActiveBatch = Boolean(batch && activeBatchId === batch.id && isActiveBatch(batch));
  const editable = !batch || (batch.state === 'DRAFT' && viewingActiveBatch);
  const needsCatalog = catalogOpen && editable && (action === 'replace' || action === 'delete');
  const activeSvg = useMemo(() => pendingSvgs.find((svg) => svg.id === activeSvgId), [activeSvgId, pendingSvgs]);
  const usedTargets = useMemo(() => {
    const result = new Map<string, TargetUse>();
    changes.forEach((change, index) => {
      if ((change.action === 'replace' || change.action === 'delete') && change.target) {
        result.set(change.target.primaryName, { action: change.action, itemNumber: index + 1 });
      }
    });
    return result;
  }, [changes]);
  const replacementUnavailableTargets = useMemo(() => {
    const result = new Map<string, TargetUse>();
    changes.forEach((change, index) => {
      if (change.action === 'delete' && change.target) {
        result.set(change.target.primaryName, { action: 'delete', itemNumber: index + 1 });
      }
    });
    if (target && action === 'delete') {
      result.set(target.primaryName, { action: 'delete', itemNumber: changes.length + 1 });
    }
    return result;
  }, [action, changes, target]);

  useEffect(() => () => {
    liveSvgDrafts.current.forEach(revokePreview);
    liveSvgDrafts.current.clear();
  }, []);

  useEffect(() => {
    const onPopState = () => {
      workbenchHydrationVersion.current += 1;
      lastReconciledWorkbenchPath.current = undefined;
      setRoute(routeFromLocation());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const onAuthenticationRequired = () => resetToLogin('登录状态已失效，请重新登录。');
    window.addEventListener('pink-icon-submit.authentication-required', onAuthenticationRequired);
    return () => window.removeEventListener('pink-icon-submit.authentication-required', onAuthenticationRequired);
  }, [resetToLogin]);

  useEffect(() => {
    let cancelled = false;
    void api.me()
      .then(({ user }) => {
        if (!cancelled) {
          setRestoringActiveBatch(true);
          setAuthenticatedUser(user);
        }
      })
      .catch(() => { if (!cancelled) setAuthenticatedUser(null); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!authenticatedUser) {
      setRestoringActiveBatch(false);
      return undefined;
    }
    let cancelled = false;
    const restoreVersion = workbenchHydrationVersion.current + 1;
    workbenchHydrationVersion.current = restoreVersion;
    setRestoringActiveBatch(true);
    void api.getActiveBatch()
      .then((restored) => {
        if (cancelled || workbenchHydrationVersion.current !== restoreVersion) return;
        if (!restored) {
          setBrowserActiveBatch(undefined);
          return;
        }
        setBrowserActiveBatch(restored.id);
        hydrateWorkbenchFromDetails(restored, '已恢复本次交付状态。');
        const restoredRoute = routeFromLocation();
        if (restoredRoute.view === 'workbench' && (!restoredRoute.batchId || restoredRoute.batchId === restored.id)) {
          lastReconciledWorkbenchPath.current = routePath(restoredRoute);
        }
        completeActiveBatch(restored);
      })
      .catch(() => {
        if (!cancelled && workbenchHydrationVersion.current === restoreVersion) {
          setBrowserActiveBatch(undefined);
          lastReconciledWorkbenchPath.current = undefined;
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRestoringActiveBatch(false);
        }
      });
    return () => { cancelled = true; };
  }, [authenticatedUser, completeActiveBatch, hydrateWorkbenchFromDetails, setBrowserActiveBatch]);

  useEffect(() => {
    void refreshBatchSummaries();
  }, [authenticatedUser, refreshBatchSummaries]);

  useEffect(() => {
    if (previousView.current === 'workbench' && view === 'home') {
      resetWorkbenchTransientState();
    }
    previousView.current = view;
  }, [resetWorkbenchTransientState, view]);

  useEffect(() => {
    if (!batch || activeBatchId !== batch.id) return;
    completeActiveBatch(batch);
  }, [activeBatchId, batch, completeActiveBatch]);

  useEffect(() => {
    const requestedBatchId = route.view === 'workbench' ? route.batchId : undefined;
    if (!authenticatedUser || route.view !== 'workbench' || restoringActiveBatch) return undefined;
    const currentPath = routePath(route);
    if (skipNextWorkbenchHydrationPath.current === currentPath) {
      skipNextWorkbenchHydrationPath.current = undefined;
      lastReconciledWorkbenchPath.current = currentPath;
      return undefined;
    }
    if (lastReconciledWorkbenchPath.current === currentPath) return undefined;
    lastReconciledWorkbenchPath.current = currentPath;
    if (!requestedBatchId && !activeBatchId) {
      workbenchHydrationVersion.current += 1;
      resetWorkbenchTransientState();
      setBatch(undefined);
      setNotice(undefined);
      return undefined;
    }
    const batchId = requestedBatchId ?? activeBatchId!;
    if (requestedBatchId && activeBatchId && activeBatchId !== requestedBatchId) {
      setNotice('请先完成当前批次。');
      navigate({ view: 'home' }, true);
      return undefined;
    }
    let cancelled = false;
    const openingHistory = Boolean(requestedBatchId && activeBatchId !== requestedBatchId);
    void hydrateWorkbenchBatch(batchId, {
      busy: true,
      notice: openingHistory ? '正在查看历史批次。' : '已恢复本次交付状态。',
    })
      .then((restored) => {
        if (cancelled || !restored) return;
        completeActiveBatch(restored);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (activeBatchId === batchId) setBrowserActiveBatch(undefined);
        setNotice(error instanceof Error ? `无法打开批次：${error.message}` : '无法打开批次。');
        navigate({ view: 'home' }, true);
      })
    return () => { cancelled = true; };
  }, [activeBatchId, authenticatedUser, completeActiveBatch, hydrateWorkbenchBatch, navigate, resetWorkbenchTransientState, restoringActiveBatch, route, setBrowserActiveBatch]);

  useEffect(() => {
    if (!needsCatalog) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setCatalogLoading(true);
      setCatalogError(undefined);
      void api.getCatalogPage({ query: catalogQuery, group: catalogGroup, page: catalogPage, pageSize })
        .then((response) => { if (!cancelled) setCatalog(response); })
        .catch((error: unknown) => { if (!cancelled) setCatalogError(error instanceof Error ? error.message : '无法加载图标目录。'); })
        .finally(() => { if (!cancelled) setCatalogLoading(false); });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [catalogGroup, catalogPage, catalogQuery, needsCatalog]);

  useEffect(() => {
    const requiresPolling = Boolean(batch && activeBatchId === batch.id && batchStatus(batch) === 'processing');
    if (!requiresPolling || !batch) return undefined;
    const timer = window.setInterval(() => {
      const pollVersion = workbenchHydrationVersion.current + 1;
      workbenchHydrationVersion.current = pollVersion;
      const batchId = batch.id;
      void api.getBatch(batchId)
        .then((refreshed) => {
          if (workbenchHydrationVersion.current !== pollVersion || activeBatchIdRef.current !== batchId) return;
          setBatch(refreshed);
        })
        .catch((error: unknown) => {
          if (workbenchHydrationVersion.current === pollVersion && activeBatchIdRef.current === batchId) {
            setNotice(error instanceof Error ? error.message : '无法刷新批次状态。');
          }
        });
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [activeBatchId, batch]);

  const selectAction = (nextAction: ItemAction) => {
    setAction(nextAction);
    setTarget(undefined);
    setReplacement(undefined);
    setCatalogSelection('target');
    setCatalogOpen(false);
    setChangeErrors({});
  };

  const updateAddName = (value: string) => {
    setAddName(value);
    setChangeErrors((current) => ({ ...current, designName: '' }));
  };

  const queueSvgs = (files: FileList | File[]) => {
    void (async () => {
      const inspected = await Promise.all(Array.from(files).map(async (file) => ({ file, ...(await inspectSvg(file)) })));
      const rejected = inspected.filter((result) => result.error);
      const accepted: SvgDraft[] = [];
      const knownContent = new Set([
        ...pendingSvgs.map((svg) => svg.content),
        ...changes.flatMap((change) => change.svg ? [change.svg.content] : []),
      ].filter(Boolean));
      for (const result of inspected) {
        if (!result.content) continue;
        const duplicate = knownContent.has(result.content);
        knownContent.add(result.content);
        accepted.push({
          ...createSvgDraft(result.file),
          content: result.content,
          ...(duplicate ? { warning: '这个 SVG 与本批次已上传的文件内容完全相同，请确认不是误传。' } : result.warning ? { warning: result.warning } : {}),
        });
      }
      if (accepted.length > 0) {
        accepted.forEach((svg) => liveSvgDrafts.current.set(svg.id, svg));
        setPendingSvgs((current) => [...current, ...accepted]);
        setActiveSvgId(accepted[0].id);
        setChangeErrors((current) => ({ ...current, svg: '' }));
      }
      if (rejected.length > 0) {
        const message = rejected.map((result) => `${result.file.name}：${result.error}`).join('；');
        setChangeErrors((current) => ({ ...current, svg: message }));
        setNotice('有文件未加入待处理队列，请修正后再次拖入。');
      } else if (accepted.length === 0) {
        setNotice('请选择可解析的 SVG 文件。');
      }
    })();
  };

  const removePendingSvg = (id: string, keepPreview = false) => {
    setPendingSvgs((current) => {
      const removed = current.find((svg) => svg.id === id);
      if (!keepPreview) {
        revokePreview(removed);
        liveSvgDrafts.current.delete(id);
      }
      const next = current.filter((svg) => svg.id !== id);
      setActiveSvgId((active) => active === id ? next[0]?.id : active);
      return next;
    });
  };

  const selectTarget = (icon: CatalogPageIcon) => {
    const targetUse = usedTargets.get(icon.primaryName);
    if (targetUse) {
      setChangeErrors((current) => ({ ...current, target: `${icon.primaryName}${targetUseLabel(targetUse)}，不能在同一批次重复修改。` }));
      return;
    }
    setTarget(icon);
    if (replacement?.primaryName === icon.primaryName) {
      setReplacement(undefined);
    }
    setCatalogOpen(false);
    setChangeErrors((current) => ({ ...current, target: '' }));
  };

  const selectReplacement = (icon: CatalogPageIcon) => {
    const unavailable = replacementUnavailableTargets.get(icon.primaryName);
    if (unavailable) {
      setChangeErrors((current) => ({ ...current, replacement: `${icon.primaryName}${targetUseLabel(unavailable)}，不能作为删除后的替代图标。` }));
      return;
    }
    setReplacement(icon);
    setCatalogSelection('target');
    setCatalogOpen(false);
    setChangeErrors((current) => ({ ...current, replacement: '' }));
  };

  const updateBatchMetadata = (patch: Partial<typeof batchForm>) => {
    setBatchForm((current) => ({ ...current, ...patch }));
    setReviewErrors((current) => ({ ...current, ...Object.fromEntries(Object.keys(patch).map((key) => [key, ''])) }));
  };

  const batchMetadata = () => ({
    title: batchForm.title.trim(),
    description: batchForm.description.trim(),
    ...(batchForm.designUrl.trim() ? { designUrl: batchForm.designUrl.trim() } : {}),
  });

  const validateBatchMetadata = (): FieldErrors => {
    const errors: FieldErrors = {};
    if (!batchForm.title.trim()) errors.title = '请填写本次变更标题。';
    else if (fieldLengthIssue(batchForm.title, '本次变更标题', limits.batchTitle)) errors.title = fieldLengthIssue(batchForm.title, '本次变更标题', limits.batchTitle)!;
    if (!batchForm.description.trim()) errors.description = '请填写整体需求说明。';
    else if (fieldLengthIssue(batchForm.description, '整体需求说明', limits.batchDescription)) errors.description = fieldLengthIssue(batchForm.description, '整体需求说明', limits.batchDescription)!;
    if (batchForm.designUrl.trim() && !isHttpUrl(batchForm.designUrl.trim())) errors.designUrl = '请填写有效的 HTTP(S) 设计稿链接。';
    return errors;
  };

  const recoverCreatedBatch = async (metadata: ReturnType<typeof batchMetadata>, originalError: unknown): Promise<BatchDetails> => {
    try {
      const active = await api.getActiveBatch();
      if (active && active.state === 'DRAFT' && batchMetadataMatches(active, metadata)) return active;
    } catch {
      // Preserve the create failure when the active-batch reconciliation request also fails.
    }
    throw originalError;
  };

  const ensureDraftBatch = async (metadata: ReturnType<typeof batchMetadata>): Promise<BatchDetails> => {
    if (batch) return batch;
    let created: BatchDetails;
    try {
      created = await api.createBatch(metadata);
    } catch (error) {
      created = await recoverCreatedBatch(metadata, error);
    }
    return created;
  };

  const reconcileItemWrite = async (
    pending: NonNullable<typeof uncertainItemWrite.current>,
  ): Promise<{ item: ApiItem; batch: BatchDetails } | undefined> => {
    const restored = await api.getBatch(pending.batchId);
    const candidates = restored.items.filter((item) => !pending.existingIds.has(item.id) && itemMatchesDraft(item, pending.change));
    if (candidates.length === 1) return { item: candidates[0]!, batch: restored };
    if (candidates.length > 1) throw new Error('服务端存在多项无法区分的相同变更，请交由开发处理。');
    return undefined;
  };

  const persistNewChange = async (currentBatch: BatchDetails, change: DraftChange): Promise<{ item: ApiItem; batch: BatchDetails }> => {
    const existingIds = new Set(currentBatch.items.map((item) => item.id));
    try {
      const item = await api.addItem(currentBatch.id, toItemInput(change), change.svg?.file);
      uncertainItemWrite.current = undefined;
      return { item, batch: { ...currentBatch, items: [...currentBatch.items, item] } };
    } catch (error) {
      const pending = { batchId: currentBatch.id, change, existingIds, originalError: error };
      uncertainItemWrite.current = pending;
      try {
        const reconciled = await reconcileItemWrite(pending);
        if (reconciled) {
          uncertainItemWrite.current = undefined;
          return reconciled;
        }
        uncertainItemWrite.current = undefined;
      } catch {
        // Keep the uncertain write so a manual retry reconciles before issuing another POST.
      }
      throw error;
    }
  };

  const addChange = async () => {
    if (draftMutationInFlight.current) return;
    const errors: FieldErrors = {};
    const metadataErrors = validateBatchMetadata();
    if (action !== 'delete' && !activeSvg) errors.svg = '请先拖入或选择 SVG 文件。';
    if (action === 'add') {
      const nameIssue = localNameIssue(addName);
      if (nameIssue) errors.designName = nameIssue;
      if (!addDescription.trim()) errors.description = '请填写用途说明。';
      else if (fieldLengthIssue(addDescription, '用途说明', limits.itemText)) errors.description = fieldLengthIssue(addDescription, '用途说明', limits.itemText)!;
    }
    if (action === 'replace') {
      if (!target) errors.target = '请选择一个需要替换的现有图标。';
      else if (fieldLengthIssue(replaceDescription, '替换说明', limits.itemText)) errors.description = fieldLengthIssue(replaceDescription, '替换说明', limits.itemText)!;
    }
    if (action === 'delete') {
      if (!target) errors.target = '请选择一个需要删除的现有图标。';
      if (!deleteReason.trim()) errors.reason = '请填写删除原因。';
      else if (fieldLengthIssue(deleteReason, '删除原因', limits.itemText)) errors.reason = fieldLengthIssue(deleteReason, '删除原因', limits.itemText)!;
      if (replacement && replacementUnavailableTargets.has(replacement.primaryName)) errors.replacement = '替代图标不能是正在删除的图标。';
    }
    if (target && (action === 'replace' || action === 'delete')) {
      const targetUse = usedTargets.get(target.primaryName);
      if (targetUse) errors.target = `${target.primaryName}${targetUseLabel(targetUse)}，不能在同一批次重复修改。`;
    }
    setChangeErrors(errors);
    setReviewErrors((current) => ({ ...current, ...metadataErrors }));
    if (Object.keys(errors).length > 0 || Object.keys(metadataErrors).length > 0) {
      setNotice(Object.keys(metadataErrors).length > 0 ? '请先填写并检查本次批次信息。' : undefined);
      return;
    }
    const change: DraftChange = {
      clientId: uniqueId('change'),
      action,
      ...(action === 'add' ? { designName: addName.trim(), description: addDescription.trim() } : {}),
      ...(action === 'replace' ? { target, description: replaceDescription.trim() || undefined, svg: activeSvg } : {}),
      ...(action === 'delete' ? { target, reason: deleteReason.trim(), replacement } : {}),
      ...(action === 'add' ? { svg: activeSvg } : {}),
    };
    draftMutationInFlight.current = true;
    setBusy(true);
    const operationAuthGeneration = authGeneration.current;
    let operationHydrationVersion = workbenchHydrationVersion.current;
    try {
      const currentBatch = await ensureDraftBatch(batchMetadata());
      if (authGeneration.current !== operationAuthGeneration) return;
      if (workbenchHydrationVersion.current !== operationHydrationVersion) {
        if (!batch) {
          setBrowserActiveBatch(currentBatch.id);
          setBatch(currentBatch);
          void refreshBatchSummaries();
        }
        return;
      }
      if (!batch) {
        setBrowserActiveBatch(currentBatch.id);
        operationHydrationVersion = workbenchHydrationVersion.current;
        setBatch(currentBatch);
      }
      const pending = uncertainItemWrite.current;
      let persisted: { item: ApiItem; batch: BatchDetails };
      let persistedChange = change;
      if (pending) {
        try {
          const reconciled = await reconcileItemWrite(pending);
          if (!reconciled) {
            uncertainItemWrite.current = undefined;
            persisted = await persistNewChange(currentBatch, change);
          } else {
            uncertainItemWrite.current = undefined;
            persisted = reconciled;
            persistedChange = pending.change;
          }
        } catch (error) {
          throw pending.originalError instanceof Error ? pending.originalError : error;
        }
      } else {
        persisted = await persistNewChange(currentBatch, change);
      }
      if (authGeneration.current !== operationAuthGeneration) return;
      if (workbenchHydrationVersion.current !== operationHydrationVersion) {
        setBatch(persisted.batch);
        void refreshBatchSummaries();
        return;
      }
      const saved = savedDraftChange(persistedChange, persisted.item);
      setBatch(persisted.batch);
      setChanges((current) => [...current, saved]);
      if (draftChangesMatch(persistedChange, change)) {
        if (activeSvg) removePendingSvg(activeSvg.id, true);
        setTarget(undefined);
        setAddName(''); setAddDescription(''); setReplaceDescription(''); setDeleteReason(''); setReplacement(undefined);
      }
      setChangeErrors({});
      setNotice(draftChangesMatch(persistedChange, change)
        ? '已保存到当前草稿。其余 SVG 会继续保留在待处理队列。'
        : '上一项变更已确认保存；当前编辑内容仍保留，可再次加入队列。');
      void refreshBatchSummaries();
    } catch (error) {
      if (authGeneration.current === operationAuthGeneration && workbenchHydrationVersion.current === operationHydrationVersion) {
        setNotice(error instanceof Error ? `草稿保存失败：${error.message}` : '草稿保存失败，请稍后重试。');
      }
    } finally {
      draftMutationInFlight.current = false;
      setBusy(false);
    }
  };

  const removeChange = async (change: DraftChange) => {
    if (batch && change.serverId) {
      setBusy(true);
      try {
        await api.deleteItem(batch.id, change.serverId);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '无法移除变更。');
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    revokePreview(change.svg);
    if (change.svg) liveSvgDrafts.current.delete(change.svg.id);
    if (batch && change.serverId) {
      setBatch((current) => current ? { ...current, items: current.items.filter((item) => item.id !== change.serverId) } : current);
    }
    setChanges((current) => current.filter((candidate) => candidate.clientId !== change.clientId));
    setNotice('已移除本次变更。');
  };

  const validateReview = (): boolean => {
    const errors = validateBatchMetadata();
    if (!confirmed) errors.confirmed = '请确认本次变更内容。';
    setReviewErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const submitReview = async () => {
    if (!authenticatedUser || !batch || changes.some((change) => !change.serverId) || !validateReview() || draftMutationInFlight.current) return;
    draftMutationInFlight.current = true;
    const mutationVersion = workbenchHydrationVersion.current + 1;
    workbenchHydrationVersion.current = mutationVersion;
    setReviewOpen(false);
    setBusy(true);
    setRepeatedSubmissionConfirmation(false);
    setNotice('已提交本次变更，正在等待最终校验。');
    try {
      const currentBatch = await api.updateBatch(batch.id, batchMetadata());
      if (workbenchHydrationVersion.current !== mutationVersion) return;
      setBatch(currentBatch);
      const submitted = await api.submitBatch(currentBatch.id);
      if (workbenchHydrationVersion.current !== mutationVersion) return;
      setBatch(submitted);
      void refreshBatchSummaries();
    } catch (error) {
      try {
        const restored = await api.getBatch(batch.id);
        if (workbenchHydrationVersion.current !== mutationVersion) return;
        setBatch(restored);
        setChanges((current) => reconcileDraftChanges(restored, current));
        setBatchForm({ title: restored.title, description: restored.description, designUrl: restored.designUrl ?? '' });
      } catch {
        // Preserve the original submission failure when reconciliation is temporarily unavailable.
      }
      if (error instanceof ApiError && error.code === 'REPEATED_SUBMISSION_CONFIRMATION_REQUIRED') {
        setRepeatedSubmissionConfirmation(true);
        setNotice('本次内容与上次最终校验失败时相同。确认后才能再次提交。');
      } else {
        setNotice(error instanceof Error ? `提交未完成：${error.message}` : '提交未完成，请稍后重试。');
      }
    } finally {
      draftMutationInFlight.current = false;
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!batch || !viewingActiveBatch) return;
    const mutationVersion = workbenchHydrationVersion.current + 1;
    workbenchHydrationVersion.current = mutationVersion;
    setBusy(true);
    try {
      const retried = await api.retryBatch(batch.id);
      if (workbenchHydrationVersion.current !== mutationVersion) return;
      setBatch(retried);
      setNotice('已重新安排本次交付。');
      void refreshBatchSummaries();
    } catch (error) {
      setNotice(error instanceof Error ? `无法重新尝试交付：${error.message}` : '无法重新尝试交付。');
    } finally {
      setBusy(false);
    }
  };

  const returnToEdit = async (): Promise<boolean> => {
    if (!batch || !viewingActiveBatch) return false;
    const mutationVersion = workbenchHydrationVersion.current + 1;
    workbenchHydrationVersion.current = mutationVersion;
    setBusy(true);
    try {
      const restored = await api.returnToEdit(batch.id);
      if (workbenchHydrationVersion.current !== mutationVersion) return false;
      hydrateWorkbenchFromDetails(restored, '已返回编辑。请修正内容后再次确认提交。');
      void refreshBatchSummaries();
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? `无法返回编辑：${error.message}` : '无法返回编辑。');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const confirmRepeatedSubmission = async () => {
    if (!batch || !viewingActiveBatch) return;
    const mutationVersion = workbenchHydrationVersion.current + 1;
    workbenchHydrationVersion.current = mutationVersion;
    setBusy(true);
    try {
      const submitted = await api.submitBatch(batch.id, true);
      if (workbenchHydrationVersion.current !== mutationVersion) return;
      setBatch(submitted);
      setRepeatedSubmissionConfirmation(false);
      setNotice('已按原内容再次提交，正在等待最终校验。');
      void refreshBatchSummaries();
    } catch (error) {
      setNotice(error instanceof Error ? `提交未完成：${error.message}` : '提交未完成，请稍后重试。');
    } finally {
      setBusy(false);
    }
  };

  const startNewWorkbench = () => {
    if (activeBatchId) {
      setNotice('请先完成当前批次。');
      navigate({ view: 'workbench' });
      return;
    }
    workbenchHydrationVersion.current += 1;
    resetWorkbenchTransientState();
    setBatch(undefined);
    setNotice(undefined);
    navigate({ view: 'workbench' });
  };

  const openBatchWorkbench = (batchId: string) => {
    if (activeBatchId && activeBatchId !== batchId) {
      setNotice('请先完成当前批次。');
      return;
    }
    if (activeBatchId === batchId) {
      navigate({ view: 'workbench' });
      return;
    }
    setNotice('正在打开批次…');
    navigate({ view: 'workbench', batchId });
  };

  const returnActiveBatchToEdit = async () => {
    if (!batch || !viewingActiveBatch) return;
    if (!await returnToEdit()) return;
    skipNextWorkbenchHydrationPath.current = routePath({ view: 'workbench' });
    navigate({ view: 'workbench' });
    void refreshBatchSummaries();
  };

  const cloneBatch = async () => {
    if (!batch) return;
    const mutationVersion = workbenchHydrationVersion.current + 1;
    workbenchHydrationVersion.current = mutationVersion;
    setBusy(true);
    try {
      const cloned = await api.cloneBatch(batch.id);
      if (workbenchHydrationVersion.current !== mutationVersion) return;
      setBusy(false);
      setBrowserActiveBatch(cloned.id);
      hydrateWorkbenchFromDetails(cloned, '已基于原批次创建新的草稿。请确认内容后重新提交。');
      navigate({ view: 'workbench' });
      void refreshBatchSummaries();
    } catch (error) {
      if (workbenchHydrationVersion.current === mutationVersion) {
        setNotice(error instanceof Error ? `无法新建批次：${error.message}` : '无法基于当前批次新建。');
      }
    } finally {
      if (workbenchHydrationVersion.current === mutationVersion) setBusy(false);
    }
  };

  const returnHome = async () => {
    if (draftMutationInFlight.current) return;
    const operationAuthGeneration = authGeneration.current;
    const operationHydrationVersion = workbenchHydrationVersion.current;
    if (batch && viewingActiveBatch && batch.state === 'DRAFT') {
      const errors = validateBatchMetadata();
      setReviewErrors((current) => ({ ...current, ...errors }));
      if (Object.keys(errors).length > 0) {
        setNotice('请先检查本次批次信息，保存后再返回首页。');
        return;
      }
      draftMutationInFlight.current = true;
      setBusy(true);
      try {
        const saved = await api.updateBatch(batch.id, batchMetadata());
        if (authGeneration.current !== operationAuthGeneration || workbenchHydrationVersion.current !== operationHydrationVersion) return;
        setBatch(saved);
      } catch (error) {
        if (authGeneration.current === operationAuthGeneration && workbenchHydrationVersion.current === operationHydrationVersion) {
          setNotice(error instanceof Error ? `草稿保存失败：${error.message}` : '草稿保存失败，请稍后重试。');
        }
        return;
      } finally {
        draftMutationInFlight.current = false;
        setBusy(false);
      }
    }
    if (authGeneration.current !== operationAuthGeneration || workbenchHydrationVersion.current !== operationHydrationVersion) return;
    navigate({ view: 'home' });
    void refreshBatchSummaries();
  };

  if (authenticatedUser === undefined) {
    return <main className="identity-overlay" aria-live="polite">正在恢复登录状态…</main>;
  }

  if (!authenticatedUser) {
    return <LoginPage onLogin={login} />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand brand-button" type="button" disabled={busy} onClick={() => void returnHome()} aria-label="返回首页"><img className="brand-logo" src="/pink-icon.svg" alt="" /><span>PinK 图标工作台</span></button>
        <button className="profile-button" type="button" disabled={busy} onClick={() => void logout()} aria-label="退出登录"><span className="avatar">{authenticatedUser.username.slice(0, 1).toUpperCase()}</span><span><strong>{authenticatedUser.username}</strong><small>退出登录</small></span></button>
      </header>
      {view === 'home' ? <HomePage
        activeBatch={batch && activeBatchId === batch.id && isActiveBatch(batch) ? batch : undefined}
        restoringActiveBatch={restoringActiveBatch}
        summaries={batchSummaries}
        loading={batchSummariesLoading}
        error={batchSummariesError}
        notice={notice}
        onNew={startNewWorkbench}
        onOpenActive={() => navigate({ view: 'workbench' })}
        onReturnToEdit={() => void returnActiveBatchToEdit()}
        onOpenSummary={(batchId) => void openBatchWorkbench(batchId)}
      /> : <main className="page-shell">
        <header className="page-header"><h1>完成设计，交给开发</h1><p>选择现有图标或拖入新的 SVG，把本次设计变更一次提交给开发审核。</p></header>

        {batch ? <DeliveryStatusCard
          batch={batch}
          busy={busy}
          readOnly={!viewingActiveBatch}
          notice={notice}
          repeatedSubmissionConfirmation={repeatedSubmissionConfirmation}
          onReturnToEdit={() => void returnToEdit()}
          onRetry={() => void retry()}
          onClone={() => void cloneBatch()}
          onConfirmRepeatedSubmission={() => void confirmRepeatedSubmission()}
        /> : notice && <p className="notice" aria-live="polite">{notice}</p>}

        {batch && !viewingActiveBatch && <p className="notice" aria-live="polite">这是历史批次，仅供查看。</p>}

        <section className="composer-card" aria-labelledby="batch-information-title">
          <p className="eyebrow">当前批次</p>
          <h2 id="batch-information-title">本次变更信息</h2>
          <div className="form-field"><label htmlFor="batch-title">本次变更标题<RequiredMark /></label><input id="batch-title" disabled={!editable || busy} maxLength={limits.batchTitle} value={batchForm.title} onChange={(event) => updateBatchMetadata({ title: event.target.value })} placeholder="例如：模型页图标视觉更新" /><FieldCounter value={batchForm.title} maximum={limits.batchTitle} /><FieldError message={reviewErrors.title} /></div>
          <div className="form-field"><label htmlFor="batch-description">整体需求说明<RequiredMark /></label><textarea id="batch-description" disabled={!editable || busy} maxLength={limits.batchDescription} value={batchForm.description} onChange={(event) => updateBatchMetadata({ description: event.target.value })} placeholder="说明设计变更的背景、目的和影响范围。" /><FieldCounter value={batchForm.description} maximum={limits.batchDescription} /><FieldError message={reviewErrors.description} /></div>
          <div className="form-field"><label htmlFor="design-url">设计稿链接 <em>（选填）</em></label><input id="design-url" disabled={!editable || busy} type="url" value={batchForm.designUrl} onChange={(event) => updateBatchMetadata({ designUrl: event.target.value })} placeholder="https://figma.com/..." /><FieldError message={reviewErrors.designUrl} /></div>
        </section>

        <section className="composer-card" aria-labelledby="composer-title">
          <p className="eyebrow">正在编辑一项变更</p>
          <h2 id="composer-title">{({ add: '新增一个图标', replace: '替换已有图标', delete: '删除已有图标' })[action]}</h2>
          <p className="composer-copy">{action === 'add' ? '拖入一个或多个 SVG。每个 SVG 会显示预览，并可依次加入新增队列。' : action === 'replace' ? '选择要替换的旧图标，再从待处理 SVG 中选择对应的新图标。可重复完成多项替换。' : '选择要删除的图标并说明删除原因。兼容性影响会由开发审核处理。'}</p>
          <div className="action-tabs" role="tablist" aria-label="变更类型">
            {(['add', 'replace', 'delete'] as ItemAction[]).map((option) => <button key={option} className={action === option ? 'active' : ''} type="button" role="tab" aria-selected={action === option} disabled={!editable || busy} onClick={() => selectAction(option)}>{({ add: '新增图标', replace: '替换图标', delete: '删除图标' })[option]}</button>)}
          </div>

          {action !== 'add' && <TargetZone action={action} target={target} error={changeErrors.target} disabled={!editable || busy} onOpenCatalog={() => { setCatalogSelection('target'); setCatalogOpen(true); }} onClear={() => { setTarget(undefined); setReplacement(undefined); setCatalogSelection('target'); }} />}

          {needsCatalog && <CatalogBrowser
            catalog={catalog}
            loading={catalogLoading}
            error={catalogError}
            query={catalogQuery}
            group={catalogGroup}
            selected={catalogSelection === 'replacement' ? replacement : target}
            unavailableTargets={catalogSelection === 'replacement' ? replacementUnavailableTargets : usedTargets}
            disabled={!editable || busy}
            selectionCopy={catalogSelection === 'replacement' ? '正在选择删除后的替代图标；正在删除的图标不可选。' : '正在选择本次操作的目标图标。'}
            onQueryChange={(value) => { setCatalogQuery(value); setCatalogPage(1); }}
            onGroupChange={(value) => { setCatalogGroup(value); setCatalogPage(1); }}
            onPageChange={setCatalogPage}
            onSelect={(icon) => { if (catalogSelection === 'replacement') selectReplacement(icon); else selectTarget(icon); }}
            onClose={() => setCatalogOpen(false)}
          />}

          {action === 'add' && <div className="form-field"><label htmlFor="add-name">期望图标名称<RequiredMark /></label><input id="add-name" maxLength={limits.name} value={addName} disabled={!editable || busy} onChange={(event) => updateAddName(event.target.value)} placeholder="例如：pink-model-preview" /><FieldCounter value={addName} maximum={limits.name} /><p className="field-hint">最终名称会在开发审核时确认。</p><FieldError message={changeErrors.designName} /></div>}
          {action === 'add' && <div className="form-field"><label htmlFor="add-description">用途说明<RequiredMark /></label><textarea id="add-description" maxLength={limits.itemText} value={addDescription} disabled={!editable || busy} onChange={(event) => setAddDescription(event.target.value)} placeholder="说明图标表达的对象或操作。" /><FieldCounter value={addDescription} maximum={limits.itemText} /><FieldError message={changeErrors.description} /></div>}
          {action === 'replace' && <div className="form-field"><label htmlFor="replace-description">本次替换说明 <em>（可选）</em></label><textarea id="replace-description" maxLength={limits.itemText} value={replaceDescription} disabled={!editable || busy} onChange={(event) => setReplaceDescription(event.target.value)} placeholder="例如：与新的模型资产视觉语言保持一致。" /><FieldCounter value={replaceDescription} maximum={limits.itemText} /><FieldError message={changeErrors.description} /></div>}
          {action === 'delete' && <>
            <div className="form-field"><label htmlFor="delete-reason">删除原因<RequiredMark /></label><textarea id="delete-reason" maxLength={limits.itemText} value={deleteReason} disabled={!editable || busy} onChange={(event) => setDeleteReason(event.target.value)} placeholder="例如：图标已废弃且无替代用途。" /><FieldCounter value={deleteReason} maximum={limits.itemText} /><FieldError message={changeErrors.reason} /></div>
            <div className="form-field"><span className="field-label">建议使用的替代图标 <em>（可选）</em></span>{replacement ? <div className="replacement-choice"><img src={svgPreviewUrl(replacement.svg)} alt={`${replacement.primaryName} 替代图标`} /><span><strong>{replacement.primaryName}</strong><small>现有 primary 图标</small></span><button type="button" disabled={!editable || busy} onClick={() => { setReplacement(undefined); setCatalogSelection('replacement'); setCatalogOpen(true); }}>重新选择</button></div> : <button className="button secondary" type="button" disabled={!editable || busy || !target} onClick={() => { setCatalogSelection('replacement'); setCatalogOpen(true); }}>从图标目录选择替代图标</button>}<FieldError message={changeErrors.replacement} /></div>
          </>}
          {action !== 'delete' && <SvgQueue pending={pendingSvgs} activeSvgId={activeSvgId} disabled={!editable || busy} error={changeErrors.svg} onQueue={queueSvgs} onActivate={setActiveSvgId} onRemove={removePendingSvg} />}
          {action === 'replace' && target && activeSvg?.content === target.svg && <p className="inline-warning">新 SVG 与当前仓库文件内容完全一致；这次替换可能不会产生实际改动。</p>}
          <div className="composer-actions"><span>加入队列后会立即保存为账号草稿；确认提交前不会进入图标仓库。</span><button className="button primary" type="button" disabled={!editable || busy} onClick={() => void addChange()}>加入{({ add: '新增', replace: '替换', delete: '删除' })[action]}队列</button></div>
        </section>

        <section className="changes-card" aria-label="本次变更"><div><h2>本次变更 {changes.length} 项</h2><p>{changes.length === 0 ? '把一项操作加入队列后，会在这里同时显示所有待改动图标。' : '确认前可移除任何一项变更。'}</p></div><div className="change-list">{changes.map((change) => <ChangeCard key={change.clientId} change={change} disabled={!editable || busy} onRemove={() => void removeChange(change)} />)}</div><div className="changes-actions"><button className="button primary" type="button" disabled={!editable || busy || changes.length === 0} onClick={() => { setReviewErrors({}); setReviewOpen(true); }}>确认本次变更</button></div></section>

        {batch && batch.userStatus === 'needs_changes' && batch.validation?.valid === false && <DiagnosticList title="需要修正的问题" diagnostics={batch.validation.errors} tone="error" items={batch.items} />}
      </main>}
      {reviewOpen && <ReviewDrawer changes={changes} user={authenticatedUser} errors={reviewErrors} confirmed={confirmed} busy={busy} onConfirmedChange={setConfirmed} onClose={() => setReviewOpen(false)} onSubmit={() => void submitReview()} />}
    </div>
  );
}
