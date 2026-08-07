import { AppError, failureDiagnosticFromError, isAppError } from './errors.js';
import type { GitCommitIdentity, GitHubTokenAuthentication } from './git-repository.js';
import type { GitHubPullRequestClient } from './github-client.js';
import { draftPullRequestForBatch } from './pull-request-template.js';
import { branchForBatch } from './remote-preflight.js';
import { BatchService } from './batch-service.js';
import type { CommitterIdentity, RemoteDeliveryPhase, StoredBatch, TargetRepository } from './types.js';
import type { WorkerResult } from './worker.js';

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

function requestSha256(batch: StoredBatch): string {
  if (!isObject(batch.validation) || typeof batch.validation.requestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(batch.validation.requestSha256)) {
    throw new AppError('BATCH_REQUEST_HASH_MISSING', 'A valid batch request hash is required before creating a commit.', 409);
  }
  return batch.validation.requestSha256;
}

function commitText(batch: StoredBatch, baseCommit: string): { subject: string; body: string } {
  return {
    subject: `chore(icons): apply ${batch.id}`,
    body: [
      `PinK-Icon-Batch: ${batch.id}`,
      `PinK-Icon-Request-SHA256: ${requestSha256(batch)}`,
      `PinK-Icon-Base-Commit: ${baseCommit}`,
    ].join('\n'),
  };
}

export interface RemoteBranchWorkerOptions {
  pushRemote: string;
  pushRepository: string;
  pushBranchPrefix: 'bot/';
  deliveryPhase: RemoteDeliveryPhase;
  committer: CommitterIdentity;
  targetRepository: TargetRepository;
  github: GitHubPullRequestClient;
  authentication?: GitHubTokenAuthentication;
}

export class RemoteBranchWorker {
  constructor(
    private readonly batches: BatchService,
    private readonly options: RemoteBranchWorkerOptions,
  ) {}

  async processNext(): Promise<WorkerResult> {
    const job = this.batches.database.claimNextJob();
    if (!job) {
      return { processed: false };
    }

    try {
      const batch = this.requireRemoteBatch(job.batchId);
      if (await this.recoverRemoteBranch(batch)) {
        return { processed: true, batchId: job.batchId };
      }

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
        const baseCommit = planBaseCommit(plan);
        const message = commitText(batch, baseCommit);
        const commitSha = await this.batches.repository.commitPlannedChanges(
          worktreePath,
          expectedFiles,
          this.options.committer as GitCommitIdentity,
          message.subject,
          message.body,
        );
        return {
          plan,
          baseCommit,
          localDiff: {
            changedFiles,
            patch: await this.batches.repository.diffPatch(worktreePath),
          },
          commitSha,
        };
      });

      const branch = branchForBatch(job.batchId, this.options.pushBranchPrefix);
      this.batches.database.recordCommitPrepared(job.batchId, result.plan, result.baseCommit, result.localDiff, branch, result.commitSha);
      await this.pushOrRecoverBranch(branch, result.commitSha);
      this.batches.database.recordBranchPushed(job.batchId);
      if (this.options.deliveryPhase === 'branch') {
        this.batches.database.completeBranchPushedJob(job.batchId);
        return { processed: true, batchId: job.batchId };
      }
      await this.createOrRecoverDraftPullRequest(this.batches.database.getBatch(job.batchId));
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

  private requireRemoteBatch(batchId: string): StoredBatch {
    const batch = this.batches.database.getBatch(batchId);
    if (batch.executionMode !== 'remote'
      || !batch.pushRepository
      || batch.pushRepository !== this.options.pushRepository
      || batch.pushBranchPrefix !== this.options.pushBranchPrefix
      || !batch.targetRepository
      || batch.targetRepository.repository !== this.options.targetRepository.repository
      || batch.targetRepository.branch !== this.options.targetRepository.branch) {
      throw new AppError('REMOTE_DELIVERY_CONTEXT_MISSING', `Batch ${batchId} lacks the required P3 remote delivery context.`, 409);
    }
    return batch;
  }

  private async recoverRemoteBranch(batch: StoredBatch): Promise<boolean> {
    if (batch.delivery.checkpoint === 'PR_CREATED') {
      this.batches.database.completeAlreadyHandedOffJob(batch.id);
      return true;
    }
    if (batch.delivery.checkpoint !== 'COMMIT_PREPARED'
      && batch.delivery.checkpoint !== 'BRANCH_PUSHED'
      && batch.delivery.checkpoint !== 'PR_CREATING') {
      return false;
    }
    if (!batch.delivery.branch || !batch.delivery.commitSha) {
      throw new AppError('DELIVERY_CHECKPOINT_INVALID', `Batch ${batch.id} has an incomplete remote branch checkpoint.`, 409);
    }
    const remoteHead = await this.batches.repository.remoteBranchHead(
      this.options.pushRemote,
      batch.delivery.branch,
      this.options.authentication,
    );
    if (batch.delivery.checkpoint === 'COMMIT_PREPARED' && remoteHead === null) {
      return false;
    }
    if (remoteHead !== batch.delivery.commitSha) {
      throw new AppError('REMOTE_BRANCH_DIVERGED', `Remote branch ${batch.delivery.branch} no longer matches this batch commit.`, 409);
    }
    if (batch.delivery.checkpoint === 'COMMIT_PREPARED') {
      this.batches.database.recordBranchPushed(batch.id);
    }
    if (this.options.deliveryPhase === 'branch') {
      this.batches.database.completeBranchPushedJob(batch.id);
      return true;
    }
    await this.createOrRecoverDraftPullRequest(this.batches.database.getBatch(batch.id));
    return true;
  }

