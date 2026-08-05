import { useEffect, useMemo, useRef, useState } from 'react';

import { api, ApiError, type ApiItem, type BatchDetails, type CatalogGroup, type CatalogPageIcon, type Diagnostic, type ItemAction, type ItemInput, type Submitter } from './api';

interface DesignerProfile extends Submitter {
  version: 1;
}

interface SvgDraft {
  id: string;
  file: File;
  previewUrl: string | undefined;
}

interface DraftChange {
  clientId: string;
  serverId?: string;
  action: ItemAction;
  designName?: string;
  target?: CatalogPageIcon;
  description?: string;
  reason?: string;
  replacementName?: string;
  svg?: SvgDraft;
}

type FieldErrors = Record<string, string>;

const identityStorageKey = 'pink-icon-submit.designer-profile.v1';
const pageSize = 24;
let nextClientId = 1;

const stateLabel: Record<BatchDetails['state'], string> = {
  DRAFT: '待校验',
  VALIDATING: '校验中',
  READY: '校验通过',
  QUEUED: '等待生成本地修改',
  RUNNING: '正在生成本地修改',
  LOCAL_DIFF_READY: '本地修改已生成',
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
  return { id: uniqueId('svg'), file, previewUrl };
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
    ...(change.replacementName ? { replacementName: change.replacementName } : {}),
  };
}

function diagnosticLabel(diagnostic: Diagnostic): string {
  return diagnostic.itemId ? `${diagnostic.code}（${diagnostic.itemId}）` : diagnostic.code;
}

function RequiredMark() {
  return <span className="required-mark" aria-label="必填">*</span>;
}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="field-error" role="alert">{message}</p> : null;
}

function IdentityDialog({ profile, onSave, onClose }: { profile?: DesignerProfile; onSave: (profile: DesignerProfile) => void; onClose?: () => void }) {
  const [name, setName] = useState(profile?.name ?? '');
  const [email, setEmail] = useState(profile?.email ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});

  const submit = () => {
    const nextErrors: FieldErrors = {};
    if (!name.trim()) nextErrors.name = '请填写姓名。';
    if (!isEmail(email.trim())) nextErrors.email = '请填写有效的公司邮箱。';
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
          <input id="identity-name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：李思思" />
          <FieldError message={errors.name} />
        </div>
        <div className="form-field">
          <label htmlFor="identity-email">公司邮箱<RequiredMark /></label>
          <input id="identity-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" />
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
  disabled,
  onQueryChange,
  onGroupChange,
  onPageChange,
  onSelect,
}: {
  catalog?: Awaited<ReturnType<typeof api.getCatalogPage>>;
  loading: boolean;
  error?: string;
  query: string;
  group: CatalogGroup;
  selected?: CatalogPageIcon;
  disabled: boolean;
  onQueryChange: (value: string) => void;
  onGroupChange: (value: CatalogGroup) => void;
  onPageChange: (page: number) => void;
  onSelect: (icon: CatalogPageIcon) => void;
}) {
  const totalPages = catalog ? Math.max(1, Math.ceil(catalog.total / catalog.pageSize)) : 1;
  const groups: Array<{ value: CatalogGroup; label: string }> = [
    { value: 'all', label: '全部' },
    { value: 'pink', label: 'PinK' },
    { value: 'toolbar', label: '工具栏' },
    { value: 'common', label: '通用' },
  ];

  return (
    <section className="catalog-browser" aria-labelledby="catalog-title">
      <div className="catalog-heading">
        <div>
          <p className="eyebrow">从当前图标仓库选择</p>
          <h3 id="catalog-title">图标目录</h3>
        </div>
        <span>{catalog ? `${catalog.total} 个结果` : '加载中…'}</span>
      </div>
      <p className="catalog-copy">名称与 alias 都能搜索。点击选择，或把图标拖到下方目标区域。</p>
      <label className="sr-only" htmlFor="catalog-search">搜索名称或别名</label>
      <input id="catalog-search" type="search" value={query} disabled={disabled} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索名称或别名，例如 pink、preview、logo" />
      <div className="filter-row" aria-label="图标分类">
        {groups.map((option) => <button key={option.value} className={`filter ${group === option.value ? 'active' : ''}`} type="button" disabled={disabled} onClick={() => onGroupChange(option.value)}>{option.label}</button>)}
      </div>
      {error && <p className="inline-error">图标目录加载失败：{error}</p>}
      <div className="catalog-grid" aria-busy={loading}>
        {loading && <p className="catalog-empty">正在读取最新图标目录…</p>}
        {!loading && catalog?.icons.length === 0 && <p className="catalog-empty">没有匹配的图标。试试其他搜索词或分类。</p>}
        {!loading && catalog?.icons.map((icon) => (
          <button
            key={icon.primaryName}
            className={`catalog-card ${selected?.primaryName === icon.primaryName ? 'selected' : ''}`}
            type="button"
            draggable={!disabled}
            disabled={disabled}
            onClick={() => onSelect(icon)}
            onDragStart={(event) => event.dataTransfer.setData('application/x-pink-icon', icon.primaryName)}
            aria-label={`选择 ${icon.primaryName}`}
          >
            <img src={svgPreviewUrl(icon.svg)} alt="" />
            <strong>{icon.primaryName}</strong>
            <span>{icon.aliases.length ? icon.aliases.join(' · ') : icon.group}</span>
          </button>
        ))}
      </div>
      {catalog && totalPages > 1 && (
        <div className="catalog-pagination">
          <button type="button" disabled={disabled || catalog.page === 1} onClick={() => onPageChange(catalog.page - 1)}>上一页</button>
          <span>第 {catalog.page} / {totalPages} 页</span>
          <button type="button" disabled={disabled || catalog.page === totalPages} onClick={() => onPageChange(catalog.page + 1)}>下一页</button>
        </div>
      )}
    </section>
  );
}

