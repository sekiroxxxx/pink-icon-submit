import { useEffect, useMemo, useState } from 'react';

import { api, ApiError, type ApiItem, type BatchDetails, type BatchInput, type CatalogIcon, type Diagnostic, type ItemAction, type ItemInput } from './api';

interface DraftItem extends ItemInput {
  clientId: string;
  serverId?: string;
  svg?: File;
  svgChanged: boolean;
}

const initialBatch: BatchInput = {
  title: '',
  description: '',
  designUrl: '',
  submitter: { name: '', email: '' },
};

const stateLabel: Record<BatchDetails['state'], string> = {
  DRAFT: '待校验',
  VALIDATING: '校验中',
  READY: '校验通过',
  QUEUED: '等待生成本地修改',
  RUNNING: '正在生成本地修改',
  LOCAL_DIFF_READY: '本地修改已生成',
  FAILED: '处理失败',
};

let nextClientId = 1;

function createDraftItem(action: ItemAction = 'add'): DraftItem {
  return { clientId: `draft-${nextClientId++}`, action, svgChanged: false };
}

function toItemInput(item: DraftItem): ItemInput {
  return {
    action: item.action,
    ...(item.designName ? { designName: item.designName } : {}),
    ...(item.targetName ? { targetName: item.targetName } : {}),
    ...(item.description ? { description: item.description } : {}),
    ...(item.reason ? { reason: item.reason } : {}),
    ...(item.replacementName ? { replacementName: item.replacementName } : {}),
  };
}

function diagnosticLabel(diagnostic: Diagnostic): string {
  return diagnostic.itemId ? `${diagnostic.code}（${diagnostic.itemId}）` : diagnostic.code;
}

function UploadedPreview({ file }: { file?: File }) {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    if (!file) {
      setUrl(undefined);
      return undefined;
    }
    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  if (!file || !url) {
    return null;
  }
  return (
    <div className="preview-card">
      <img src={url} alt={`${file.name} 的预览`} />
      <span>{file.name}</span>
    </div>
  );
}

function CatalogPicker({
  id,
  label,
  value,
  icons,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  icons: CatalogIcon[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const matches = useMemo(() => {
    const needle = value.trim().toLowerCase();
    return icons.filter((icon) => !needle || [icon.primaryName, ...icon.aliases].some((name) => name.toLowerCase().includes(needle))).slice(0, 50);
  }, [icons, value]);
  const selectedIcon = useMemo(() => icons.find((icon) => icon.primaryName === value || icon.aliases.includes(value)), [icons, value]);

  return (
    <div className="field catalog-picker">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        list={`${id}-options`}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder="搜索现有图标名称"
      />
      <datalist id={`${id}-options`}>
        {matches.map((icon) => (
          <option key={icon.primaryName} value={icon.primaryName} label={icon.aliases.length ? `别名：${icon.aliases.join(', ')}` : undefined} />
        ))}
      </datalist>
      {selectedIcon && (
        <div className="preview-card catalog-preview">
          <img src={api.iconPreviewUrl(selectedIcon.primaryName)} alt={`${selectedIcon.primaryName} 的当前图标`} />
          <span>当前图标：{selectedIcon.primaryName}</span>
        </div>
      )}
    </div>
  );
}

function ItemEditor({
  item,
  index,
  icons,
  disabled,
  onChange,
  onRemove,
}: {
  item: DraftItem;
  index: number;
  icons: CatalogIcon[];
  disabled: boolean;
  onChange: (patch: Partial<DraftItem>) => void;
  onRemove: () => void;
}) {
  const baseId = `item-${item.clientId}`;
  const requiresSvg = item.action === 'add' || item.action === 'replace';

  return (
    <section className="item-card" aria-label={`图标操作 ${index + 1}`}>
      <div className="item-heading">
        <h3>图标操作 {index + 1}</h3>
        <button className="link-button danger" type="button" disabled={disabled} onClick={onRemove}>移除</button>
      </div>
      <div className="field-grid">
        <div className="field">
          <label htmlFor={`${baseId}-action`}>操作</label>
          <select
            id={`${baseId}-action`}
            value={item.action}
            disabled={disabled}
            onChange={(event) => {
              const action = event.target.value as ItemAction;
              onChange(action === 'delete' ? { action, svg: undefined, svgChanged: false } : { action });
            }}
          >
            <option value="add">新增</option>
            <option value="replace">替换</option>
            <option value="delete">删除</option>
          </select>
        </div>
        {item.action === 'add' && (
          <>
            <div className="field">
              <label htmlFor={`${baseId}-name`}>设计建议名称</label>
              <input id={`${baseId}-name`} value={item.designName ?? ''} disabled={disabled} onChange={(event) => onChange({ designName: event.target.value })} />
            </div>
            <div className="field field-wide">
              <label htmlFor={`${baseId}-description`}>用途说明</label>
              <textarea id={`${baseId}-description`} value={item.description ?? ''} disabled={disabled} onChange={(event) => onChange({ description: event.target.value })} />
            </div>
          </>
        )}
        {item.action === 'replace' && (
          <>
            <CatalogPicker id={`${baseId}-target`} label="需要替换的图标" value={item.targetName ?? ''} icons={icons} disabled={disabled} onChange={(targetName) => onChange({ targetName })} />
            <div className="field field-wide">
              <label htmlFor={`${baseId}-description`}>替换说明（可选）</label>
              <textarea id={`${baseId}-description`} value={item.description ?? ''} disabled={disabled} onChange={(event) => onChange({ description: event.target.value })} />
            </div>
          </>
        )}
        {item.action === 'delete' && (
          <>
            <CatalogPicker id={`${baseId}-target`} label="需要删除的图标" value={item.targetName ?? ''} icons={icons} disabled={disabled} onChange={(targetName) => onChange({ targetName })} />
            <div className="field">
              <label htmlFor={`${baseId}-replacement`}>替代图标（可选）</label>
              <input id={`${baseId}-replacement`} list={`${baseId}-replacement-options`} value={item.replacementName ?? ''} disabled={disabled} onChange={(event) => onChange({ replacementName: event.target.value })} />
              <datalist id={`${baseId}-replacement-options`}>
                {icons.map((icon) => <option key={icon.primaryName} value={icon.primaryName} />)}
              </datalist>
            </div>
            <div className="field field-wide">
              <label htmlFor={`${baseId}-reason`}>删除原因</label>
              <textarea id={`${baseId}-reason`} value={item.reason ?? ''} disabled={disabled} onChange={(event) => onChange({ reason: event.target.value })} />
            </div>
          </>
        )}
        {requiresSvg && (
          <div className="field field-wide upload-field">
            <label htmlFor={`${baseId}-svg`}>{item.action === 'add' ? 'SVG 文件' : '新的 SVG 文件'}</label>
            <input
              id={`${baseId}-svg`}
              type="file"
              accept="image/svg+xml,.svg"
              disabled={disabled}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  onChange({ svg: file, svgChanged: true });
                }
              }}
            />
            <p className="hint">仅用于即时预览；最终 SVG 安全与单色校验以后端和图标仓库规则为准。</p>
            <UploadedPreview file={item.svg} />
          </div>
        )}
      </div>
    </section>
  );
}

