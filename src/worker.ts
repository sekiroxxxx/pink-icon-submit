import { AppError, failureDiagnosticFromError, isAppError } from './errors.js';
import { BatchService } from './batch-service.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function planBaseCommit(plan: Record<string, unknown>): string {
  if (typeof plan.baseCommit !== 'string') {
    throw new AppError('PLAN_INVALID', 'Replanned output is missing baseCommit.', 502);
  }
  return plan.baseCommit;
}

function allowedFiles(plan: Record<string, unknown>): string[] {
  if (!Array.isArray(plan.allowedFiles) || plan.allowedFiles.some((value) => typeof value !== 'string')) {
    throw new AppError('PLAN_INVALID', 'Replanned output is missing allowedFiles.', 502);
  }
  return [...new Set(plan.allowedFiles)].sort();
}

function sameFiles(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface WorkerResult {
  processed: boolean;
  batchId?: string;
}

export class LocalDiffWorker {
  constructor(private readonly batches: BatchService) {}

  async processNext(): Promise<WorkerResult> {
    const job = this.batches.database.claimNextJob();
    if (!job) {
      return { processed: false };
    }

    try {
      const stage1Input = await this.batches.prepareStage1Request(job.batchId);
      const result = await this.batches.repository.withBaseWorktree(async (worktreePath) => {
        const planned = await this.batches.iconBatch.plan(worktreePath, stage1Input.requestPath, stage1Input);
        if (planned.exitCode !== 0) {
          throw new AppError('REPLAN_VALIDATION_FAILED', 'The batch is no longer valid against the latest target branch.', 409, planned.payload);
        }
        const plan = planned.payload;
        if (!isObject(plan)) {
          throw new AppError('PLAN_INVALID', 'icon-batch plan output must be an object.', 502);
        }
        const planPath = await this.batches.storage.writePlan(job.batchId, plan);
        await this.batches.iconBatch.apply(worktreePath, planPath, {
          ...stage1Input,
          requestPath: stage1Input.requestPath,
        });

        const changedFiles = await this.batches.repository.diffFiles(worktreePath);
        const expectedFiles = allowedFiles(plan);
        if (!sameFiles(changedFiles, expectedFiles)) {
          throw new AppError('DIFF_ALLOWLIST_VIOLATION', 'Applied diff does not match plan.allowedFiles.', 502, {
            expectedFiles,
            changedFiles,
          });
        }
        return {
          plan,
          baseCommit: planBaseCommit(plan),
          localDiff: {
            changedFiles,
            patch: await this.batches.repository.diffPatch(worktreePath),
          },
        };
      });
      this.batches.database.completeJob(job.batchId, result.plan, result.baseCommit, result.localDiff);
      return { processed: true, batchId: job.batchId };
    } catch (error) {
      if (isAppError(error)) {
        this.batches.database.failJob(job.batchId, error.code, error.message, failureDiagnosticFromError(error));
      } else {
        this.batches.database.failJob(job.batchId, 'WORKER_UNEXPECTED', error instanceof Error ? error.message : String(error));
      }
      return { processed: true, batchId: job.batchId };
    }
  }
}
