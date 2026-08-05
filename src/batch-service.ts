import { randomUUID } from 'node:crypto';

import { BatchDatabase } from './database.js';
import { AppError } from './errors.js';
import { GitRepository } from './git-repository.js';
import { IconBatchCli } from './icon-batch-cli.js';
import { BatchStorage } from './storage.js';
import type { BatchDetails, CreateBatchInput, CreateItemInput, StoredItem } from './types.js';

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('REQUEST_INVALID', `${field} is required.`);
  }
  return value.trim();
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

function baseCommitFrom(value: unknown): string | null {
  return isObject(value) && typeof value.baseCommit === 'string' ? value.baseCommit : null;
}

export class BatchService {
  constructor(
    readonly database: BatchDatabase,
    readonly storage: BatchStorage,
    readonly repository: GitRepository,
    readonly iconBatch: IconBatchCli,
    private readonly maxUploadBytes: number,
  ) {}

  get uploadLimit(): number {
    return this.maxUploadBytes;
  }

  createBatch(input: CreateBatchInput): BatchDetails {
    const normalized: CreateBatchInput = {
      title: requiredText(input.title, 'title'),
      description: requiredText(input.description, 'description'),
      designUrl: requiredText(input.designUrl, 'designUrl'),
      submitter: {
        name: requiredText(input.submitter?.name, 'submitter.name'),
        email: requiredText(input.submitter?.email, 'submitter.email'),
      },
    };
    try {
      new URL(normalized.designUrl);
    } catch {
      throw new AppError('REQUEST_INVALID', 'designUrl must be an absolute URL.');
    }
    const batch = this.database.createBatch(createBatchId(), normalized);
    return this.database.getDetails(batch.id);
  }

  async addItem(batchId: string, input: CreateItemInput, svg: Buffer | undefined): Promise<StoredItem> {
    const batch = this.database.getBatch(batchId);
    if (batch.state !== 'DRAFT') {
      throw new AppError('BATCH_NOT_EDITABLE', `Batch ${batchId} is ${batch.state} and cannot be edited.`, 409);
    }
    this.validateItemInput(input, svg);
    const itemId = createItemId();
    const sourceFile = svg ? await this.saveSvg(batchId, itemId, svg) : null;
    return this.database.insertItem(batchId, itemId, input, sourceFile);
  }

  async validateBatch(batchId: string): Promise<BatchDetails> {
    const requestPath = await this.writeRequest(batchId);
    const validation = await this.repository.withLatestWorktree(async (worktreePath) => {
      const result = await this.iconBatch.validate(worktreePath, requestPath);
      return result.payload;
    });
    this.database.saveValidation(batchId, validation, baseCommitFrom(validation), validationIsValid(validation));
    return this.database.getDetails(batchId);
  }

  async getCatalog(): Promise<Record<string, unknown>> {
    return this.repository.withLatestWorktree(async (worktreePath) => {
      const result = await this.iconBatch.catalog(worktreePath);
      return result.payload;
    });
  }

  submit(batchId: string): BatchDetails {
    const batch = this.database.getBatch(batchId);
    if (!validationIsValid(batch.validation)) {
      throw new AppError('BATCH_NOT_READY', 'Validate the batch successfully before submission.', 409);
    }
    if (!['READY', 'FAILED'].includes(batch.state)) {
      throw new AppError('BATCH_NOT_SUBMITTABLE', `Batch ${batchId} is ${batch.state}.`, 409);
    }
    this.database.queueJob(batchId);
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
    this.database.queueJob(batchId);
    return this.database.getDetails(batchId);
  }

  getBatch(batchId: string): BatchDetails {
    return this.database.getDetails(batchId);
  }

  async writeRequest(batchId: string): Promise<string> {
    const details = this.database.getDetails(batchId);
    if (details.items.length === 0) {
      throw new AppError('BATCH_EMPTY', 'A batch needs at least one item before validation.', 409);
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

  private validateItemInput(input: CreateItemInput, svg: Buffer | undefined): void {
    if (!['add', 'replace', 'delete'].includes(input.action)) {
      throw new AppError('ITEM_INVALID', 'action must be add, replace, or delete.');
    }
    if (input.action === 'add') {
      requiredText(input.designName, 'designName');
      requiredText(input.description, 'description');
      if (!svg) {
        throw new AppError('UPLOAD_REQUIRED', 'add requires an SVG upload.');
      }
      return;
    }
    if (input.action === 'replace') {
      requiredText(input.targetName, 'targetName');
      if (!svg) {
        throw new AppError('UPLOAD_REQUIRED', 'replace requires an SVG upload.');
      }
      return;
    }
    requiredText(input.targetName, 'targetName');
    requiredText(input.reason, 'reason');
    if (svg) {
      throw new AppError('UPLOAD_NOT_ALLOWED', 'delete must not include an SVG upload.');
    }
  }
}
