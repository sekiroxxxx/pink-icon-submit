import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { AppError } from './errors.js';
import type {
  BatchDetails,
  BatchState,
  CreateBatchInput,
  CreateItemInput,
  JobState,
  StoredBatch,
  StoredItem,
  StoredJob,
} from './types.js';

interface BatchRow {
  id: string;
  title: string;
  description: string;
  design_url: string;
  submitter_name: string;
  submitter_email: string;
  state: BatchState;
  validation_json: string | null;
  plan_json: string | null;
  base_commit: string | null;
  local_diff_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
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

interface JobRow {
  batch_id: string;
  state: JobState;
  attempt: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson(value: string | null): unknown | null {
  return value === null ? null : JSON.parse(value);
}

function toBatch(row: BatchRow): StoredBatch {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    designUrl: row.design_url,
    submitter: { name: row.submitter_name, email: row.submitter_email },
    state: row.state,
    validation: parseJson(row.validation_json),
    plan: parseJson(row.plan_json),
    baseCommit: row.base_commit,
    localDiff: parseJson(row.local_diff_json),
    error: row.error_code && row.error_message ? { code: row.error_code, message: row.error_message } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

  createBatch(id: string, input: CreateBatchInput): StoredBatch {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO batches (
        id, title, description, design_url, submitter_name, submitter_email, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
    `).run(id, input.title, input.description, input.designUrl, input.submitter.name, input.submitter.email, timestamp, timestamp);
    return this.getBatch(id);
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

      const timestamp = now();
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
      this.db.prepare('UPDATE batches SET updated_at = ? WHERE id = ?').run(timestamp, batchId);
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

  getDetails(id: string): BatchDetails {
    const batch = this.getBatch(id);
    const items = (this.db.prepare('SELECT * FROM items WHERE batch_id = ? ORDER BY created_at, id').all(id) as ItemRow[]).map(toItem);
    const job = this.getJob(id);
    return { ...batch, items, job };
  }

  getItems(batchId: string): StoredItem[] {
    return (this.db.prepare('SELECT * FROM items WHERE batch_id = ? ORDER BY created_at, id').all(batchId) as ItemRow[]).map(toItem);
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
        SET state = 'VALIDATING', validation_json = NULL, base_commit = NULL,
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
      SET state = ?, validation_json = ?, base_commit = ?, error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ? AND state = 'VALIDATING'
    `).run(state, JSON.stringify(validation), baseCommit, now(), batchId);
    if (result.changes !== 1) {
      throw new AppError('BATCH_VALIDATION_STATE_CONFLICT', `Batch ${batchId} left VALIDATING before validation completed.`, 409);
    }
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

  failJob(batchId: string, code: string, message: string): void {
    const timestamp = now();
    this.db.prepare(`
      UPDATE jobs SET state = 'FAILED', error_code = ?, error_message = ?, updated_at = ? WHERE batch_id = ?
    `).run(code, message, timestamp, batchId);
    this.db.prepare(`
      UPDATE batches SET state = 'FAILED', error_code = ?, error_message = ?, updated_at = ? WHERE id = ?
    `).run(code, message, timestamp, batchId);
  }

  recoverInterruptedJobs(): number {
    const recover = this.db.transaction(() => {
      const jobs = this.db.prepare("SELECT batch_id FROM jobs WHERE state = 'RUNNING'").all() as Array<Pick<JobRow, 'batch_id'>>;
      if (jobs.length === 0) {
        return 0;
      }
      const timestamp = now();
      for (const job of jobs) {
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

  private migrate(): void {
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
  }
}