function DiagnosticList({ title, diagnostics, tone }: { title: string; diagnostics: Diagnostic[]; tone: 'error' | 'warning' }) {
  if (diagnostics.length === 0) {
    return null;
  }
  return (
    <section className={`diagnostics ${tone}`} aria-label={title}>
      <h2>{title}</h2>
      <ul>
        {diagnostics.map((diagnostic, index) => (
          <li key={`${diagnostic.code}-${diagnostic.itemId ?? index}`}>
            <strong>{diagnosticLabel(diagnostic)}</strong>
            <span>{diagnostic.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function App() {
  const [catalog, setCatalog] = useState<CatalogIcon[]>([]);
  const [catalogError, setCatalogError] = useState<string>();
  const [form, setForm] = useState<BatchInput>(initialBatch);
  const [items, setItems] = useState<DraftItem[]>([createDraftItem()]);
  const [batch, setBatch] = useState<BatchDetails>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    void api.getCatalog()
      .then((response) => setCatalog(response.icons))
      .catch((error: unknown) => setCatalogError(error instanceof Error ? error.message : '无法加载图标目录。'));
  }, []);

  useEffect(() => {
    if (!batch || !['QUEUED', 'RUNNING'].includes(batch.state)) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void api.getBatch(batch.id).then(setBatch).catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : '无法刷新批次状态。');
      });
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [batch]);

  const editable = !batch || batch.state === 'DRAFT';
  const validation = batch?.validation;

  const updateItem = (clientId: string, patch: Partial<DraftItem>) => {
    setItems((current) => current.map((item) => item.clientId === clientId ? { ...item, ...patch } : item));
  };

  const removeItem = async (item: DraftItem) => {
    if (!batch || !item.serverId) {
      setItems((current) => current.filter((candidate) => candidate.clientId !== item.clientId));
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      await api.deleteItem(batch.id, item.serverId);
      setItems((current) => current.filter((candidate) => candidate.clientId !== item.clientId));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法移除图标操作。');
    } finally {
      setBusy(false);
    }
  };

  const syncItems = async (batchId: string) => {
    const saved: DraftItem[] = [];
    for (const item of items) {
      const response: ApiItem = item.serverId
        ? await api.updateItem(batchId, item.serverId, toItemInput(item), item.svgChanged ? item.svg : undefined)
        : await api.addItem(batchId, toItemInput(item), item.svg);
      saved.push({ ...item, serverId: response.id, svgChanged: false });
    }
    setItems(saved);
  };

  const validate = async () => {
    if (items.length === 0) {
      setNotice('请至少添加一个图标操作。');
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      let currentBatch = batch;
      if (!currentBatch) {
        currentBatch = await api.createBatch(form);
        setBatch(currentBatch);
      }
      await syncItems(currentBatch.id);
      const validated = await api.validateBatch(currentBatch.id);
      setBatch(validated);
      setNotice(validated.validation?.valid ? '校验通过，可以生成本地修改。' : '发现需要修正的问题，请调整后再次校验。');
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : '校验请求失败。');
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!batch) {
      return;
    }
    setBusy(true);
    setNotice(undefined);
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
    if (!batch) {
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const queued = await api.retryBatch(batch.id);
      setBatch(queued);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法重试。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page-shell">
      <header className="page-header">
        <p className="eyebrow">PinK 内部工具</p>
        <h1>图标批量提交</h1>
        <p>提交设计意图、预览 SVG 并完成校验。图标名称、mapping 和 codepoint 仍由图标仓库规则决定。</p>
      </header>

      {catalogError ? <p className="banner error">图标目录加载失败：{catalogError}</p> : <p className="catalog-status">{catalog.length ? `图标目录已加载 ${catalog.length} 个图标。` : '正在加载最新图标目录…'}</p>}
      {notice && <p className="banner">{notice}</p>}
      {batch && <p className={`state-banner state-${batch.state.toLowerCase()}`}>批次状态：<strong>{stateLabel[batch.state]}</strong></p>}

      <section className="panel" aria-labelledby="batch-details-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">第一步</p>
            <h2 id="batch-details-title">批次信息</h2>
          </div>
          {batch && <span className="batch-id">{batch.id}</span>}
        </div>
        <div className="field-grid">
          <div className="field field-wide">
            <label htmlFor="title">批次标题</label>
            <input id="title" value={form.title} disabled={!editable} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          </div>
          <div className="field field-wide">
            <label htmlFor="description">需求说明</label>
            <textarea id="description" value={form.description} disabled={!editable} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </div>
          <div className="field field-wide">
            <label htmlFor="design-url">设计稿链接</label>
            <input id="design-url" type="url" value={form.designUrl} disabled={!editable} onChange={(event) => setForm({ ...form, designUrl: event.target.value })} placeholder="https://" />
          </div>
          <div className="field">
            <label htmlFor="submitter-name">提交人姓名</label>
            <input id="submitter-name" value={form.submitter.name} disabled={!editable} onChange={(event) => setForm({ ...form, submitter: { ...form.submitter, name: event.target.value } })} />
          </div>
          <div className="field">
            <label htmlFor="submitter-email">公司邮箱</label>
            <input id="submitter-email" type="email" value={form.submitter.email} disabled={!editable} onChange={(event) => setForm({ ...form, submitter: { ...form.submitter, email: event.target.value } })} />
          </div>
        </div>
      </section>

      <section className="panel" aria-labelledby="items-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">第二步</p>
            <h2 id="items-title">图标操作</h2>
          </div>
          <button type="button" disabled={!editable || busy} onClick={() => setItems((current) => [...current, createDraftItem()])}>添加操作</button>
        </div>
        {items.length === 0 ? <p className="empty">还没有图标操作。</p> : items.map((item, index) => (
          <ItemEditor
            key={item.clientId}
            item={item}
            index={index}
            icons={catalog}
            disabled={!editable || busy}
            onChange={(patch) => updateItem(item.clientId, patch)}
            onRemove={() => void removeItem(item)}
          />
        ))}
      </section>

      <DiagnosticList title="需要修正的问题" diagnostics={validation?.errors ?? []} tone="error" />
      <DiagnosticList title="需要开发确认的提醒" diagnostics={validation?.warnings ?? []} tone="warning" />

      {batch?.error && <section className="diagnostics error"><h2>处理失败</h2><p><strong>{batch.error.code}</strong> {batch.error.message}</p></section>}
      {batch?.localDiff && (
        <section className="panel result-panel">
          <p className="eyebrow">本地修改已就绪</p>
          <h2>等待阶段 3 创建 Draft PR</h2>
          <p>当前阶段只生成并保存可审阅的本地 diff，不会创建 GitHub 分支或 Pull Request。</p>
          <details>
            <summary>查看技术详情</summary>
            <ul>{batch.localDiff.changedFiles.map((file) => <li key={file}>{file}</li>)}</ul>
          </details>
        </section>
      )}

      <section className="actions" aria-label="批次操作">
        {editable && <button className="primary" type="button" disabled={busy} onClick={() => void validate()}>{busy ? '处理中…' : '校验批次'}</button>}
        {batch?.state === 'READY' && <button className="primary" type="button" disabled={busy} onClick={() => void submit()}>生成本地修改</button>}
        {batch?.state === 'FAILED' && <button className="primary" type="button" disabled={busy} onClick={() => void retry()}>重试</button>}
      </section>
    </main>
  );
}