  private async createOrRecoverDraftPullRequest(batch: StoredBatch): Promise<void> {
    const pushRepository = batch.pushRepository;
    if (!batch.delivery.branch || !batch.delivery.commitSha || !pushRepository) {
      throw new AppError('DELIVERY_CHECKPOINT_INVALID', `Batch ${batch.id} has an incomplete remote branch checkpoint.`, 409);
    }
    if (batch.delivery.checkpoint === 'PR_CREATED') {
      this.batches.database.completeAlreadyHandedOffJob(batch.id);
      return;
    }
    const remoteHead = await this.batches.repository.remoteBranchHead(
      this.options.pushRemote,
      batch.delivery.branch,
      this.options.authentication,
    );
    if (remoteHead !== batch.delivery.commitSha) {
      throw new AppError('REMOTE_BRANCH_DIVERGED', `Remote branch ${batch.delivery.branch} no longer matches this batch commit.`, 409);
    }
    if (batch.delivery.checkpoint !== 'BRANCH_PUSHED' && batch.delivery.checkpoint !== 'PR_CREATING') {
      throw new AppError('DELIVERY_STATE_CONFLICT', `Batch ${batch.id} cannot create a Draft PR from its current checkpoint.`, 409);
    }
    const details = this.batches.database.getDetails(batch.id);
    const draft = draftPullRequestForBatch(details);
    const owner = pushRepository.slice(0, pushRepository.indexOf('/'));
    const head = `${owner}:${batch.delivery.branch}`;
    const existing = await this.options.github.findPullRequest(this.options.targetRepository.repository, head, draft.marker);
    if (existing.matching) {
      if (batch.delivery.checkpoint === 'BRANCH_PUSHED') {
        this.batches.database.beginPullRequestCreation(batch.id);
        batch = this.batches.database.getBatch(batch.id);
      }
      if (batch.delivery.checkpoint !== 'PR_CREATING') {
        throw new AppError('DELIVERY_STATE_CONFLICT', `Batch ${batch.id} cannot recover its Draft PR from its current checkpoint.`, 409);
      }
      this.batches.database.recordPullRequestCreated(batch.id, existing.matching);
      return;
    }
    if (existing.conflicting) {
      throw new AppError('PR_BRANCH_ALREADY_EXISTS', `Remote branch ${batch.delivery.branch} already has a non-matching pull request.`, 409);
    }
    if (!batch.baseCommit) {
      throw new AppError('DELIVERY_CHECKPOINT_INVALID', `Batch ${batch.id} is missing the base commit required to create a Draft PR.`, 409);
    }
    const actualBaseCommit = await this.batches.repository.resolveBaseCommit();
    if (actualBaseCommit !== batch.baseCommit) {
      throw new AppError(
        'TARGET_BASE_ADVANCED',
        `Target base changed before Draft PR creation (expected ${batch.baseCommit.slice(0, 12)}, actual ${actualBaseCommit.slice(0, 12)}).`,
        409,
        { expectedBaseCommit: batch.baseCommit, actualBaseCommit },
      );
    }
    if (batch.delivery.checkpoint === 'BRANCH_PUSHED') {
      this.batches.database.beginPullRequestCreation(batch.id);
      batch = this.batches.database.getBatch(batch.id);
    }
    if (batch.delivery.checkpoint !== 'PR_CREATING') {
      throw new AppError('DELIVERY_STATE_CONFLICT', `Batch ${batch.id} cannot create a Draft PR from its current checkpoint.`, 409);
    }
    const pullRequest = await this.options.github.createDraftPullRequest(this.options.targetRepository.repository, {
      title: draft.title,
      head,
      base: this.options.targetRepository.branch,
      body: draft.body,
    });
    this.batches.database.recordPullRequestCreated(batch.id, pullRequest);
  }

  private async pushOrRecoverBranch(branch: string, commitSha: string): Promise<void> {
    const remoteHead = await this.batches.repository.remoteBranchHead(this.options.pushRemote, branch, this.options.authentication);
    if (remoteHead === commitSha) {
      return;
    }
    if (remoteHead !== null) {
      throw new AppError('REMOTE_BRANCH_DIVERGED', `Remote branch ${branch} already exists with a different commit.`, 409);
    }
    await this.batches.repository.pushCommit(this.options.pushRemote, branch, commitSha, this.options.authentication);
  }
}
