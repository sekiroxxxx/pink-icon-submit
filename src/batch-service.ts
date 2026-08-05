import { randomUUID } from 'node:crypto';

import { BatchDatabase } from './database.js';
import { CatalogSnapshotCache } from './catalog-snapshot.js';
import { AppError } from './errors.js';
import { GitRepository } from './git-repository.js';
import { IconBatchCli } from './icon-batch-cli.js';
import { BatchStorage } from './storage.js';
import type { BatchDetails, CatalogPage, CatalogPageInput, CreateBatchInput, CreateItemInput, IconNamePreview, StoredItem } from './types.js';

const maximumBatchItems = 100;

function requiredText(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('REQUEST_INVALID', `${field} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    throw new AppError('REQUEST_INVALID', `${field} must be at most ${maximumLength} characters.`);
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maximumLength: number): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return requiredText(value, field, maximumLength);
}

function requiredIconName(value: unknown, field: string): string {
  const name = requiredText(value, field, 100);
  if (!/^[^\s/\\]+$/.test(name)) {
    throw new AppError('REQUEST_INVALID', `${field} must not contain whitespace or path separators.`);
  }
  return name;
}

function optionalIconName(value: unknown, field: string): string | undefined {
  const name = optionalText(value, field, 100);
  if (name && !/^[^\s/\\]+$/.test(name)) {
    throw new AppError('REQUEST_INVALID', `${field} must not contain whitespace or path separators.`);
  }
  return name;
}

function createBatchId(): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `ICON-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function createItemId(): string {
  return `item-${randomUUID().slice(0, 12)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validationIsValid(value: unknown): boolean {
  return isObject(value) && value.valid === true;
}

function validationHasWarnings(value: unknown): boolean {
  return isObject(value) && Array.isArray(value.warnings) && value.warnings.length > 0;
}

function baseCommitFrom(value: unknown): string | null {
  return isObject(value) && typeof value.baseCommit === 'string' ? value.baseCommit : null;
}

export class BatchService {
  private readonly batchLocks = new Map<string, Promise<void>>();
  private readonly catalog: CatalogSnapshotCache;

  constructor(
    readonly database: BatchDatabase,
    readonly storage: BatchStorage,
    readonly repository: GitRepository,
    readonly iconBatch: IconBatchCli,
    private readonly maxUploadBytes: number,
  ) {
    this.catalog = new CatalogSnapshotCache(repository, iconBatch);
  }

  get uploadLimit(): number {
    return this.maxUploadBytes;
  }

  createBatch(input: CreateBatchInput): BatchDetails {
    const submitted: Record<string, unknown> = isObject(input) ? input : {};
    const submitter = isObject(submitted.submitter) ? submitted.submitter : {};
    const normalized: CreateBatchInput = {
      title: requiredText(submitted.title, 'title', 200),
      description: requiredText(submitted.description, 'description', 5_000),
      designUrl: requiredText(submitted.designUrl, 'designUrl', 2_000),
      submitter: {
        name: requiredText(submitter.name, 'submitter.name', 100),
        email: requiredText(submitter.email, 'submitter.email', 320),
      },
    };
    if (!/^\S+@\S+\.\S+$/.test(normalized.submitter.email)) {
      throw new AppError('REQUEST_INVALID', 'submitter.email must be a valid email address.');
    }
    try {
      const designUrl = new URL(normalized.designUrl);
      if (!['http:', 'https:'].includes(designUrl.protocol)) {
        throw new Error('unsupported scheme');
      }
    } catch {
      throw new AppError('REQUEST_INVALID', 'designUrl must be an HTTP(S) URL.');
    }
    const batch = this.database.createBatch(createBatchId(), normalized);
    return this.database.getDetails(batch.id);
  }

  async addItem(batchId: string, input: CreateItemInput, svg: Buffer | undefined): Promise<StoredItem> {
    this.assertDraft(batchId, 'BATCH_NOT_EDITABLE', 'edited');
    return this.withBatchLock(batchId, async () => {
      this.assertDraft(batchId, 'BATCH_NOT_EDITABLE', 'edited');
      if (this.database.countItems(batchId) >= maximumBatchItems) {
        throw new AppError('BATCH_ITEM_LIMIT', `A batch may contain at most ${maximumBatchItems} items.`, 409);
      }
      const normalized = await this.normalizeItemInput(batchId, input, svg);
      const itemId = createItemId();
      const sourceFile = svg ? await this.saveSvg(batchId, itemId, svg) : null;
      return this.database.insertItem(batchId, itemId, normalized, sourceFile);
    });
  }

  async updateItem(batchId: string, itemId: string, input: CreateItemInput, svg: Buffer | undefined): Promise<StoredItem> {
    this.assertDraft(batchId, 'BATCH_NOT_EDITABLE', 'edited');
    return this.withBatchLock(batchId, async () => {
      this.assertDraft(batchId, 'BATCH_NOT_EDITABLE', 'edited');
      const existing = this.database.getItem(batchId, itemId);
      const normalized = await this.normalizeItemInput(batchId, input, svg, existing.sourceFile, itemId);
      const sourceFile = normalized.action === 'delete'
        ? null
        : svg
          ? await this.saveSvg(batchId, itemId, svg)
          : existing.sourceFile;
      return this.database.updateItem(batchId, itemId, normalized, sourceFile);
    });
  }

  async deleteItem(batchId: string, itemId: string): Promise<void> {
    this.assertDraft(batchId, 'BATCH_NOT_EDITABLE', 'edited');
    return this.withBatchLock(batchId, async () => {
      this.assertDraft(batchId, 'BATCH_NOT_EDITABLE', 'edited');
      this.database.deleteItem(batchId, itemId);
    });
  }

  async validateBatch(batchId: string): Promise<BatchDetails> {
    this.assertDraft(batchId, 'BATCH_NOT_VALIDATABLE', 'validated');
    return this.withBatchLock(batchId, async () => {
      this.database.beginValidation(batchId);
      try {
        const requestPath = await this.writeRequest(batchId);
        const validation = await this.repository.withLatestWorktree(async (worktreePath) => {
          const result = await this.iconBatch.validate(worktreePath, requestPath);
          return result.payload;
        });
        this.database.completeValidation(batchId, validation, baseCommitFrom(validation), validationIsValid(validation));
        return this.database.getDetails(batchId);
      } catch (error) {
        this.database.abortValidation(batchId);
        throw error;
      }
    });
  }

  async getCatalog(): Promise<Record<string, unknown>> {
    return this.repository.withLatestWorktree(async (worktreePath) => {
      const result = await this.iconBatch.catalog(worktreePath);
      return result.payload;
    });
  }

  getCatalogPage(input: CatalogPageInput): Promise<CatalogPage> {
    return this.catalog.page(input);
  }

  previewName(input: string): Promise<IconNamePreview> {
    return this.catalog.previewName(requiredIconName(input, 'name'));
  }

  async getCatalogIconSvg(name: string): Promise<Buffer> {
    return this.catalog.svg(requiredIconName(name, 'icon name'));
  }

  submit(batchId: string): BatchDetails {
    const batch = this.database.getBatch(batchId);
    if (!validationIsValid(batch.validation)) {
      throw new AppError('BATCH_NOT_READY', 'Validate the batch successfully before submission.', 409);
    }
    if (!['READY', 'FAILED'].includes(batch.state)) {
      throw new AppError('BATCH_NOT_SUBMITTABLE', `Batch ${batchId} is ${batch.state}.`, 409);
    }
    if (validationHasWarnings(batch.validation) && !batch.warningsAcknowledged) {
      throw new AppError('BATCH_WARNINGS_UNACKNOWLEDGED', 'Acknowledge all validation warnings before submission.', 409);
    }
    this.database.queueJob(batchId);
    this.catalog.invalidate();
    return this.database.getDetails(batchId);
  }

  retry(batchId: string): BatchDetails {
    const batch = this.database.getBatch(batchId);
    if (batch.state !== 'FAILED') {
      throw new AppError('BATCH_NOT_RETRYABLE', `Batch ${batchId} is ${batch.state}.`, 409);
    }
    if (!validationIsValid(batch.validation)) {
      throw new AppError('BATCH_NOT_READY', 'The batch requires a successful validation before retry.', 409);
    }
    if (validationHasWarnings(batch.validation) && !batch.warningsAcknowledged) {
      throw new AppError('BATCH_WARNINGS_UNACKNOWLEDGED', 'Acknowledge all validation warnings before retrying.', 409);
    }
    this.database.queueJob(batchId);
    return this.database.getDetails(batchId);
  }

  getBatch(batchId: string): BatchDetails {
    return this.database.getDetails(batchId);
  }

  acknowledgeWarnings(batchId: string): BatchDetails {
    this.database.acknowledgeWarnings(batchId);
    return this.database.getDetails(batchId);
  }

  async writeRequest(batchId: string): Promise<string> {
    const details = this.database.getDetails(batchId);
    if (details.items.length === 0) {
      throw new AppError('BATCH_EMPTY', 'A batch needs at least one item before validation.', 409);
    }
    if (details.items.length > maximumBatchItems) {
      throw new AppError('BATCH_ITEM_LIMIT', `A batch may contain at most ${maximumBatchItems} items.`, 409);
    }
    return this.storage.writeRequest(details, details.items);
  }

  private async saveSvg(batchId: string, itemId: string, svg: Buffer): Promise<string> {
    if (svg.length === 0) {
      throw new AppError('UPLOAD_EMPTY', 'SVG upload is empty.');
    }
    if (svg.length > this.maxUploadBytes) {
      throw new AppError('UPLOAD_TOO_LARGE', `SVG upload exceeds ${this.maxUploadBytes} bytes.`, 413);
    }
    return this.storage.saveSvg(batchId, itemId, svg);
  }

  private assertDraft(batchId: string, code: string, action: string): void {
    const batch = this.database.getBatch(batchId);
    if (batch.state !== 'DRAFT') {
      throw new AppError(code, `Batch ${batchId} is ${batch.state} and cannot be ${action}.`, 409);
    }
  }

  private async withBatchLock<T>(batchId: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.batchLocks.get(batchId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    this.batchLocks.set(batchId, current);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (this.batchLocks.get(batchId) === current) {
        this.batchLocks.delete(batchId);
      }
    }
  }

  private async normalizeItemInput(batchId: string, input: CreateItemInput, svg: Buffer | undefined, existingSourceFile?: string | null, itemId?: string): Promise<CreateItemInput> {
    if (!isObject(input)) {
      throw new AppError('ITEM_INVALID', 'item must be an object.');
    }
    const submitted: Record<string, unknown> = input;
    const action = submitted.action;
    if (action !== 'add' && action !== 'replace' && action !== 'delete') {
      throw new AppError('ITEM_INVALID', 'action must be add, replace, or delete.');
    }
    if (action === 'add') {
      const designName = requiredIconName(submitted.designName, 'designName');
      const description = requiredText(submitted.description, 'description', 1_000);
      if (!svg && !existingSourceFile) {
        throw new AppError('UPLOAD_REQUIRED', 'add requires an SVG upload.');
      }
      return { action: 'add', designName, description };
    }
    if (action === 'replace') {
      const targetName = await this.catalog.canonicalName(requiredIconName(submitted.targetName, 'targetName'));
      if (!svg && !existingSourceFile) {
        throw new AppError('UPLOAD_REQUIRED', 'replace requires an SVG upload.');
      }
      const description = optionalText(submitted.description, 'description', 1_000);
      return { action: 'replace', targetName, ...(description ? { description } : {}) };
    }
    const targetName = await this.catalog.canonicalName(requiredIconName(submitted.targetName, 'targetName'));
    const reason = requiredText(submitted.reason, 'reason', 1_000);
    const requestedReplacement = optionalIconName(submitted.replacementName, 'replacementName');
    const replacementName = requestedReplacement ? await this.catalog.canonicalName(requestedReplacement) : undefined;
    if (replacementName === targetName) {
      throw new AppError('ITEM_INVALID', 'replacementName must be a different existing icon from targetName.');
    }
    if (replacementName && this.database.getItems(batchId).some((item) => item.id !== itemId && item.action === 'delete' && item.targetName === replacementName)) {
      throw new AppError('ITEM_INVALID', 'replacementName cannot be another icon being deleted in this batch.');
    }
    if (svg) {
      throw new AppError('UPLOAD_NOT_ALLOWED', 'delete must not include an SVG upload.');
    }
    return { action: 'delete', targetName, reason, ...(replacementName ? { replacementName } : {}) };
  }
}
