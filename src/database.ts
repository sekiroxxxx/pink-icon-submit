import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { AppError, sanitizeDiagnosticText } from './errors.js';
import { isActiveBatch, lifecycleSnapshot, userStatusForBatch } from './batch-lifecycle.js';
import type {
  BatchExecutionContext,
  BatchDetails,
  BatchSummary,
  BatchState,
  AuthenticatedUser,
  CatalogBaseline,
  CreateBatchInput,
  CreateItemInput,
  DeliveryCheckpoint,
  ExecutionMode,
  JobState,
  JobFailure,
  RemoteDeliveryState,
  StoredBatch,
  StoredItem,
  StoredJob,
  TargetRepository,
  WorkerFailureDiagnostic,
} from './types.js';

export const legacyBootstrapUserId = 'legacy-bootstrap';

export interface UserCredentialRecord extends AuthenticatedUser {
  passwordHash: string;
}

interface SessionInput {
  tokenHash: string;
  userId: string;
  expiresAt: string;
}

interface BatchRow {
  id: string;
  title: string;
  description: string;
  design_url: string;
  submitter_name: string;
  submitter_email: string;
  catalog_baseline_json: string | null;
  target_repository_json: string | null;
  execution_mode: ExecutionMode | null;
  push_repository: string | null;
  push_branch_prefix: string | null;
  delivery_checkpoint: DeliveryCheckpoint;
  delivery_branch: string | null;
  delivery_commit_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  pr_is_draft: number | null;
  pr_created_at: string | null;
  handoff_at: string | null;
  state: BatchState;
  validation_json: string | null;
  warning_ack_request_sha256: string | null;
  plan_json: string | null;
  base_commit: string | null;
  local_diff_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
}

interface ItemRow {
  id: string;
  batch_id: string;
  action: StoredItem['action'];
  design_name: string | null;
  target_name: string | null;
  description: string | null;
  reason: string | null;
  replacement_name: string | null;
  source_file: string | null;
  created_at: string;
}

interface BatchSummaryRow {
  id: string;
  title: string;
  state: BatchState;
  execution_mode: ExecutionMode | null;
  delivery_checkpoint: DeliveryCheckpoint;
  delivery_branch: string | null;
  delivery_commit_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  pr_is_draft: number | null;
  pr_created_at: string | null;
  validation_json: string | null;
  base_commit: string | null;
  error_code: string | null;
  created_at: string;
  item_count: number;
  add_count: number;
  replace_count: number;
  delete_count: number;
}

