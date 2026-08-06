import { useEffect, useMemo, useRef, useState } from 'react';

import { api, ApiError, type ApiItem, type BatchDetails, type CatalogGroup, type CatalogPageIcon, type Diagnostic, type ItemAction, type ItemInput, type NamePreview, type Submitter } from './api';

interface DesignerProfile extends Submitter {
  version: 1;
}

interface SvgDraft {
  id: string;
  file: File;
  previewUrl: string | undefined;
  content: string;
  warning?: string;
}

interface DraftChange {
  clientId: string;
  serverId?: string;
  action: ItemAction;
  designName?: string;
  target?: CatalogPageIcon;
  description?: string;
  reason?: string;
  replacement?: CatalogPageIcon;
  svg?: SvgDraft;
}

interface TargetUse {
  action: 'replace' | 'delete';
  itemNumber: number;
}

type FieldErrors = Record<string, string>;

const identityStorageKey = 'pink-icon-submit.designer-profile.v1';
const pageSize = 24;
const defaultUploadLimit = 1024 * 1024;
const limits = {
  batchTitle: 200,
  batchDescription: 5_000,
  itemText: 1_000,
  email: 320,
  name: 100,
  profileName: 100,
};
let nextClientId = 1;

const stateLabel: Record<BatchDetails['state'], string> = {
  DRAFT: '待校验',
  VALIDATING: '校验中',
  READY: '校验通过',
  QUEUED: '等待生成本地修改',
  RUNNING: '正在生成本地修改',
  LOCAL_DIFF_READY: '本地修改已生成',
  COMMIT_PREPARED: '正在准备机器人提交',
  BRANCH_PUSHED: '机器人分支已创建',
  PR_CREATING: '正在创建 Draft PR',
  PR_CREATED: 'Draft PR 已创建',
  FAILED: '处理失败',
};

function uniqueId(prefix: string): string {
  return `${prefix}-${nextClientId++}`;
}

function readProfile(): DesignerProfile | undefined {
  try {
    const stored = window.localStorage.getItem(identityStorageKey);
    if (!stored) return undefined;
    const parsed = JSON.parse(stored) as Partial<DesignerProfile>;
    if (parsed.version === 1 && typeof parsed.name === 'string' && typeof parsed.email === 'string' && parsed.name.trim() && parsed.email.trim()) {
      return { version: 1, name: parsed.name.trim(), email: parsed.email.trim() };
    }
  } catch {
    // A malformed local preference should not prevent a new submission.
  }
  return undefined;
}

function writeProfile(profile: DesignerProfile): void {
  window.localStorage.setItem(identityStorageKey, JSON.stringify(profile));
}

function isEmail(value: string): boolean {
  return /^\S+@\S+\.\S+$/.test(value);
}

