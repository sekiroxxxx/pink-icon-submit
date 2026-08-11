import { randomUUID } from 'node:crypto';

import { BatchDatabase } from './database.js';
import { CatalogSnapshotCache } from './catalog-snapshot.js';
import { AppError } from './errors.js';
import { GitRepository } from './git-repository.js';
import { IconBatchCli } from './icon-batch-cli.js';
import { BatchStorage } from './storage.js';
import { canRetryBatch, hasPostPushPullRequestRecoveryEvidence, isActiveBatch, isFinalValidationFailure, isPostPushCheckpoint, isRetryablePostPushInfrastructureFailure, lifecycleSnapshot } from './batch-lifecycle.js';
import type { BatchDetails, BatchExecutionContext, BatchSummary, CatalogPage, CatalogPageInput, CreateBatchInput, CreateItemInput, IconNamePreview, NpmPackageCatalogOptions, StoredItem, TargetRepository } from './types.js';

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

function baseCommitFrom(value: unknown): string | null {
  return isObject(value) && typeof value.baseCommit === 'string' ? value.baseCommit : null;
}

function batchMetadataFrom(value: unknown): Pick<CreateBatchInput, 'title' | 'description' | 'designUrl'> {
  const submitted: Record<string, unknown> = isObject(value) ? value : {};
  const rawDesignUrl = submitted.designUrl;
  let designUrl: string | undefined;
  if (rawDesignUrl !== undefined && rawDesignUrl !== null && !(typeof rawDesignUrl === 'string' && rawDesignUrl.trim() === '')) {
    designUrl = requiredText(rawDesignUrl, 'designUrl', 2_000);
    if (!/^https?:\/\//i.test(designUrl)) {
      throw new AppError('REQUEST_INVALID', 'designUrl must be an HTTP(S) URL.');
    }
    try {
      const parsed = new URL(designUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('unsupported scheme');
      }
    } catch {
      throw new AppError('REQUEST_INVALID', 'designUrl must be an HTTP(S) URL.');
    }
  }
  return {
    title: requiredText(submitted.title, 'title', 200),
    description: requiredText(submitted.description, 'description', 5_000),
    ...(designUrl ? { designUrl } : {}),
  };
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
    catalogOptions: NpmPackageCatalogOptions,
    private readonly targetRepository: TargetRepository,
    private readonly executionContext: BatchExecutionContext = {
      executionMode: 'local',
      pushRepository: null,
      pushBranchPrefix: null,
    },
  ) {
    this.catalog = new CatalogSnapshotCache(repository, iconBatch, catalogOptions);
  }

  get uploadLimit(): number {
    return this.maxUploadBytes;
  }

  async createBatch(input: CreateBatchInput, ownerId?: string): Promise<BatchDetails> {
    const submitted: Record<string, unknown> = isObject(input) ? input : {};
    const submitter = isObject(submitted.submitter) ? submitted.submitter : {};
    const metadata = batchMetadataFrom(submitted);
    const normalized: CreateBatchInput = {
      ...metadata,
      submitter: {
        name: requiredText(submitter.name, 'submitter.name', 100),
        email: requiredText(submitter.email, 'submitter.email', 320),
      },
    };
    if (!/^\S+@\S+\.\S+$/.test(normalized.submitter.email)) {
      throw new AppError('REQUEST_INVALID', 'submitter.email must be a valid email address.');
    }
    const catalogBaseline = await this.catalog.baseline();
    const batch = this.database.createBatch(
      createBatchId(),
      normalized,
      catalogBaseline,
      this.targetRepository,
      this.executionContext,
      ownerId,
      ownerId !== undefined,
    );
    return this.database.getDetails(batch.id);
  }

  async updateBatch(batchId: string, input: Pick<CreateBatchInput, 'title' | 'description' | 'designUrl'>, ownerId?: string): Promise<BatchDetails> {
    this.assertOwner(batchId, ownerId);
    this.assertDraft(batchId, 'BATCH_NOT_EDITABLE', 'edited');
    return this.withBatchLock(batchId, async () => {
      this.assertOwner(batchId, ownerId);
      this.assertDraft(batchId, 'BATCH_NOT_EDITABLE', 'edited');
      const normalized = batchMetadataFrom(input);
      const current = this.database.getBatch(batchId);
      if (current.title === normalized.title
        && current.description === normalized.description
        && current.designUrl === normalized.designUrl) {
        return this.database.getDetails(batchId);
      }
      this.database.updateBatchMetadata(batchId, normalized);
      return this.database.getDetails(batchId);
    });
  }

  async addItem(batchId: string, input: CreateItemInput, svg: Buffer | undefined, ownerId?: string): Promise<StoredItem> {
    this.assertOwner(batchId, ownerId);
    this.assertDraft(batchId, 'BATCH_NOT_EDITABLE', 'edited');
    return this.withBatchLock(batchId, async () => {
      this.assertOwner(batchId, ownerId);
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

  async updateItem(batchId: string, itemId: string, input: CreateItemInput, svg: Buffer | undefined, ownerId?: string): Promise<StoredItem> {
    this.assertOwner(batchId, ownerId);
    this.assertDraft(batchId, 'BATCH_NOT_EDITABLE', 'edited');
    return this.withBatchLock(batchId, async () => {
      this.assertOwner(batchId, ownerId);
      this.assertDraft(batchId, 'BATCH_NOT_EDITABLE', 'edited');
      const existing = this.database.getItem(batchId, itemId);
      const normalized = await this.normalizeItemInput(batchId, input, svg, existing.sourceFile, itemId);
      if (!svg
        && existing.action === normalized.action
        && existing.designName === normalized.designName
        && existing.targetName === normalized.targetName
        && existing.description === normalized.description
        && existing.reason === normalized.reason
        && existing.replacementName === normalized.replacementName) {
        return existing;
      }
      const sourceFile = normalized.action === 'delete'
        ? null
        : svg
          ? await this.saveSvg(batchId, itemId, svg)
          : existing.sourceFile;
      return this.database.updateItem(batchId, itemId, normalized, sourceFile);
    });
  }

  async deleteItem(batchId: string, itemId: string, ownerId?: string): Promise<void> {
    this.assertOwner(batchId, ownerId);
    this.assertDraft(batchId, 'BATCH_NOT_EDITABLE', 'edited');
    return this.withBatchLock(batchId, async () => {
      this.assertOwner(batchId, ownerId);
      this.assertDraft(batchId, 'BATCH_NOT_EDITABLE', 'edited');
      this.database.deleteItem(batchId, itemId);
    });
  }

  async validateBatch(batchId: string, ownerId?: string): Promise<BatchDetails> {
    this.assertOwner(batchId, ownerId);
    this.assertDraft(batchId, 'BATCH_NOT_VALIDATABLE', 'validated');
    return this.withBatchLock(batchId, async () => {
      this.assertOwner(batchId, ownerId);
      this.database.beginValidation(batchId);
      try {
        const stage1Input = await this.prepareStage1Request(batchId);
        const validation = await this.repository.withBaseWorktree(async (worktreePath) => {
          const result = await this.iconBatch.validate(worktreePath, stage1Input.requestPath, stage1Input);
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
    return this.catalog.summary();
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

  submit(batchId: string, confirmRepeatedSubmission = false, ownerId?: string): BatchDetails {
    this.assertOwner(batchId, ownerId);
    const batch = this.database.getBatch(batchId);
    if (batch.state === 'DRAFT') {
      this.assertLocallySubmittable(batchId);
      if (this.database.requiresRepeatedSubmissionConfirmation(batchId) && !confirmRepeatedSubmission) {
        throw new AppError('REPEATED_SUBMISSION_CONFIRMATION_REQUIRED', 'This batch has not changed since its final validation failed. Confirm before submitting it unchanged.', 409);
      }
      this.database.queueJob(batchId);
      return this.database.getDetails(batchId);
    }
    if (batch.state === 'READY' && validationIsValid(batch.validation)) {
      this.database.queueJob(batchId);
      return this.database.getDetails(batchId);
    }
    if (batch.state === 'READY') {
      throw new AppError('BATCH_NOT_READY', 'The legacy READY batch no longer has a successful validation.', 409);
    }
    if (batch.state === 'FAILED') {
      throw new AppError('BATCH_RETRY_REQUIRED', `Batch ${batchId} failed and must use its recovery action.`, 409);
    }
    throw new AppError('BATCH_NOT_SUBMITTABLE', `Batch ${batchId} is ${batch.state}.`, 409);
  }

  returnToEdit(batchId: string, ownerId?: string): BatchDetails {
    this.assertOwner(batchId, ownerId);
    const batch = this.database.getBatch(batchId);
    if (!isFinalValidationFailure(lifecycleSnapshot(batch))) {
      throw new AppError('BATCH_NOT_EDITABLE', `Batch ${batchId} cannot return to editing from its current delivery state.`, 409);
    }
    this.database.returnToDraftForEditing(batchId);
    return this.database.getDetails(batchId);
  }

  retry(batchId: string, ownerId?: string): BatchDetails {
    this.assertOwner(batchId, ownerId);
    const batch = this.database.getBatch(batchId);
    const failureCode = batch.error?.code ?? this.database.getDetails(batchId).job?.error?.code ?? null;
    const retrySnapshot = { ...lifecycleSnapshot(batch), errorCode: failureCode };
    if (batch.state !== 'FAILED') {
      throw new AppError('BATCH_NOT_RETRYABLE', `Batch ${batchId} is ${batch.state}.`, 409);
    }
    if (isFinalValidationFailure(retrySnapshot)) {
      throw new AppError('BATCH_RETURN_TO_EDIT_REQUIRED', 'A final validation failure must be corrected in the editor before delivery can be retried.', 409);
    }
    if (!['NONE', 'COMMIT_PREPARED', 'BRANCH_PUSHED', 'PR_CREATING'].includes(batch.delivery.checkpoint)) {
      throw new AppError('BATCH_NOT_RETRYABLE', `Batch ${batchId} is already handed off.`, 409);
    }
    if (isPostPushCheckpoint(batch.delivery.checkpoint)) {
      if (!isRetryablePostPushInfrastructureFailure(failureCode)) {
        throw new AppError('BATCH_NOT_RETRYABLE', `Batch ${batchId} cannot retry Draft PR creation after ${failureCode ?? 'an unknown failure'}.`, 409);
      }
      if (!hasPostPushPullRequestRecoveryEvidence(retrySnapshot)) {
        throw new AppError('BATCH_NOT_RETRYABLE', `Batch ${batchId} is missing the persisted branch, commit, or base evidence required to recover its Draft PR.`, 409);
      }
    }
    if (!canRetryBatch(retrySnapshot)) {
      throw new AppError('BATCH_NOT_RETRYABLE', `Batch ${batchId} cannot be retried from its current delivery state.`, 409);
    }
    this.database.queueJob(batchId);
    return this.database.getDetails(batchId);
  }

  getBatch(batchId: string, ownerId?: string): BatchDetails {
    return ownerId === undefined ? this.database.getDetails(batchId) : this.database.getDetailsForOwner(batchId, ownerId);
  }

  listBatches(limit: number, ownerId?: string): BatchSummary[] {
    return this.database.listBatchSummaries(limit, ownerId);
  }

  getActiveBatch(ownerId: string): BatchDetails | null {
    return this.database.getActiveBatchForOwner(ownerId);
  }

  async cloneBatch(batchId: string, ownerId?: string): Promise<BatchDetails> {
    const source = this.getBatch(batchId, ownerId);
    if (isActiveBatch(lifecycleSnapshot(source))) {
      throw new AppError('BATCH_NOT_CLONEABLE', `Batch ${batchId} is still active and cannot be cloned.`, 409);
    }
    if (!source.catalogBaseline || !source.targetRepository) {
      throw new AppError('BATCH_PROTOCOL_CONTEXT_MISSING', `Batch ${batchId} predates the Stage 1 v2 protocol and must be recreated manually.`, 409);
    }

    const clonedId = createBatchId();
    const cloneOwnerId = ownerId ?? this.database.getBatchOwnerId(source.id);
    const clonedItems = source.items.map((item) => {
      const id = createItemId();
      return {
        id,
        input: {
          action: item.action,
          ...(item.designName ? { designName: item.designName } : {}),
          ...(item.targetName ? { targetName: item.targetName } : {}),
          ...(item.description ? { description: item.description } : {}),
          ...(item.reason ? { reason: item.reason } : {}),
          ...(item.replacementName ? { replacementName: item.replacementName } : {}),
        },
        sourceFile: item.sourceFile ? `uploads/${id}.svg` : null,
        originalSourceFile: item.sourceFile,
      };
    });
    const staged = await this.storage.stageCloneSvgs(source.id, clonedItems.flatMap((item) => item.originalSourceFile
      ? [{ sourceFile: item.originalSourceFile, targetItemId: item.id }]
      : []));
    try {
      this.database.createClonedBatch(
        clonedId,
        {
          title: source.title,
          description: source.description,
          ...(source.designUrl ? { designUrl: source.designUrl } : {}),
          submitter: source.submitter,
        },
        source.catalogBaseline,
        source.targetRepository,
        {
          executionMode: source.executionMode ?? this.executionContext.executionMode,
          pushRepository: source.pushRepository,
          pushBranchPrefix: source.pushBranchPrefix,
        },
        cloneOwnerId,
        clonedItems.map(({ id, input, sourceFile }) => ({ id, input, sourceFile })),
        ownerId !== undefined,
      );
      await this.storage.publishStagedClone(staged, clonedId);
    } catch (error) {
      await this.discardFailedClone(clonedId, cloneOwnerId, staged, error);
      throw error;
    }
    return this.database.getDetails(clonedId);
  }

  private async discardFailedClone(clonedId: string, ownerId: string, staged: { directory: string }, originalError: unknown): Promise<void> {
    const cleanupErrors: unknown[] = [];
    try {
      this.database.discardUnpublishedClone(clonedId, ownerId);
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'BATCH_NOT_FOUND')) cleanupErrors.push(error);
    }
    for (const cleanup of [
      () => this.storage.discardCloneStaging(staged),
      () => this.storage.discardClonedBatch(clonedId),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([originalError, ...cleanupErrors], `Clone ${clonedId} failed and its owned resources could not be fully cleaned up.`);
    }
  }

  private assertLocallySubmittable(batchId: string): void {
    const details = this.database.getDetails(batchId);
    if (details.items.length === 0) {
      throw new AppError('BATCH_EMPTY', 'A batch needs at least one item before delivery.', 409);
    }
    if (details.items.length > maximumBatchItems) {
      throw new AppError('BATCH_ITEM_LIMIT', `A batch may contain at most ${maximumBatchItems} items.`, 409);
    }
    for (const item of details.items) {
      const invalid = item.action === 'add'
        ? !item.designName || !item.description || !item.sourceFile
        : item.action === 'replace'
          ? !item.targetName || !item.sourceFile
          : !item.targetName || !item.reason || item.sourceFile !== null;
      if (invalid) {
        throw new AppError('BATCH_ITEM_INVALID', `Batch ${batchId} has an incomplete ${item.action} item.`, 409);
      }
    }
  }

  async writeRequest(batchId: string): Promise<string> {
    return (await this.prepareStage1Request(batchId)).requestPath;
  }

  async finalValidate(
    batchId: string,
    worktreePath: string,
    stage1Input: { requestPath: string; catalogTarball: string; targetRepository: string },
  ): Promise<void> {
    const result = await this.iconBatch.validate(worktreePath, stage1Input.requestPath, stage1Input);
    const validation = result.payload;
    this.database.recordFinalValidation(batchId, validation, baseCommitFrom(validation));
    if (!validationIsValid(validation)) {
      throw new AppError('FINAL_VALIDATION_FAILED', 'The batch failed final Stage 1 validation before delivery.', 409, validation);
    }
  }

  async prepareStage1Request(batchId: string): Promise<{ requestPath: string; catalogTarball: string; targetRepository: string }> {
    const details = this.database.getDetails(batchId);
    if (details.items.length === 0) {
      throw new AppError('BATCH_EMPTY', 'A batch needs at least one item before validation.', 409);
    }
    if (details.items.length > maximumBatchItems) {
      throw new AppError('BATCH_ITEM_LIMIT', `A batch may contain at most ${maximumBatchItems} items.`, 409);
    }
    if (!details.catalogBaseline || !details.targetRepository) {
      throw new AppError('BATCH_PROTOCOL_CONTEXT_MISSING', `Batch ${batchId} predates the Stage 1 v2 protocol and must be recreated.`, 409);
    }
    return {
      requestPath: await this.storage.writeRequest(details, details.items),
      catalogTarball: await this.catalog.tarballPath(details.catalogBaseline),
      targetRepository: details.targetRepository.repository,
    };
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

  private assertOwner(batchId: string, ownerId: string | undefined): void {
    if (ownerId !== undefined) {
      this.database.getBatchForOwner(batchId, ownerId);
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