interface JobRow {
  batch_id: string;
  state: JobState;
  attempt: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface JobFailureRow {
  id: number;
  batch_id: string;
  attempt: number;
  error_code: string;
  error_message: string;
  operation: string | null;
  command_text: string | null;
  exit_code: number | null;
  stderr_summary: string | null;
  created_at: string;
}

interface PullRequestRecord {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  createdAt: string | null;
}

function parseJson(value: string | null): unknown | null {
  return value === null ? null : JSON.parse(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function storedCatalogBaseline(value: string | null): CatalogBaseline | null {
  const parsed = parseJson(value);
  if (parsed === null) {
    return null;
  }
  if (!isObject(parsed)
    || typeof parsed.packageName !== 'string'
    || typeof parsed.requestedTag !== 'string'
    || typeof parsed.version !== 'string'
    || typeof parsed.integrity !== 'string'
    || typeof parsed.sourceRepository !== 'string'
    || typeof parsed.sourceCommit !== 'string') {
    throw new Error('Stored catalog baseline is invalid.');
  }
  return {
    packageName: parsed.packageName,
    requestedTag: parsed.requestedTag,
    version: parsed.version,
    integrity: parsed.integrity,
    sourceRepository: parsed.sourceRepository,
    sourceCommit: parsed.sourceCommit,
  };
}

function storedTargetRepository(value: string | null): TargetRepository | null {
  const parsed = parseJson(value);
  if (parsed === null) {
    return null;
  }
  if (!isObject(parsed) || typeof parsed.repository !== 'string' || parsed.branch !== 'main') {
    throw new Error('Stored target repository is invalid.');
  }
  return { repository: parsed.repository, branch: 'main' };
}

function storedExecutionMode(value: string | null): ExecutionMode | null {
  if (value === null) {
    return null;
  }
  if (value !== 'local' && value !== 'remote') {
    throw new Error('Stored execution mode is invalid.');
  }
  return value;
}

function storedDeliveryCheckpoint(value: string): DeliveryCheckpoint {
  if (value === 'NONE' || value === 'COMMIT_PREPARED' || value === 'BRANCH_PUSHED' || value === 'PR_CREATING' || value === 'PR_CREATED') {
    return value;
  }
  throw new Error('Stored delivery checkpoint is invalid.');
}

function storedRemoteDelivery(row: BatchRow): RemoteDeliveryState {
  const hasPullRequest = row.pr_number !== null || row.pr_url !== null || row.pr_state !== null || row.pr_is_draft !== null || row.pr_created_at !== null;
  if (hasPullRequest && (row.pr_number === null || row.pr_url === null || row.pr_state === null || row.pr_is_draft === null)) {
    throw new Error('Stored pull request delivery state is invalid.');
  }
  if (row.pr_is_draft !== null && row.pr_is_draft !== 0 && row.pr_is_draft !== 1) {
    throw new Error('Stored pull request draft state is invalid.');
  }
  return {
    checkpoint: storedDeliveryCheckpoint(row.delivery_checkpoint),
    branch: row.delivery_branch,
    commitSha: row.delivery_commit_sha,
    pullRequest: hasPullRequest
      ? {
        number: row.pr_number!,
        url: row.pr_url!,
        state: row.pr_state!,
        isDraft: row.pr_is_draft === 1,
        createdAt: row.pr_created_at,
      }
      : null,
    handoffAt: row.handoff_at,
  };
}

function toBatch(row: BatchRow): StoredBatch {
  const validation = parseJson(row.validation_json);
  const requestSha256 = validationRequestSha256(validation);
  const delivery = storedRemoteDelivery(row);
  const error = row.error_code && row.error_message ? { code: row.error_code, message: row.error_message } : null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    ...(row.design_url ? { designUrl: row.design_url } : {}),
    submitter: { name: row.submitter_name, email: row.submitter_email },
    catalogBaseline: storedCatalogBaseline(row.catalog_baseline_json),
    targetRepository: storedTargetRepository(row.target_repository_json),
    executionMode: storedExecutionMode(row.execution_mode),
    pushRepository: row.push_repository,
    pushBranchPrefix: row.push_branch_prefix,
    delivery,
    state: row.state,
    validation,
    warningsAcknowledged: requestSha256 !== null && row.warning_ack_request_sha256 === requestSha256,
    plan: parseJson(row.plan_json),
    baseCommit: row.base_commit,
    localDiff: parseJson(row.local_diff_json),
    error,
    userStatus: userStatusForBatch({
      state: row.state,
      executionMode: storedExecutionMode(row.execution_mode),
      baseCommit: row.base_commit,
      validation,
      errorCode: error?.code ?? null,
      delivery,
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBatchSummary(row: BatchSummaryRow): BatchSummary {
  const validation = parseJson(row.validation_json);
  return {
    id: row.id,
    title: row.title,
    userStatus: userStatusForBatch({
      state: row.state,
      executionMode: storedExecutionMode(row.execution_mode),
      baseCommit: row.base_commit,
      validation,
      errorCode: row.error_code,
      delivery: {
        checkpoint: storedDeliveryCheckpoint(row.delivery_checkpoint),
        branch: row.delivery_branch,
        commitSha: row.delivery_commit_sha,
        pullRequest: row.pr_number === null ? null : {
          number: row.pr_number,
          url: row.pr_url ?? '',
          state: row.pr_state ?? '',
          isDraft: row.pr_is_draft === 1,
          createdAt: row.pr_created_at,
        },
      },
    }),
    createdAt: row.created_at,
    itemCounts: {
      total: row.item_count,
      add: row.add_count,
      replace: row.replace_count,
      delete: row.delete_count,
    },
  };
}

function validationRequestSha256(validation: unknown): string | null {
  return isObject(validation) && typeof validation.requestSha256 === 'string' ? validation.requestSha256 : null;
}

function toItem(row: ItemRow): StoredItem {
  return {
    id: row.id,
    batchId: row.batch_id,
    action: row.action,
    designName: row.design_name ?? undefined,
    targetName: row.target_name ?? undefined,
    description: row.description ?? undefined,
    reason: row.reason ?? undefined,
    replacementName: row.replacement_name ?? undefined,
    sourceFile: row.source_file,
    createdAt: row.created_at,
  };
}

function toJob(row: JobRow): StoredJob {
  return {
    batchId: row.batch_id,
    state: row.state,
    attempt: row.attempt,
    error: row.error_code && row.error_message ? { code: row.error_code, message: row.error_message } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toJobFailure(row: JobFailureRow): JobFailure {
  return {
    id: row.id,
    batchId: row.batch_id,
    attempt: row.attempt,
    code: row.error_code,
    message: row.error_message,
    ...(row.operation ? { operation: row.operation } : {}),
    ...(row.command_text ? { command: row.command_text } : {}),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    ...(row.stderr_summary ? { stderr: row.stderr_summary } : {}),
    createdAt: row.created_at,
  };
}

function sanitizedFailureDiagnostic(diagnostic: WorkerFailureDiagnostic | undefined): WorkerFailureDiagnostic | undefined {
  if (!diagnostic) {
    return undefined;
  }
  const operation = typeof diagnostic.operation === 'string'
    ? sanitizeDiagnosticText(diagnostic.operation, 120)
    : undefined;
  const command = typeof diagnostic.command === 'string'
    ? sanitizeDiagnosticText(diagnostic.command, 1_000)
    : undefined;
  const exitCode = typeof diagnostic.exitCode === 'number' && Number.isInteger(diagnostic.exitCode)
    ? diagnostic.exitCode
    : undefined;
  const stderr = typeof diagnostic.stderr === 'string'
    ? sanitizeDiagnosticText(diagnostic.stderr)
    : undefined;
  return operation || command || exitCode !== undefined || stderr
    ? { operation, command, exitCode, stderr }
    : undefined;
}

function now(): string {
  return new Date().toISOString();
}

export class BatchDatabase {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  createUser(input: { id: string; username: string; passwordHash: string }): AuthenticatedUser {
    this.db.prepare(`
      INSERT INTO users (id, username, password_hash, created_at)
      VALUES (?, ?, ?, ?)
    `).run(input.id, input.username, input.passwordHash, now());
    return { id: input.id, username: input.username };
  }

  findUserByUsername(username: string): UserCredentialRecord | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) as UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  updateUserPasswordHash(userId: string, passwordHash: string): void {
    const result = this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
    if (result.changes !== 1) {
      throw new AppError('USER_NOT_FOUND', 'Bootstrap user no longer exists.', 404);
    }
  }

  createSession(input: SessionInput): void {
    const create = this.db.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
      this.db.prepare(`
        INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(input.tokenHash, input.userId, input.expiresAt, now());
    });
    create();
  }

  findSessionUser(tokenHash: string, currentTime: string): AuthenticatedUser | undefined {
    const row = this.db.prepare(`
      SELECT users.id, users.username
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(tokenHash, currentTime) as Pick<UserRow, 'id' | 'username'> | undefined;
    return row ? { id: row.id, username: row.username } : undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  createBatch(
    id: string,
    input: CreateBatchInput,
    catalogBaseline: CatalogBaseline,
    targetRepository: TargetRepository,
    executionContext: BatchExecutionContext,
    ownerId = legacyBootstrapUserId,
    enforceSingleActiveOwner = false,
  ): StoredBatch {
    const create = this.db.transaction(() => {
      if (enforceSingleActiveOwner) this.assertNoActiveBatchForOwner(ownerId);
      const timestamp = now();
      this.db.prepare(`
        INSERT INTO batches (
          id, owner_id, title, description, design_url, submitter_name, submitter_email,
          catalog_baseline_json, target_repository_json, execution_mode, push_repository, push_branch_prefix,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
      `).run(
        id,
        ownerId,
        input.title,
        input.description,
        input.designUrl ?? '',
        input.submitter.name,
        input.submitter.email,
        JSON.stringify(catalogBaseline),
        JSON.stringify(targetRepository),
        executionContext.executionMode,
        executionContext.pushRepository,
        executionContext.pushBranchPrefix,
        timestamp,
        timestamp,
      );
    });
    create();
    return this.getBatch(id);
  }

  updateBatchMetadata(batchId: string, input: Pick<CreateBatchInput, 'title' | 'description' | 'designUrl'>): StoredBatch {
    const update = this.db.transaction(() => {
      this.requireDraftBatch(batchId);
      const timestamp = this.nextContentRevision(batchId);
      const result = this.db.prepare(`
        UPDATE batches
        SET title = ?, description = ?, design_url = ?
        WHERE id = ? AND state = 'DRAFT'
      `).run(input.title, input.description, input.designUrl ?? '', batchId);
      if (result.changes !== 1) {
        throw new AppError('BATCH_NOT_EDITABLE', `Batch ${batchId} is no longer editable.`, 409);
      }
      this.clearValidationAfterDraftContentChange(batchId, timestamp);
      return this.getBatch(batchId);
    });
    return update();
  }

  insertItem(batchId: string, id: string, input: CreateItemInput, sourceFile: string | null): StoredItem {
    const insert = this.db.transaction(() => {
      const batch = this.db.prepare('SELECT state FROM batches WHERE id = ?').get(batchId) as Pick<BatchRow, 'state'> | undefined;
      if (!batch) {
        throw new AppError('BATCH_NOT_FOUND', `Unknown batch: ${batchId}`, 404);
      }
      if (batch.state !== 'DRAFT') {
        throw new AppError('BATCH_NOT_EDITABLE', `Batch ${batchId} is ${batch.state} and cannot be edited.`, 409);
      }

      const timestamp = this.nextContentRevision(batchId);
      this.db.prepare(`
        INSERT INTO items (
          id, batch_id, action, design_name, target_name, description, reason, replacement_name, source_file, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        batchId,
        input.action,
        input.designName ?? null,
        input.targetName ?? null,
        input.description ?? null,
        input.reason ?? null,
        input.replacementName ?? null,
        sourceFile,
        timestamp,
      );
      this.clearValidationAfterDraftContentChange(batchId, timestamp);
      const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow;
      return toItem(row);
    });
    return insert();
  }

  getBatch(id: string): StoredBatch {
    const row = this.db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as BatchRow | undefined;
    if (!row) {
      throw new AppError('BATCH_NOT_FOUND', `Unknown batch: ${id}`, 404);
    }
    return toBatch(row);
  }

  getBatchForOwner(id: string, ownerId: string): StoredBatch {
    const row = this.db.prepare('SELECT * FROM batches WHERE id = ? AND owner_id = ?').get(id, ownerId) as BatchRow | undefined;
    if (!row) {
      throw new AppError('BATCH_NOT_FOUND', `Unknown batch: ${id}`, 404);
    }
    return toBatch(row);
  }

  getBatchOwnerId(id: string): string {
    const row = this.db.prepare('SELECT owner_id FROM batches WHERE id = ?').get(id) as { owner_id: string | null } | undefined;
    if (!row || !row.owner_id) {
      throw new AppError('BATCH_NOT_FOUND', `Unknown batch: ${id}`, 404);
    }
    return row.owner_id;
  }

  getDetails(id: string): BatchDetails {
    const batch = this.getBatch(id);
    const items = (this.db.prepare('SELECT * FROM items WHERE batch_id = ? ORDER BY created_at, id').all(id) as ItemRow[]).map(toItem);
    const job = this.getJob(id);
    return { ...batch, items, job, failureHistory: this.getFailureHistory(id) };
  }

  getDetailsForOwner(id: string, ownerId: string): BatchDetails {
    this.getBatchForOwner(id, ownerId);
    return this.getDetails(id);
  }

  getActiveBatchForOwner(ownerId: string): BatchDetails | null {
    const rows = this.db.prepare('SELECT * FROM batches WHERE owner_id = ? ORDER BY created_at DESC, id DESC').all(ownerId) as BatchRow[];
    const active = rows.map(toBatch).find((batch) => isActiveBatch(lifecycleSnapshot(batch)));
    return active ? this.getDetails(active.id) : null;
  }

  listBatchSummaries(limit: number, ownerId?: string): BatchSummary[] {
    const ownerFilter = ownerId ? 'WHERE batches.owner_id = ?' : '';
    const parameters: Array<string | number> = ownerId ? [ownerId, limit] : [limit];
    return (this.db.prepare(`
      SELECT
        batches.id,
        batches.title,
        batches.state,
        batches.execution_mode,
        batches.delivery_checkpoint,
        batches.delivery_branch,
        batches.delivery_commit_sha,
        batches.pr_number,
        batches.pr_url,
        batches.pr_state,
        batches.pr_is_draft,
        batches.pr_created_at,
        batches.validation_json,
        batches.base_commit,
        batches.error_code,
        batches.created_at,
        COUNT(items.id) AS item_count,
        COALESCE(SUM(CASE WHEN items.action = 'add' THEN 1 ELSE 0 END), 0) AS add_count,
        COALESCE(SUM(CASE WHEN items.action = 'replace' THEN 1 ELSE 0 END), 0) AS replace_count,
        COALESCE(SUM(CASE WHEN items.action = 'delete' THEN 1 ELSE 0 END), 0) AS delete_count
      FROM batches
      LEFT JOIN items ON items.batch_id = batches.id
      ${ownerFilter}
      GROUP BY batches.id
      ORDER BY batches.created_at DESC, batches.id DESC
      LIMIT ?
    `).all(...parameters) as BatchSummaryRow[]).map(toBatchSummary);
  }

  getItems(batchId: string): StoredItem[] {
    return (this.db.prepare('SELECT * FROM items WHERE batch_id = ? ORDER BY created_at, id').all(batchId) as ItemRow[]).map(toItem);
  }

  getFailureHistory(batchId: string): JobFailure[] {
    return (this.db.prepare(`
      SELECT * FROM job_failures WHERE batch_id = ? ORDER BY id
    `).all(batchId) as JobFailureRow[]).map(toJobFailure);
  }

  countItems(batchId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM items WHERE batch_id = ?').get(batchId) as { count: number };
    return row.count;
  }

  getItem(batchId: string, itemId: string): StoredItem {
    const row = this.db.prepare('SELECT * FROM items WHERE id = ? AND batch_id = ?').get(itemId, batchId) as ItemRow | undefined;
    if (!row) {
      throw new AppError('ITEM_NOT_FOUND', `Unknown item ${itemId} in batch ${batchId}.`, 404);
    }
    return toItem(row);
  }

  updateItem(batchId: string, itemId: string, input: CreateItemInput, sourceFile: string | null): StoredItem {
    const update = this.db.transaction(() => {
      this.requireDraftBatch(batchId);
      this.getItem(batchId, itemId);
      const timestamp = this.nextContentRevision(batchId);
      this.db.prepare(`
        UPDATE items
        SET action = ?, design_name = ?, target_name = ?, description = ?, reason = ?, replacement_name = ?, source_file = ?
        WHERE id = ? AND batch_id = ?
      `).run(
        input.action,
        input.designName ?? null,
        input.targetName ?? null,
        input.description ?? null,
        input.reason ?? null,
        input.replacementName ?? null,
        sourceFile,
        itemId,
        batchId,
      );
      this.clearValidationAfterDraftContentChange(batchId, timestamp);
      return this.getItem(batchId, itemId);
    });
    return update();
  }

  deleteItem(batchId: string, itemId: string): void {
    const remove = this.db.transaction(() => {
      this.requireDraftBatch(batchId);
      const result = this.db.prepare('DELETE FROM items WHERE id = ? AND batch_id = ?').run(itemId, batchId);
      if (result.changes !== 1) {
        throw new AppError('ITEM_NOT_FOUND', `Unknown item ${itemId} in batch ${batchId}.`, 404);
      }
      this.clearValidationAfterDraftContentChange(batchId, this.nextContentRevision(batchId));
    });
    remove();
  }

  beginValidation(batchId: string): void {
    const begin = this.db.transaction(() => {
      const batch = this.db.prepare('SELECT state FROM batches WHERE id = ?').get(batchId) as Pick<BatchRow, 'state'> | undefined;
      if (!batch) {
        throw new AppError('BATCH_NOT_FOUND', `Unknown batch: ${batchId}`, 404);
      }
      if (batch.state !== 'DRAFT') {
        throw new AppError('BATCH_NOT_VALIDATABLE', `Batch ${batchId} is ${batch.state}.`, 409);
      }
      const result = this.db.prepare(`
        UPDATE batches
        SET state = 'VALIDATING', validation_json = NULL, warning_ack_request_sha256 = NULL,
            plan_json = NULL, base_commit = NULL, local_diff_json = NULL,
            error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ? AND state = 'DRAFT'
      `).run(now(), batchId);
      if (result.changes !== 1) {
        throw new AppError('BATCH_NOT_VALIDATABLE', `Batch ${batchId} state changed before validation started.`, 409);
      }
    });
    begin();
  }

  completeValidation(batchId: string, validation: unknown, baseCommit: string | null, valid: boolean): void {
    const state: BatchState = valid ? 'READY' : 'DRAFT';
    const result = this.db.prepare(`
      UPDATE batches
      SET state = ?, validation_json = ?, warning_ack_request_sha256 = NULL,
          base_commit = ?, error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ? AND state = 'VALIDATING'
    `).run(state, JSON.stringify(validation), baseCommit, now(), batchId);
    if (result.changes !== 1) {
      throw new AppError('BATCH_VALIDATION_STATE_CONFLICT', `Batch ${batchId} left VALIDATING before validation completed.`, 409);
    }
  }

  recordFinalValidation(batchId: string, validation: unknown, baseCommit: string | null): void {
    const record = this.db.transaction(() => {
      const job = this.db.prepare('SELECT state FROM jobs WHERE batch_id = ?').get(batchId) as Pick<JobRow, 'state'> | undefined;
      if (!job || job.state !== 'RUNNING') {
        throw new AppError('DELIVERY_STATE_CONFLICT', `Batch ${batchId} is not running a delivery job.`, 409);
      }
      const result = this.db.prepare(`
        UPDATE batches
        SET validation_json = ?, warning_ack_request_sha256 = NULL,
            plan_json = NULL, base_commit = ?, local_diff_json = NULL,
            error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ? AND delivery_checkpoint = 'NONE'
      `).run(JSON.stringify(validation), baseCommit, now(), batchId);
      if (result.changes !== 1) {
        throw new AppError('DELIVERY_STATE_CONFLICT', `Batch ${batchId} cannot record final validation from its current checkpoint.`, 409);
      }
    });
    record();
  }

  returnToDraftForEditing(batchId: string): void {
    const result = this.db.prepare(`
      UPDATE batches
      SET state = 'DRAFT', warning_ack_request_sha256 = NULL,
          plan_json = NULL, base_commit = NULL, local_diff_json = NULL,
          error_code = NULL, error_message = NULL
      WHERE id = ? AND state = 'FAILED' AND delivery_checkpoint = 'NONE'
    `).run(batchId);
    if (result.changes !== 1) {
      throw new AppError('BATCH_NOT_EDITABLE', `Batch ${batchId} cannot return to editing from its current delivery state.`, 409);
    }
  }

  requiresRepeatedSubmissionConfirmation(batchId: string): boolean {
    const batch = this.getBatch(batchId);
    if (batch.state !== 'DRAFT') {
      return false;
    }
    const failure = this.db.prepare(`
      SELECT created_at FROM job_failures
      WHERE batch_id = ? AND error_code = 'FINAL_VALIDATION_FAILED'
      ORDER BY id DESC LIMIT 1
    `).get(batchId) as { created_at: string } | undefined;
    return Boolean(failure && batch.updatedAt === failure.created_at);
  }

  abortValidation(batchId: string): void {
    this.db.prepare(`
      UPDATE batches
      SET state = 'DRAFT', error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ? AND state = 'VALIDATING'
    `).run(now(), batchId);
  }

  queueJob(batchId: string): StoredJob {
    this.getBatch(batchId);
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO jobs (batch_id, state, attempt, created_at, updated_at)
      VALUES (?, 'QUEUED', 1, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET
        state = 'QUEUED',
        attempt = jobs.attempt + 1,
        error_code = NULL,
        error_message = NULL,
        updated_at = excluded.updated_at
    `).run(batchId, timestamp, timestamp);
    this.touchBatch(batchId, 'QUEUED');
    return this.getJob(batchId)!;
  }

  claimNextJob(): StoredJob | null {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM jobs WHERE state = 'QUEUED' ORDER BY updated_at, batch_id LIMIT 1
      `).get() as JobRow | undefined;
      if (!row) {
        return null;
      }
      const timestamp = now();
      this.db.prepare("UPDATE jobs SET state = 'RUNNING', updated_at = ? WHERE batch_id = ?").run(timestamp, row.batch_id);
      this.touchBatch(row.batch_id, 'RUNNING');
      return this.getJob(row.batch_id);
    });
    return claim();
  }

  completeJob(batchId: string, plan: unknown, baseCommit: string, localDiff: unknown): void {
    const timestamp = now();
    this.db.prepare(`
      UPDATE jobs SET state = 'COMPLETED', error_code = NULL, error_message = NULL, updated_at = ? WHERE batch_id = ?
    `).run(timestamp, batchId);
    this.db.prepare(`
      UPDATE batches
      SET state = 'LOCAL_DIFF_READY', plan_json = ?, base_commit = ?, local_diff_json = ?,
          error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(plan), baseCommit, JSON.stringify(localDiff), timestamp, batchId);
  }

  recordCommitPrepared(
    batchId: string,
    plan: unknown,
    baseCommit: string,
    localDiff: unknown,
    branch: string,
    commitSha: string,
  ): void {
    const record = this.db.transaction(() => {
      const job = this.db.prepare('SELECT state FROM jobs WHERE batch_id = ?').get(batchId) as Pick<JobRow, 'state'> | undefined;
      if (!job || job.state !== 'RUNNING') {
        throw new AppError('DELIVERY_STATE_CONFLICT', `Batch ${batchId} is not running a delivery job.`, 409);
      }
      const result = this.db.prepare(`
        UPDATE batches
        SET state = 'COMMIT_PREPARED', plan_json = ?, base_commit = ?, local_diff_json = ?,
            delivery_checkpoint = 'COMMIT_PREPARED', delivery_branch = ?, delivery_commit_sha = ?,
            error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(plan), baseCommit, JSON.stringify(localDiff), branch, commitSha, now(), batchId);
      if (result.changes !== 1) {
        throw new AppError('DELIVERY_STATE_CONFLICT', `Batch ${batchId} disappeared before its commit checkpoint was saved.`, 409);
      }
    });
    record();
  }

  recordBranchPushed(batchId: string): void {
    const result = this.db.prepare(`
      UPDATE batches
      SET state = 'BRANCH_PUSHED', delivery_checkpoint = 'BRANCH_PUSHED',
          error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ? AND delivery_checkpoint = 'COMMIT_PREPARED'
    `).run(now(), batchId);
    if (result.changes !== 1) {
      throw new AppError('DELIVERY_STATE_CONFLICT', `Batch ${batchId} cannot record a pushed branch from its current checkpoint.`, 409);
    }
  }

  completeBranchPushedJob(batchId: string): void {
    const result = this.db.prepare(`
      UPDATE jobs SET state = 'COMPLETED', error_code = NULL, error_message = NULL, updated_at = ?
      WHERE batch_id = ? AND state = 'RUNNING'
    `).run(now(), batchId);
    if (result.changes !== 1) {
      throw new AppError('DELIVERY_STATE_CONFLICT', `Batch ${batchId} pushed-branch job cannot be completed.`, 409);
    }
  }

  beginPullRequestCreation(batchId: string): void {
    const begin = this.db.transaction(() => {
      const job = this.db.prepare('SELECT state FROM jobs WHERE batch_id = ?').get(batchId) as Pick<JobRow, 'state'> | undefined;
      if (!job || job.state !== 'RUNNING') {
        throw new AppError('DELIVERY_STATE_CONFLICT', `Batch ${batchId} is not running a delivery job.`, 409);
      }
      const result = this.db.prepare(`
        UPDATE batches
        SET state = 'PR_CREATING', delivery_checkpoint = 'PR_CREATING',
            error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ? AND delivery_checkpoint = 'BRANCH_PUSHED'
      `).run(now(), batchId);
      if (result.changes !== 1) {
        throw new AppError('DELIVERY_STATE_CONFLICT', `Batch ${batchId} cannot begin Draft PR creation from its current checkpoint.`, 409);
      }
    });
    begin();
  }

  recordPullRequestCreated(batchId: string, pullRequest: PullRequestRecord): void {
    const record = this.db.transaction(() => {
      const job = this.db.prepare('SELECT state FROM jobs WHERE batch_id = ?').get(batchId) as Pick<JobRow, 'state'> | undefined;
      if (!job || job.state !== 'RUNNING') {
        throw new AppError('DELIVERY_STATE_CONFLICT', `Batch ${batchId} is not running a delivery job.`, 409);
      }
      const timestamp = now();
      const batchResult = this.db.prepare(`
        UPDATE batches
        SET state = 'PR_CREATED', delivery_checkpoint = 'PR_CREATED',
            pr_number = ?, pr_url = ?, pr_state = ?, pr_is_draft = ?, pr_created_at = ?, handoff_at = ?,
            error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ? AND delivery_checkpoint = 'PR_CREATING'
      `).run(
        pullRequest.number,
        pullRequest.url,
        pullRequest.state,
        pullRequest.isDraft ? 1 : 0,
        pullRequest.createdAt,
        timestamp,
        timestamp,
        batchId,
      );
      if (batchResult.changes !== 1) {
        throw new AppError('DELIVERY_STATE_CONFLICT', `Batch ${batchId} cannot record its Draft PR from its current checkpoint.`, 409);
      }
      const jobResult = this.db.prepare(`
        UPDATE jobs SET state = 'COMPLETED', error_code = NULL, error_message = NULL, updated_at = ?
        WHERE batch_id = ? AND state = 'RUNNING'
      `).run(timestamp, batchId);
      if (jobResult.changes !== 1) {
        throw new AppError('DELIVERY_STATE_CONFLICT', `Batch ${batchId} Draft PR job cannot be completed.`, 409);
      }
    });
    record();
  }

  completeAlreadyHandedOffJob(batchId: string): void {
    const result = this.db.prepare(`
      UPDATE jobs SET state = 'COMPLETED', error_code = NULL, error_message = NULL, updated_at = ?
      WHERE batch_id = ? AND state = 'RUNNING'
    `).run(now(), batchId);
    if (result.changes !== 1) {
      throw new AppError('DELIVERY_STATE_CONFLICT', `Batch ${batchId} handed-off delivery job cannot be completed.`, 409);
    }
  }

  resumeBranchPushedJobs(): number {
    const resume = this.db.transaction(() => {
      const batches = this.db.prepare(`
        SELECT batches.id
        FROM batches JOIN jobs ON jobs.batch_id = batches.id
        WHERE batches.state = 'BRANCH_PUSHED'
          AND batches.delivery_checkpoint = 'BRANCH_PUSHED'
          AND jobs.state = 'COMPLETED'
      `).all() as Array<Pick<BatchRow, 'id'>>;
      if (batches.length === 0) {
        return 0;
      }
      const timestamp = now();
      for (const batch of batches) {
        this.db.prepare(`
          UPDATE jobs
          SET state = 'QUEUED', attempt = attempt + 1, error_code = NULL, error_message = NULL, updated_at = ?
          WHERE batch_id = ? AND state = 'COMPLETED'
        `).run(timestamp, batch.id);
        this.db.prepare(`
          UPDATE batches
          SET state = 'QUEUED', error_code = NULL, error_message = NULL, updated_at = ?
          WHERE id = ? AND state = 'BRANCH_PUSHED' AND delivery_checkpoint = 'BRANCH_PUSHED'
        `).run(timestamp, batch.id);
      }
      return batches.length;
    });
    return resume();
  }

  failJob(batchId: string, code: string, message: string, diagnostic?: WorkerFailureDiagnostic): void {
    const failure = this.db.transaction(() => {
      const timestamp = now();
      const safeCode = sanitizeDiagnosticText(code, 120);
      const safeMessage = sanitizeDiagnosticText(message, 1_000);
      const safeDiagnostic = sanitizedFailureDiagnostic(diagnostic);
      const job = this.db.prepare('SELECT attempt FROM jobs WHERE batch_id = ?').get(batchId) as Pick<JobRow, 'attempt'> | undefined;
      if (job) {
        this.db.prepare(`
          INSERT INTO job_failures (
            batch_id, attempt, error_code, error_message, operation, command_text, exit_code, stderr_summary, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          batchId,
          job.attempt,
          safeCode,
          safeMessage,
          safeDiagnostic?.operation ?? null,
          safeDiagnostic?.command ?? null,
          safeDiagnostic?.exitCode ?? null,
          safeDiagnostic?.stderr ?? null,
          timestamp,
        );
      }
      this.db.prepare(`
        UPDATE jobs SET state = 'FAILED', error_code = ?, error_message = ?, updated_at = ? WHERE batch_id = ?
      `).run(safeCode, safeMessage, timestamp, batchId);
      this.db.prepare(`
        UPDATE batches SET state = 'FAILED', error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ? AND state <> 'PR_CREATED'
      `).run(safeCode, safeMessage, timestamp, batchId);
    });
    failure();
  }

  recoverInterruptedJobs(): number {
    const recover = this.db.transaction(() => {
      const jobs = this.db.prepare(`
        SELECT jobs.batch_id, jobs.attempt, batches.state AS batch_state
        FROM jobs JOIN batches ON batches.id = jobs.batch_id
        WHERE jobs.state = 'RUNNING'
      `).all() as Array<Pick<JobRow, 'batch_id' | 'attempt'> & { batch_state: BatchState }>;
      if (jobs.length === 0) {
        return 0;
      }
      const timestamp = now();
      for (const job of jobs) {
        if (job.batch_state === 'PR_CREATED') {
          this.db.prepare(`
            UPDATE jobs SET state = 'COMPLETED', error_code = NULL, error_message = NULL, updated_at = ?
            WHERE batch_id = ? AND state = 'RUNNING'
          `).run(timestamp, job.batch_id);
          continue;
        }
        this.db.prepare(`
          INSERT INTO job_failures (batch_id, attempt, error_code, error_message, created_at)
          VALUES (?, ?, 'WORKER_INTERRUPTED', 'The worker stopped before this task finished.', ?)
        `).run(job.batch_id, job.attempt, timestamp);
        this.db.prepare(`
          UPDATE jobs
          SET state = 'FAILED', error_code = 'WORKER_INTERRUPTED',
              error_message = 'The worker stopped before this task finished.', updated_at = ?
          WHERE batch_id = ? AND state = 'RUNNING'
        `).run(timestamp, job.batch_id);
        this.db.prepare(`
          UPDATE batches
          SET state = 'FAILED', error_code = 'WORKER_INTERRUPTED',
              error_message = 'The worker stopped before this task finished.', updated_at = ?
          WHERE id = ?
        `).run(timestamp, job.batch_id);
      }
      return jobs.length;
    });
    return recover();
  }

  recoverInterruptedValidations(): number {
    const result = this.db.prepare(`
      UPDATE batches
      SET state = 'DRAFT', error_code = NULL, error_message = NULL, updated_at = ?
      WHERE state = 'VALIDATING'
    `).run(now());
    return result.changes;
  }

  getJob(batchId: string): StoredJob | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE batch_id = ?').get(batchId) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  private touchBatch(batchId: string, state: BatchState): void {
    this.db.prepare('UPDATE batches SET state = ?, updated_at = ? WHERE id = ?').run(state, now(), batchId);
  }

  private clearValidationAfterDraftContentChange(batchId: string, timestamp: string): void {
    this.db.prepare(`
      UPDATE batches
      SET validation_json = NULL, warning_ack_request_sha256 = NULL,
          plan_json = NULL, base_commit = NULL, local_diff_json = NULL,
          error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ?
    `).run(timestamp, batchId);
  }

  private nextContentRevision(batchId: string): string {
    const batch = this.db.prepare('SELECT updated_at FROM batches WHERE id = ?').get(batchId) as Pick<BatchRow, 'updated_at'> | undefined;
    if (!batch) {
      throw new AppError('BATCH_NOT_FOUND', `Unknown batch: ${batchId}`, 404);
    }
    const previous = Date.parse(batch.updated_at);
    return new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
  }

  private requireDraftBatch(batchId: string): void {
    const batch = this.db.prepare('SELECT state FROM batches WHERE id = ?').get(batchId) as Pick<BatchRow, 'state'> | undefined;
    if (!batch) {
      throw new AppError('BATCH_NOT_FOUND', `Unknown batch: ${batchId}`, 404);
    }
    if (batch.state !== 'DRAFT') {
      throw new AppError('BATCH_NOT_EDITABLE', `Batch ${batchId} is ${batch.state} and cannot be edited.`, 409);
    }
  }

  private assertNoActiveBatchForOwner(ownerId: string): void {
    const rows = this.db.prepare('SELECT * FROM batches WHERE owner_id = ?').all(ownerId) as BatchRow[];
    if (rows.map(toBatch).some((batch) => isActiveBatch(lifecycleSnapshot(batch)))) {
      throw new AppError('ACTIVE_BATCH_EXISTS', '当前账号已有尚未完成的批次，请先继续处理。', 409);
    }
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
    this.applyMigration(1, () => {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        design_url TEXT NOT NULL,
        submitter_name TEXT NOT NULL,
        submitter_email TEXT NOT NULL,
        state TEXT NOT NULL,
        validation_json TEXT,
        warning_ack_request_sha256 TEXT,
        plan_json TEXT,
        base_commit TEXT,
        local_diff_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        design_name TEXT,
        target_name TEXT,
        description TEXT,
        reason TEXT,
        replacement_name TEXT,
        source_file TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        batch_id TEXT PRIMARY KEY REFERENCES batches(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      `);
      if (!this.batchColumnNames().has('warning_ack_request_sha256')) {
        this.db.exec('ALTER TABLE batches ADD COLUMN warning_ack_request_sha256 TEXT');
      }
    });
    this.applyMigration(2, () => {
      const columns = this.batchColumnNames();
      if (!columns.has('catalog_baseline_json')) {
        this.db.exec('ALTER TABLE batches ADD COLUMN catalog_baseline_json TEXT');
      }
      if (!columns.has('target_repository_json')) {
        this.db.exec('ALTER TABLE batches ADD COLUMN target_repository_json TEXT');
      }
    });
    this.applyMigration(3, () => {
      const columns = this.batchColumnNames();
      if (!columns.has('execution_mode')) {
        this.db.exec('ALTER TABLE batches ADD COLUMN execution_mode TEXT');
      }
      if (!columns.has('push_repository')) {
        this.db.exec('ALTER TABLE batches ADD COLUMN push_repository TEXT');
      }
      if (!columns.has('push_branch_prefix')) {
        this.db.exec('ALTER TABLE batches ADD COLUMN push_branch_prefix TEXT');
      }
      if (!columns.has('delivery_checkpoint')) {
        this.db.exec("ALTER TABLE batches ADD COLUMN delivery_checkpoint TEXT NOT NULL DEFAULT 'NONE'");
      }
      if (!columns.has('delivery_branch')) {
        this.db.exec('ALTER TABLE batches ADD COLUMN delivery_branch TEXT');
      }
      if (!columns.has('delivery_commit_sha')) {
        this.db.exec('ALTER TABLE batches ADD COLUMN delivery_commit_sha TEXT');
      }
      if (!columns.has('pr_number')) {
        this.db.exec('ALTER TABLE batches ADD COLUMN pr_number INTEGER');
      }
      if (!columns.has('pr_url')) {
        this.db.exec('ALTER TABLE batches ADD COLUMN pr_url TEXT');
      }
      if (!columns.has('pr_state')) {
        this.db.exec('ALTER TABLE batches ADD COLUMN pr_state TEXT');
      }
      if (!columns.has('pr_is_draft')) {
        this.db.exec('ALTER TABLE batches ADD COLUMN pr_is_draft INTEGER');
      }
      if (!columns.has('pr_created_at')) {
        this.db.exec('ALTER TABLE batches ADD COLUMN pr_created_at TEXT');
      }
      if (!columns.has('handoff_at')) {
        this.db.exec('ALTER TABLE batches ADD COLUMN handoff_at TEXT');
      }
    });
    this.applyMigration(4, () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS job_failures (
          id INTEGER PRIMARY KEY,
          batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
          attempt INTEGER NOT NULL,
          error_code TEXT NOT NULL,
          error_message TEXT NOT NULL,
          operation TEXT,
          command_text TEXT,
          exit_code INTEGER,
          stderr_summary TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS job_failures_batch_id_id ON job_failures(batch_id, id);
      `);
    });
    this.applyMigration(5, () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
      `);
      this.db.prepare(`
        INSERT OR IGNORE INTO users (id, username, password_hash, created_at)
        VALUES (?, 'legacy-bootstrap@internal.invalid', 'disabled', ?)
      `).run(legacyBootstrapUserId, now());
      const columns = this.batchColumnNames();
      if (!columns.has('owner_id')) {
        this.db.exec('ALTER TABLE batches ADD COLUMN owner_id TEXT');
      }
      this.db.prepare('UPDATE batches SET owner_id = ? WHERE owner_id IS NULL OR owner_id = ?').run(legacyBootstrapUserId, '');
      this.db.exec('CREATE INDEX IF NOT EXISTS batches_owner_created_at ON batches(owner_id, created_at DESC, id DESC)');
    });
  }

  private applyMigration(version: number, apply: () => void): void {
    const migration = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(version) as { version: number } | undefined;
      if (existing) {
        return;
      }
      apply();
      this.db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
    });
    migration();
  }

  private batchColumnNames(): Set<string> {
    const columns = this.db.prepare('PRAGMA table_info(batches)').all() as Array<{ name: string }>;
    return new Set(columns.map((column) => column.name));
  }
}

function toUser(row: UserRow): UserCredentialRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
  };
}