function isHttpUrl(value: string): boolean {
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

function localNameIssue(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return '请填写图标建议名称。';
  if (trimmed.length > limits.name) return `图标名称不能超过 ${limits.name} 个字符。`;
  if (/\s/.test(value) || /[\\/]/.test(value)) return '图标名称不能包含空白或路径分隔符。';
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

function diagnosticLabel(diagnostic: Diagnostic): string {
  return diagnostic.itemId ? `${diagnostic.code}（${diagnostic.itemId}）` : diagnostic.code;
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

function IdentityDialog({ profile, onSave, onClose }: { profile?: DesignerProfile; onSave: (profile: DesignerProfile) => void; onClose?: () => void }) {
  const [name, setName] = useState(profile?.name ?? '');
  const [email, setEmail] = useState(profile?.email ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});

  const submit = () => {
    const nextErrors: FieldErrors = {};
    if (!name.trim()) nextErrors.name = '请填写姓名。';
    else if (fieldLengthIssue(name, '姓名', limits.profileName)) nextErrors.name = fieldLengthIssue(name, '姓名', limits.profileName)!;
    if (!isEmail(email.trim())) nextErrors.email = '请填写有效的公司邮箱。';
    else if (fieldLengthIssue(email, '公司邮箱', limits.email)) nextErrors.email = fieldLengthIssue(email, '公司邮箱', limits.email)!;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) {
      onSave({ version: 1, name: name.trim(), email: email.trim() });
    }
  };

  return (
    <div className="identity-overlay" role="presentation">
      <section className="identity-dialog" role="dialog" aria-modal="true" aria-labelledby="identity-title">
        <div className="brand-mark">P</div>
        <h1 id="identity-title">开始前，认识一下你</h1>
        <p>这不是登录。填写一次设计师信息，后续提交会自动带入；你可以在右上角随时修改。</p>
        <div className="form-field">
          <label htmlFor="identity-name">姓名<RequiredMark /></label>
          <input id="identity-name" autoComplete="name" maxLength={limits.profileName} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：李思思" />
          <FieldCounter value={name} maximum={limits.profileName} />
          <FieldError message={errors.name} />
        </div>
        <div className="form-field">
          <label htmlFor="identity-email">公司邮箱<RequiredMark /></label>
          <input id="identity-email" type="email" autoComplete="email" maxLength={limits.email} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" />
          <FieldCounter value={email} maximum={limits.email} />
          <FieldError message={errors.email} />
        </div>
        <p className="identity-note">仅保存在当前浏览器，用于预填提交人；不建立账号、不做认证，也不会发送给 GitHub。</p>
        <div className="dialog-actions">
          {onClose && <button className="button secondary" type="button" onClick={onClose}>取消</button>}
          <button className="button primary" type="button" onClick={submit}>开始编辑图标</button>
        </div>
      </section>
    </div>
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
  return (
    <article className={`change-card ${change.action}`}>
      {change.action === 'replace' && change.target && <img src={svgPreviewUrl(change.target.svg)} alt={`${change.target.primaryName} 当前图标`} />}
      {change.action === 'replace' && <span className="change-arrow">→</span>}
      {change.svg && <SvgPreview svg={change.svg} alt={`${change.svg.file.name} 预览`} className="change-preview" />}
      {change.action === 'delete' && change.target && <img src={svgPreviewUrl(change.target.svg)} alt={`${change.target.primaryName} 当前图标`} />}
      <span><strong>{label} · {change.action === 'add' ? change.designName : change.target?.primaryName}</strong><small>{change.action === 'delete' ? '将从图标仓库移除' : change.svg?.file.name}</small></span>
      <button type="button" disabled={disabled} onClick={onRemove} aria-label={`移除 ${change.action === 'add' ? change.designName : change.target?.primaryName}`}>×</button>
    </article>
  );
}

function DiagnosticList({ title, diagnostics, tone }: { title: string; diagnostics: Diagnostic[]; tone: 'error' | 'warning' }) {
  if (diagnostics.length === 0) return null;
  return <section className={`diagnostics ${tone}`} aria-label={title}><h2>{title}</h2><ul>{diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${diagnostic.itemId ?? index}`}><strong>{diagnosticLabel(diagnostic)}</strong><span>{diagnostic.message}</span></li>)}</ul></section>;
}

function ReviewDrawer({
  changes,
  form,
  profile,
  errors,
  confirmed,
  busy,
  onChange,
  onConfirmedChange,
  onClose,
  onSubmit,
}: {
  changes: DraftChange[];
  form: { title: string; description: string; designUrl: string };
  profile: DesignerProfile;
  errors: FieldErrors;
  confirmed: boolean;
  busy: boolean;
  onChange: (patch: Partial<{ title: string; description: string; designUrl: string }>) => void;
  onConfirmedChange: (value: boolean) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="review-overlay" role="presentation">
      <section className="review-drawer" role="dialog" aria-modal="true" aria-labelledby="review-title">
        <div className="drawer-heading"><div><p className="eyebrow">提交前确认</p><h2 id="review-title">让开发准确理解这次设计</h2></div><button type="button" onClick={onClose} aria-label="关闭">×</button></div>
        <p className="review-note">提交人会自动使用 <strong>{profile.name}</strong>（{profile.email}）。校验结果和后续开发审核会一并记录本次设计变更。</p>
        <div className="form-field"><label htmlFor="batch-title">本次变更标题<RequiredMark /></label><input id="batch-title" maxLength={limits.batchTitle} value={form.title} onChange={(event) => onChange({ title: event.target.value })} placeholder="例如：模型页图标视觉更新" /><FieldCounter value={form.title} maximum={limits.batchTitle} /><FieldError message={errors.title} /></div>
        <div className="form-field"><label htmlFor="batch-description">整体需求说明<RequiredMark /></label><textarea id="batch-description" maxLength={limits.batchDescription} value={form.description} onChange={(event) => onChange({ description: event.target.value })} placeholder="说明设计变更的背景、目的和影响范围。" /><FieldCounter value={form.description} maximum={limits.batchDescription} /><FieldError message={errors.description} /></div>
        <div className="form-field"><label htmlFor="design-url">设计稿链接<RequiredMark /></label><input id="design-url" type="url" value={form.designUrl} onChange={(event) => onChange({ designUrl: event.target.value })} placeholder="https://figma.com/..." /><FieldError message={errors.designUrl} /></div>
        <section className="review-list" aria-label="本次变更清单"><h3>本次变更清单</h3>{changes.map((change) => <div key={change.clientId}><strong>{({ add: '新增', replace: '替换', delete: '删除' })[change.action]}</strong><span>{change.action === 'add' ? change.designName : change.target?.primaryName}{change.svg ? ` · ${change.svg.file.name}` : ''}</span></div>)}</section>
        <label className="confirm-check"><input type="checkbox" checked={confirmed} onChange={(event) => onConfirmedChange(event.target.checked)} /><span>我确认以上设计意图和 SVG 文件正确，并同意交由后续自动校验和开发审核。</span></label>
        <FieldError message={errors.confirmed} />
        <div className="dialog-actions"><button className="button secondary" type="button" disabled={busy} onClick={onClose}>继续编辑</button><button className="button primary" type="button" disabled={busy} onClick={onSubmit}>{busy ? '处理中…' : '进入校验'}</button></div>
      </section>
    </div>
  );
}

export function App() {
  const [profile, setProfile] = useState<DesignerProfile | undefined>(() => readProfile());
  const [identityOpen, setIdentityOpen] = useState(() => !readProfile());
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
  const [namePreview, setNamePreview] = useState<NamePreview>();
  const [namePreviewPending, setNamePreviewPending] = useState(false);
  const [namePreviewError, setNamePreviewError] = useState<string>();
  const [batch, setBatch] = useState<BatchDetails>();
  const [batchForm, setBatchForm] = useState({ title: '', description: '', designUrl: '' });
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewErrors, setReviewErrors] = useState<FieldErrors>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const liveSvgDrafts = useRef(new Map<string, SvgDraft>());

  const editable = !batch || batch.state === 'DRAFT';
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
    const localIssue = localNameIssue(addName);
    if (action !== 'add' || !editable || localIssue) {
      setNamePreview(undefined);
      setNamePreviewError(undefined);
      setNamePreviewPending(false);
      return undefined;
    }
    let cancelled = false;
    setNamePreviewPending(true);
    setNamePreviewError(undefined);
    const timer = window.setTimeout(() => {
      void api.previewName(addName.trim())
        .then((response) => { if (!cancelled) setNamePreview(response); })
        .catch((error: unknown) => { if (!cancelled) setNamePreviewError(error instanceof Error ? error.message : '无法检查图标名称。'); })
        .finally(() => { if (!cancelled) setNamePreviewPending(false); });
    }, 220);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [action, addName, editable]);

  useEffect(() => {
    if (!batch || !['QUEUED', 'RUNNING', 'COMMIT_PREPARED', 'BRANCH_PUSHED', 'PR_CREATING'].includes(batch.state)) return undefined;
    const timer = window.setInterval(() => {
      void api.getBatch(batch.id).then(setBatch).catch((error: unknown) => setNotice(error instanceof Error ? error.message : '无法刷新批次状态。'));
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [batch]);

  const selectAction = (nextAction: ItemAction) => {
    setAction(nextAction);
    setTarget(undefined);
    setReplacement(undefined);
    setCatalogSelection('target');
    setCatalogOpen(false);
    setChangeErrors({});
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

  const clearStaleValidation = (): boolean => {
    if (!batch?.validation) return false;
    setBatch((current) => current ? { ...current, validation: null } : current);
    return true;
  };

  const addChange = () => {
    const errors: FieldErrors = {};
    if (action !== 'delete' && !activeSvg) errors.svg = '请先拖入或选择 SVG 文件。';
    if (action === 'add') {
      const nameIssue = localNameIssue(addName);
      if (nameIssue) errors.designName = nameIssue;
      else if (namePreviewPending) errors.designName = '正在根据图标仓库规则生成最终名称。';
      else if (namePreviewError) errors.designName = `无法检查图标名称：${namePreviewError}`;
      else if (!namePreview) errors.designName = '请等待名称规则检查完成。';
      else if (!namePreview.valid) errors.designName = '该名称规范化后不符合图标仓库规则。';
      else if (namePreview.collision) errors.designName = `最终名称 ${namePreview.normalizedName} 已被 ${namePreview.collision.primaryName}（含 alias）使用。`;
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
    if (Object.keys(errors).length > 0) return;
    const change: DraftChange = {
      clientId: uniqueId('change'),
      action,
      ...(action === 'add' ? { designName: addName.trim(), description: addDescription.trim() } : {}),
      ...(action === 'replace' ? { target, description: replaceDescription.trim() || undefined, svg: activeSvg } : {}),
      ...(action === 'delete' ? { target, reason: deleteReason.trim(), replacement } : {}),
      ...(action === 'add' ? { svg: activeSvg } : {}),
    };
    setChanges((current) => [...current, change]);
    const stale = clearStaleValidation();
    if (activeSvg) removePendingSvg(activeSvg.id, true);
    setTarget(undefined);
    setAddName(''); setAddDescription(''); setReplaceDescription(''); setDeleteReason(''); setReplacement(undefined);
    setChangeErrors({});
    setNotice(stale ? '变更已修改，需要重新校验。' : '已加入本次变更。其余 SVG 会继续保留在待处理队列。');
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
    setChanges((current) => current.filter((candidate) => candidate.clientId !== change.clientId));
    if (clearStaleValidation()) {
      setNotice('变更已修改，需要重新校验。');
    }
  };

  const validateReview = (): boolean => {
    const errors: FieldErrors = {};
    if (!batchForm.title.trim()) errors.title = '请填写本次变更标题。';
    else if (fieldLengthIssue(batchForm.title, '本次变更标题', limits.batchTitle)) errors.title = fieldLengthIssue(batchForm.title, '本次变更标题', limits.batchTitle)!;
    if (!batchForm.description.trim()) errors.description = '请填写整体需求说明。';
    else if (fieldLengthIssue(batchForm.description, '整体需求说明', limits.batchDescription)) errors.description = fieldLengthIssue(batchForm.description, '整体需求说明', limits.batchDescription)!;
    if (!isHttpUrl(batchForm.designUrl.trim())) errors.designUrl = '请填写有效的 HTTP(S) 设计稿链接。';
    if (!confirmed) errors.confirmed = '请确认本次变更内容。';
    setReviewErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const syncChanges = async (batchId: string): Promise<DraftChange[]> => {
    const saved: DraftChange[] = [];
    for (const change of changes) {
      const item: ApiItem = change.serverId
        ? await api.updateItem(batchId, change.serverId, toItemInput(change), change.svg?.file)
        : await api.addItem(batchId, toItemInput(change), change.svg?.file);
      saved.push({ ...change, serverId: item.id });
    }
    return saved;
  };

  const startValidation = async () => {
    if (!profile || !validateReview()) return;
    setBusy(true);
    setNotice(undefined);
    try {
      let currentBatch = batch;
      if (!currentBatch) {
        currentBatch = await api.createBatch({ ...batchForm, submitter: { name: profile.name, email: profile.email } });
        setBatch(currentBatch);
      }
      const saved = await syncChanges(currentBatch.id);
      setChanges(saved);
      const validated = await api.validateBatch(currentBatch.id);
      setBatch(validated);
      setReviewOpen(false);
      setNotice(validated.validation?.valid ? '校验通过，可以生成本地修改。' : '发现需要修正的问题，请调整后再次校验。');
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : '校验请求失败。');
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!batch) return;
    setBusy(true);
    try {
      const queued = await api.submitBatch(batch.id);
      setBatch(queued);
      setNotice('已开始基于最新上游生成本地修改。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法生成本地修改。');
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!batch) return;
    setBusy(true);
    try {
      setBatch(await api.retryBatch(batch.id));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法重试。');
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = (nextProfile: DesignerProfile) => {
    writeProfile(nextProfile);
    setProfile(nextProfile);
    setIdentityOpen(false);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><img className="brand-logo" src="/pink-icon.svg" alt="" /><span>PinK 图标工作台</span></div>
        {profile && <button className="profile-button" type="button" onClick={() => setIdentityOpen(true)} aria-label="修改设计师身份"><span className="avatar">{profile.name.slice(0, 1)}</span><span><strong>{profile.name}</strong><small>{profile.email}</small></span></button>}
      </header>
      <main className="page-shell">
        <header className="page-header"><h1>完成设计，交给开发</h1><p>选择现有图标或拖入新的 SVG，把本次设计变更一次提交给开发审核。</p></header>

        {notice && <p className="notice">{notice}</p>}
        {batch && <p className={`state-notice state-${batch.state.toLowerCase()}`}>批次状态：<strong>{stateLabel[batch.state]}</strong></p>}

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

          {action === 'add' && <div className="form-field"><label htmlFor="add-name">图标建议名称<RequiredMark /></label><input id="add-name" maxLength={limits.name} value={addName} disabled={!editable || busy} onChange={(event) => setAddName(event.target.value)} placeholder="例如：pink-model-preview" /><FieldCounter value={addName} maximum={limits.name} />{namePreviewPending && <p className="field-hint">正在按图标仓库规则生成最终名称…</p>}{namePreview && <p className={`name-preview ${namePreview.collision ? 'collision' : ''}`}>建议名称：<strong>{namePreview.input}</strong> → 最终名称：<strong>{namePreview.normalizedName || '无效'}</strong>{namePreview.collision && <span> 已与 {namePreview.collision.primaryName}（{namePreview.collision.aliases.join('、')}）冲突。</span>}</p>}{namePreviewError && <p className="field-error">名称预览失败：{namePreviewError}</p>}<FieldError message={changeErrors.designName} /></div>}
          {action === 'add' && <div className="form-field"><label htmlFor="add-description">用途说明<RequiredMark /></label><textarea id="add-description" maxLength={limits.itemText} value={addDescription} disabled={!editable || busy} onChange={(event) => setAddDescription(event.target.value)} placeholder="说明图标表达的对象或操作。" /><FieldCounter value={addDescription} maximum={limits.itemText} /><FieldError message={changeErrors.description} /></div>}
          {action === 'replace' && <div className="form-field"><label htmlFor="replace-description">本次替换说明 <em>（可选）</em></label><textarea id="replace-description" maxLength={limits.itemText} value={replaceDescription} disabled={!editable || busy} onChange={(event) => setReplaceDescription(event.target.value)} placeholder="例如：与新的模型资产视觉语言保持一致。" /><FieldCounter value={replaceDescription} maximum={limits.itemText} /><FieldError message={changeErrors.description} /></div>}
          {action === 'delete' && <>
            <div className="form-field"><label htmlFor="delete-reason">删除原因<RequiredMark /></label><textarea id="delete-reason" maxLength={limits.itemText} value={deleteReason} disabled={!editable || busy} onChange={(event) => setDeleteReason(event.target.value)} placeholder="例如：图标已废弃且无替代用途。" /><FieldCounter value={deleteReason} maximum={limits.itemText} /><FieldError message={changeErrors.reason} /></div>
            <div className="form-field"><span className="field-label">建议使用的替代图标 <em>（可选）</em></span>{replacement ? <div className="replacement-choice"><img src={svgPreviewUrl(replacement.svg)} alt={`${replacement.primaryName} 替代图标`} /><span><strong>{replacement.primaryName}</strong><small>现有 primary 图标</small></span><button type="button" disabled={!editable || busy} onClick={() => { setReplacement(undefined); setCatalogSelection('replacement'); setCatalogOpen(true); }}>重新选择</button></div> : <button className="button secondary" type="button" disabled={!editable || busy || !target} onClick={() => { setCatalogSelection('replacement'); setCatalogOpen(true); }}>从图标目录选择替代图标</button>}<FieldError message={changeErrors.replacement} /></div>
          </>}
          {action !== 'delete' && <SvgQueue pending={pendingSvgs} activeSvgId={activeSvgId} disabled={!editable || busy} error={changeErrors.svg} onQueue={queueSvgs} onActivate={setActiveSvgId} onRemove={removePendingSvg} />}
          {action === 'replace' && target && activeSvg?.content === target.svg && <p className="inline-warning">新 SVG 与当前仓库文件内容完全一致；这次替换可能不会产生实际改动。</p>}
          <div className="composer-actions"><span>操作先保留在当前浏览器草稿；尚未提交到图标仓库。</span><button className="button primary" type="button" disabled={!editable || busy} onClick={addChange}>加入{({ add: '新增', replace: '替换', delete: '删除' })[action]}队列</button></div>
        </section>

        <section className="changes-card" aria-label="本次变更"><div><h2>本次变更 {changes.length} 项</h2><p>{changes.length === 0 ? '把一项操作加入队列后，会在这里同时显示所有待改动图标。' : '确认前可移除任何一项变更。'}</p></div><div className="change-list">{changes.map((change) => <ChangeCard key={change.clientId} change={change} disabled={!editable || busy} onRemove={() => void removeChange(change)} />)}</div><div className="changes-actions"><button className="button primary" type="button" disabled={!editable || busy || changes.length === 0} onClick={() => { setReviewErrors({}); setReviewOpen(true); }}>确认本次变更</button></div></section>

        <DiagnosticList title="需要修正的问题" diagnostics={batch?.validation?.errors ?? []} tone="error" />
        <DiagnosticList title="开发审核提醒" diagnostics={batch?.validation?.warnings ?? []} tone="warning" />
        {batch?.error && <section className="diagnostics error"><h2>处理失败</h2><p><strong>{batch.error.code}</strong> {batch.error.message}</p></section>}
        {batch?.delivery?.pullRequest && <section className="result-card"><p className="eyebrow">Draft PR 已创建</p><h2>已交给开发审核和接管</h2><p><a href={batch.delivery.pullRequest.url} target="_blank" rel="noreferrer">打开 Draft PR #{batch.delivery.pullRequest.number}</a></p><p>平台已停止写入该机器人分支；后续调整请直接在 PR 中完成。</p></section>}
        {batch?.localDiff && !batch.delivery?.pullRequest && <section className="result-card"><p className="eyebrow">修改已生成</p><h2>{batch.state === 'BRANCH_PUSHED' || batch.state === 'PR_CREATING' ? '正在创建 Draft PR' : '等待创建 Draft PR'}</h2><details><summary>查看技术详情</summary><ul>{batch.localDiff.changedFiles.map((file) => <li key={file}>{file}</li>)}</ul></details></section>}
        <section className="post-validation-actions">{batch?.state === 'READY' && <button className="button primary" type="button" disabled={busy} onClick={() => void submit()}>生成本地修改</button>}{batch?.state === 'FAILED' && <button className="button primary" type="button" disabled={busy} onClick={() => void retry()}>重试</button>}</section>
      </main>
      {identityOpen && <IdentityDialog profile={profile} onSave={saveProfile} onClose={profile ? () => setIdentityOpen(false) : undefined} />}
      {reviewOpen && profile && <ReviewDrawer changes={changes} form={batchForm} profile={profile} errors={reviewErrors} confirmed={confirmed} busy={busy} onChange={(patch) => setBatchForm((current) => ({ ...current, ...patch }))} onConfirmedChange={setConfirmed} onClose={() => setReviewOpen(false)} onSubmit={() => void startValidation()} />}
    </div>
  );
}