function TargetZone({ action, target, error, disabled, onDrop, onClear }: { action: 'replace' | 'delete'; target?: CatalogPageIcon; error?: string; disabled: boolean; onDrop: (name: string) => void; onClear: () => void }) {
  const label = action === 'replace' ? '需要替换的图标' : '需要删除的图标';
  return (
    <div className="form-field">
      <span className="field-label">{label}<RequiredMark /></span>
      <div
        className={`target-zone ${target ? 'has-target' : ''}`}
        onDragOver={(event) => { if (!disabled) event.preventDefault(); }}
        onDrop={(event) => {
          event.preventDefault();
          const name = event.dataTransfer.getData('application/x-pink-icon');
          if (name) onDrop(name);
        }}
      >
        {target ? (
          <div className="target-card">
            <img src={svgPreviewUrl(target.svg)} alt={`${target.primaryName} 当前图标`} />
            <span><strong>{target.primaryName}</strong><small>{action === 'replace' ? '待替换图标' : '待删除图标'} · {target.aliases.join(' · ') || target.group}</small></span>
            <button type="button" disabled={disabled} onClick={onClear}>重新选择</button>
          </div>
        ) : (
          <span><strong>从上方图标目录拖到这里</strong><small>或点击任意图标卡片进行选择</small></span>
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
      {active && <div className="active-svg-preview"><SvgPreview svg={active} alt={`${active.file.name} 预览`} /><span><strong>{active.file.name}</strong><small>当前待处理 SVG</small></span></div>}
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
      <p className="field-hint">每个 SVG 会保留独立预览。替换时，先选择待处理 SVG，再从目录选择它要替换的旧图标。</p>
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
        <p className="review-note">提交人会自动使用 <strong>{profile.name}</strong>（{profile.email}）。这里不会展示 codepoint 或 mapping；它们由图标仓库规则生成并由开发审核。</p>
        <div className="form-field"><label htmlFor="batch-title">本次变更标题<RequiredMark /></label><input id="batch-title" value={form.title} onChange={(event) => onChange({ title: event.target.value })} placeholder="例如：模型页图标视觉更新" /><FieldError message={errors.title} /></div>
        <div className="form-field"><label htmlFor="batch-description">整体需求说明<RequiredMark /></label><textarea id="batch-description" value={form.description} onChange={(event) => onChange({ description: event.target.value })} placeholder="说明设计变更的背景、目的和影响范围。" /><FieldError message={errors.description} /></div>
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
  const [replacementName, setReplacementName] = useState('');
  const [changeErrors, setChangeErrors] = useState<FieldErrors>({});
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogGroup, setCatalogGroup] = useState<CatalogGroup>('all');
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof api.getCatalogPage>>>();
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string>();
  const [batch, setBatch] = useState<BatchDetails>();
  const [batchForm, setBatchForm] = useState({ title: '', description: '', designUrl: '' });
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewErrors, setReviewErrors] = useState<FieldErrors>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const liveSvgDrafts = useRef(new Map<string, SvgDraft>());

  const editable = !batch || batch.state === 'DRAFT';
  const needsCatalog = editable && (action === 'replace' || action === 'delete');
  const activeSvg = useMemo(() => pendingSvgs.find((svg) => svg.id === activeSvgId), [activeSvgId, pendingSvgs]);

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
    if (!batch || !['QUEUED', 'RUNNING'].includes(batch.state)) return undefined;
    const timer = window.setInterval(() => {
      void api.getBatch(batch.id).then(setBatch).catch((error: unknown) => setNotice(error instanceof Error ? error.message : '无法刷新批次状态。'));
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [batch]);

  const selectAction = (nextAction: ItemAction) => {
    setAction(nextAction);
    setTarget(undefined);
    setChangeErrors({});
  };

  const queueSvgs = (files: FileList | File[]) => {
    const incoming = Array.from(files);
    const accepted = incoming.filter((file) => file.name.toLowerCase().endsWith('.svg')).map(createSvgDraft);
    if (accepted.length === 0) {
      setNotice('请选择 SVG 文件。');
      return;
    }
    accepted.forEach((svg) => liveSvgDrafts.current.set(svg.id, svg));
    setPendingSvgs((current) => [...current, ...accepted]);
    setActiveSvgId(accepted[0].id);
    setChangeErrors((current) => ({ ...current, svg: '' }));
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
    setTarget(icon);
    setChangeErrors((current) => ({ ...current, target: '' }));
  };

  const resolveDroppedTarget = (name: string) => {
    const icon = catalog?.icons.find((candidate) => candidate.primaryName === name);
    if (icon) selectTarget(icon);
  };

  const addChange = () => {
    const errors: FieldErrors = {};
    if (action !== 'delete' && !activeSvg) errors.svg = '请先拖入或选择 SVG 文件。';
    if (action === 'add') {
      if (!addName.trim()) errors.designName = '请填写图标建议名称。';
      if (!addDescription.trim()) errors.description = '请填写用途说明。';
    }
    if (action === 'replace' && !target) errors.target = '请选择一个需要替换的现有图标。';
    if (action === 'delete') {
      if (!target) errors.target = '请选择一个需要删除的现有图标。';
      if (!deleteReason.trim()) errors.reason = '请填写删除原因。';
    }
    setChangeErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const change: DraftChange = {
      clientId: uniqueId('change'),
      action,
      ...(action === 'add' ? { designName: addName.trim(), description: addDescription.trim() } : {}),
      ...(action === 'replace' ? { target, description: replaceDescription.trim() || undefined, svg: activeSvg } : {}),
      ...(action === 'delete' ? { target, reason: deleteReason.trim(), replacementName: replacementName.trim() || undefined } : {}),
      ...(action === 'add' ? { svg: activeSvg } : {}),
    };
    setChanges((current) => [...current, change]);
    if (activeSvg) removePendingSvg(activeSvg.id, true);
    setTarget(undefined);
    setAddName(''); setAddDescription(''); setReplaceDescription(''); setDeleteReason(''); setReplacementName('');
    setChangeErrors({});
    setNotice('已加入本次变更。其余 SVG 会继续保留在待处理队列。');
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
  };

  const validateReview = (): boolean => {
    const errors: FieldErrors = {};
    if (!batchForm.title.trim()) errors.title = '请填写本次变更标题。';
    if (!batchForm.description.trim()) errors.description = '请填写整体需求说明。';
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
        <div className="brand"><span className="brand-mark">P</span><span>PinK 图标工作台</span></div>
        {profile && <button className="profile-button" type="button" onClick={() => setIdentityOpen(true)} aria-label="修改设计师身份"><span className="avatar">{profile.name.slice(0, 1)}</span><span><strong>{profile.name}</strong><small>{profile.email}</small></span></button>}
      </header>
      <main className="page-shell">
        <header className="page-header"><h1>先完成设计，再交给代码</h1><p>在同一个工作台里选择现有图标、拖入新 SVG，并汇总成一次清晰的设计变更。图标命名、codepoint 与仓库规则由后续校验处理。</p></header>
        <p className="required-legend"><RequiredMark /> 为提交前必须补全的信息</p>
        <nav className="steps" aria-label="提交流程"><span className="done">✓ 设计师身份</span><span className="active">2 编辑图标变更</span><span>3 确认并校验</span></nav>

        {notice && <p className="notice">{notice}</p>}
        {batch && <p className={`state-notice state-${batch.state.toLowerCase()}`}>批次状态：<strong>{stateLabel[batch.state]}</strong></p>}

        <section className="composer-card" aria-labelledby="composer-title">
          <p className="eyebrow">正在编辑一项变更</p>
          <h2 id="composer-title">{({ add: '新增一个图标', replace: '替换已有图标', delete: '删除已有图标' })[action]}</h2>
          <p className="composer-copy">{action === 'add' ? '拖入一个或多个 SVG。每个 SVG 会显示预览，并可依次加入新增队列。' : action === 'replace' ? '从下方目录选择要替换的旧图标，再从待处理 SVG 中选择对应的新图标。可重复完成多项替换。' : '从下方目录选择要删除的图标，并说明为什么可以安全移除。删除不需要 SVG。'}</p>
          <div className="action-tabs" role="tablist" aria-label="变更类型">
            {(['add', 'replace', 'delete'] as ItemAction[]).map((option) => <button key={option} className={action === option ? 'active' : ''} type="button" role="tab" aria-selected={action === option} disabled={!editable || busy} onClick={() => selectAction(option)}>{({ add: '新增图标', replace: '替换图标', delete: '删除图标' })[option]}</button>)}
          </div>

          {needsCatalog && <CatalogBrowser catalog={catalog} loading={catalogLoading} error={catalogError} query={catalogQuery} group={catalogGroup} selected={target} disabled={!editable || busy} onQueryChange={(value) => { setCatalogQuery(value); setCatalogPage(1); }} onGroupChange={(value) => { setCatalogGroup(value); setCatalogPage(1); }} onPageChange={setCatalogPage} onSelect={selectTarget} />}

          {action !== 'add' && <TargetZone action={action} target={target} error={changeErrors.target} disabled={!editable || busy} onDrop={resolveDroppedTarget} onClear={() => setTarget(undefined)} />}

          {action === 'add' && <div className="form-field"><label htmlFor="add-name">图标建议名称<RequiredMark /></label><input id="add-name" value={addName} disabled={!editable || busy} onChange={(event) => setAddName(event.target.value)} placeholder="例如：pink-model-preview" /><FieldError message={changeErrors.designName} /></div>}
          {action === 'add' && <div className="form-field"><label htmlFor="add-description">用途说明<RequiredMark /></label><textarea id="add-description" value={addDescription} disabled={!editable || busy} onChange={(event) => setAddDescription(event.target.value)} placeholder="说明图标表达的对象或操作。" /><FieldError message={changeErrors.description} /></div>}
          {action === 'replace' && <div className="form-field"><label htmlFor="replace-description">本次替换说明 <em>（可选）</em></label><textarea id="replace-description" value={replaceDescription} disabled={!editable || busy} onChange={(event) => setReplaceDescription(event.target.value)} placeholder="例如：与新的模型资产视觉语言保持一致。" /></div>}
          {action === 'delete' && <><div className="form-field"><label htmlFor="delete-reason">删除原因<RequiredMark /></label><textarea id="delete-reason" value={deleteReason} disabled={!editable || busy} onChange={(event) => setDeleteReason(event.target.value)} placeholder="例如：图标已废弃且无替代用途。" /><FieldError message={changeErrors.reason} /></div><div className="form-field"><label htmlFor="replacement-name">建议使用的替代图标 <em>（可选）</em></label><input id="replacement-name" value={replacementName} disabled={!editable || busy} onChange={(event) => setReplacementName(event.target.value)} placeholder="例如：pink-logo" /></div></>}
          {action !== 'delete' && <SvgQueue pending={pendingSvgs} activeSvgId={activeSvgId} disabled={!editable || busy} error={changeErrors.svg} onQueue={queueSvgs} onActivate={setActiveSvgId} onRemove={removePendingSvg} />}
          <div className="composer-actions"><span>操作先保留在当前浏览器草稿；尚未提交到图标仓库。</span><button className="button primary" type="button" disabled={!editable || busy} onClick={addChange}>加入{({ add: '新增', replace: '替换', delete: '删除' })[action]}队列</button></div>
        </section>

        <section className="changes-card" aria-label="本次变更"><div><h2>本次变更 {changes.length} 项</h2><p>{changes.length === 0 ? '把一项操作加入队列后，会在这里同时显示所有待改动图标。' : '确认前可移除任何一项变更。'}</p></div><div className="change-list">{changes.map((change) => <ChangeCard key={change.clientId} change={change} disabled={!editable || busy} onRemove={() => void removeChange(change)} />)}</div><div className="changes-actions"><button className="button primary" type="button" disabled={!editable || busy || changes.length === 0} onClick={() => { setReviewErrors({}); setReviewOpen(true); }}>确认本次变更</button></div></section>

        <DiagnosticList title="需要修正的问题" diagnostics={batch?.validation?.errors ?? []} tone="error" />
        <DiagnosticList title="需要开发确认的提醒" diagnostics={batch?.validation?.warnings ?? []} tone="warning" />
        {batch?.error && <section className="diagnostics error"><h2>处理失败</h2><p><strong>{batch.error.code}</strong> {batch.error.message}</p></section>}
        {batch?.localDiff && <section className="result-card"><p className="eyebrow">本地修改已就绪</p><h2>等待阶段 3 创建 Draft PR</h2><p>当前阶段只生成并保存可审阅的本地 diff，不会创建 GitHub 分支或 Pull Request。</p><details><summary>查看技术详情</summary><ul>{batch.localDiff.changedFiles.map((file) => <li key={file}>{file}</li>)}</ul></details></section>}
        <section className="post-validation-actions">{batch?.state === 'READY' && <button className="button primary" type="button" disabled={busy} onClick={() => void submit()}>生成本地修改</button>}{batch?.state === 'FAILED' && <button className="button primary" type="button" disabled={busy} onClick={() => void retry()}>重试</button>}</section>
      </main>
      {identityOpen && <IdentityDialog profile={profile} onSave={saveProfile} onClose={profile ? () => setIdentityOpen(false) : undefined} />}
      {reviewOpen && profile && <ReviewDrawer changes={changes} form={batchForm} profile={profile} errors={reviewErrors} confirmed={confirmed} busy={busy} onChange={(patch) => setBatchForm((current) => ({ ...current, ...patch }))} onConfirmedChange={setConfirmed} onClose={() => setReviewOpen(false)} onSubmit={() => void startValidation()} />}
    </div>
  );
}
