import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { AppError } from '../src/errors.js';
import type { GitHubPullRequest, GitHubPullRequestClient, GitHubPullRequestLookup } from '../src/github-client.js';
import { RemoteBranchWorker } from '../src/remote-branch-worker.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';

function remoteHead(repositoryPath: string, branch: string): string {
  return execFileSync('git', [`--git-dir=${repositoryPath}`, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
}

async function recordBareRemoteReceives(t: test.TestContext, environment: TestEnvironment): Promise<() => Promise<number>> {
  const pushRepositoryPath = environment.pushRepositoryPath!;
  const receiveLogPath = join(dirname(pushRepositoryPath), 'test-bare-receive.log');
  const hookPath = join(pushRepositoryPath, 'hooks', 'post-receive');
  const quotedReceiveLogPath = `'${receiveLogPath.replaceAll('\\', '/').replaceAll("'", `'\"'\"'`)}'`;
  await writeFile(hookPath, [
    '#!/bin/sh',
    'while read old new ref',
    'do',
    `  printf '%s %s %s\\n' "$old" "$new" "$ref" >> ${quotedReceiveLogPath}`,
    'done',
    '',
  ].join('\n'));
  await chmod(hookPath, 0o700);
  return async () => {
    try {
      return (await readFile(receiveLogPath, 'utf8')).split(/\r?\n/).filter(Boolean).length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
  };
}

async function bareRemoteReceiveRefs(environment: TestEnvironment): Promise<string[]> {
  const receiveLogPath = join(dirname(environment.pushRepositoryPath!), 'test-bare-receive.log');
  try {
    return (await readFile(receiveLogPath, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/)[2]!)
      .filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function registeredWorktrees(repositoryPath: string): string[] {
  return execFileSync('git', ['-C', repositoryPath, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

async function hasNoLegacyTemporaryEntries(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function advanceTargetMain(environment: TestEnvironment): Promise<string> {
  const targetRepositoryPath = execFileSync('git', [
    '-C', environment.config.repositoryPath,
    'remote', 'get-url',
    environment.config.remoteDelivery!.targetRemote,
  ], { encoding: 'utf8' }).trim();
  await writeFile(join(targetRepositoryPath, 'target-baseline-advance.txt'), 'target baseline advanced\n');
  execFileSync('git', ['-C', targetRepositoryPath, 'add', 'target-baseline-advance.txt']);
  execFileSync('git', [
    '-C', targetRepositoryPath,
    '-c', 'user.name=Target Developer',
    '-c', 'user.email=target-developer@example.invalid',
    'commit', '-qm', 'advance target main',
  ]);
  return execFileSync('git', ['-C', targetRepositoryPath, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
}

class FakeGitHubPullRequestClient implements GitHubPullRequestClient {
  readonly created: Array<{ repository: string; title: string; head: string; base: string; body: string }> = [];
  readonly createRequestLog: Array<{ repository: string; title: string; head: string; base: string; body: string }> = [];
  readonly pullRequests: Array<{ head: string; marker: string | null; pullRequest: GitHubPullRequest }> = [];
  lookupFailure: Error | null = null;

  async findPullRequest(_repository: string, head: string, marker: string): Promise<GitHubPullRequestLookup> {
    if (this.lookupFailure) {
      throw this.lookupFailure;
    }
    const matching = this.pullRequests.find((entry) => entry.head === head && entry.marker === marker)?.pullRequest ?? null;
    const conflicting = matching
      ? null
      : this.pullRequests.find((entry) => entry.head === head)?.pullRequest ?? null;
    return { matching, conflicting };
  }

  async createDraftPullRequest(repository: string, input: { title: string; head: string; base: string; body: string }): Promise<GitHubPullRequest> {
    this.createRequestLog.push({ repository, ...input });
    const pullRequest: GitHubPullRequest = {
      number: this.pullRequests.length + 1,
      url: `https://github.example.invalid/${repository}/pull/${this.pullRequests.length + 1}`,
      state: 'open',
      isDraft: true,
      createdAt: '2026-08-06T00:00:00.000Z',
    };
    const marker = /<!-- pink-icon-submit:batch=[^\s]+ -->/.exec(input.body)?.[0] ?? null;
    this.created.push({ repository, ...input });
    this.pullRequests.push({ head: input.head, marker, pullRequest });
    return pullRequest;
  }
}

function workerFor(environment: TestEnvironment, github = new FakeGitHubPullRequestClient()): RemoteBranchWorker {
  const delivery = environment.config.remoteDelivery;
  if (!delivery) {
    throw new Error('Remote test environment is missing delivery config.');
  }
  return new RemoteBranchWorker(environment.batches, {
    pushRemote: delivery.pushRemote,
    pushRepository: delivery.pushRepository,
    pushBranchPrefix: delivery.pushBranchPrefix,
    deliveryPhase: delivery.deliveryPhase,
    committer: delivery.committer,
    targetRepository: environment.config.targetRepository,
    github,
    authentication: {
      username: delivery.pushRepository.split('/')[0],
      token: delivery.githubToken,
    },
  });
}

function trackDeliveryOperations(environment: TestEnvironment): { validate: number; plan: number; apply: number } {
  const operations = { validate: 0, plan: 0, apply: 0 };
  const iconBatch = environment.batches.iconBatch;
  const validate = iconBatch.validate.bind(iconBatch);
  const plan = iconBatch.plan.bind(iconBatch);
  const apply = iconBatch.apply.bind(iconBatch);
  iconBatch.validate = async (...args) => {
    operations.validate += 1;
    return validate(...args);
  };
  iconBatch.plan = async (...args) => {
    operations.plan += 1;
    return plan(...args);
  };
  iconBatch.apply = async (...args) => {
    operations.apply += 1;
    return apply(...args);
  };
  return operations;
}

async function createSubmittedRemoteBatch(t: test.TestContext): Promise<{ environment: TestEnvironment; batchId: string }> {
  const environment = await createTestEnvironment(t, { executionMode: 'remote' });
  const batch = await environment.batches.createBatch({
    title: 'Remote worker add',
    description: 'Exercise the safe bot branch worker against local bare Git remotes.',
    designUrl: 'https://design.example.invalid/remote-worker',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  await environment.batches.addItem(batch.id, {
    action: 'add',
    designName: 'remote-worker-icon',
    description: 'Remote worker icon',
  }, Buffer.from(environment.validSvg));
  await environment.batches.submit((await environment.batches.validateBatch(batch.id)).id);
  return { environment, batchId: batch.id };
}

async function createQueuedRemoteBatch(t: test.TestContext): Promise<{ environment: TestEnvironment; batchId: string }> {
  const environment = await createTestEnvironment(t, { executionMode: 'remote' });
  const batch = await environment.batches.createBatch({
    title: 'Remote final validation',
    description: 'Exercise final validation without an interactive validation request.',
    designUrl: 'https://design.example.invalid/remote-final-validation',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  await environment.batches.addItem(batch.id, {
    action: 'add',
    designName: 'remote-final-validation-icon',
    description: 'The remote worker must run final validation before pushing.',
  }, Buffer.from(environment.validSvg));
  environment.database.queueJob(batch.id);
  return { environment, batchId: batch.id };
}

test('remote worker creates one Draft PR only while the target base remains current', async (t) => {
  const { environment, batchId } = await createSubmittedRemoteBatch(t);
  const github = new FakeGitHubPullRequestClient();
  const outcome = await workerFor(environment, github).processNext();
  assert.deepEqual(outcome, { processed: true, batchId });

  const completed = environment.batches.getBatch(batchId);
  const branch = `bot/${batchId}`;
  assert.equal(completed.state, 'PR_CREATED');
  assert.equal(completed.delivery.checkpoint, 'PR_CREATED');
  assert.equal(completed.delivery.branch, branch);
  assert.equal(completed.delivery.commitSha, remoteHead(environment.pushRepositoryPath!, branch));
  assert.deepEqual(completed.delivery.pullRequest, {
    number: 1,
    url: 'https://github.example.invalid/sekiroxxxx/sekiroxxxx-pink-codicons-automation-test/pull/1',
    state: 'open',
    isDraft: true,
    createdAt: '2026-08-06T00:00:00.000Z',
  });
  assert.equal(completed.job?.state, 'COMPLETED');
  const message = execFileSync('git', [`--git-dir=${environment.pushRepositoryPath!}`, 'log', '-1', '--format=%B', branch], { encoding: 'utf8' });
  assert.match(message, new RegExp(`PinK-Icon-Batch: ${batchId}`));
  assert.match(message, /PinK-Icon-Request-SHA256: a{64}/);
  assert.equal(github.created.length, 1);
  assert.equal(github.created[0]?.head, `sud-icon-bot:${branch}`);
  assert.equal(github.created[0]?.base, 'main');
  assert.match(github.created[0]?.body ?? '', new RegExp(`<!-- pink-icon-submit:batch=${batchId} -->`));
  assert.match(github.created[0]?.body ?? '', /平台不再 push 或修改该分支/);
  await assert.rejects(() => environment.batches.retry(batchId), /PR_CREATED/);
  assert.equal(await hasNoLegacyTemporaryEntries(environment.config.temporaryRoot), true);
  assert.equal(remoteHead(environment.pushRepositoryPath!, 'main'), environment.config.targetRepository.branch === 'main'
    ? execFileSync('git', ['-C', environment.config.repositoryPath, 'rev-parse', 'upstream/main'], { encoding: 'utf8' }).trim()
    : '');
});

test('remote delivery soak creates one branch and one Draft PR for each of five queued batches', async (t) => {
  const environment = await createTestEnvironment(t, { executionMode: 'remote' });
  await recordBareRemoteReceives(t, environment);
  const github = new FakeGitHubPullRequestClient();
  const worker = workerFor(environment, github);
  const initialWorktrees = registeredWorktrees(environment.config.repositoryPath);
  const batchIds: string[] = [];

  for (let index = 1; index <= 5; index += 1) {
    const batch = await environment.batches.createBatch({
      title: `Remote soak batch ${index}`,
      description: 'Exercise repeated remote delivery against persistent external boundaries.',
      designUrl: `https://design.example.invalid/remote-soak-${index}`,
      submitter: { name: 'Designer', email: 'designer@example.invalid' },
    });
    await environment.batches.addItem(batch.id, {
      action: 'add',
      designName: `remote-soak-icon-${index}`,
      description: `Remote soak icon ${index}`,
    }, Buffer.from(environment.validSvg));
    environment.database.queueJob(batch.id);
    batchIds.push(batch.id);
  }

  const processedBatchIds: string[] = [];
  for (let index = 0; index < batchIds.length; index += 1) {
    const result = await worker.processNext();
    assert.equal(result.processed, true);
    if (result.processed) processedBatchIds.push(result.batchId);
  }
  assert.deepEqual([...processedBatchIds].sort(), [...batchIds].sort());
  assert.deepEqual(await worker.processNext(), { processed: false });
  assert.equal(environment.database.claimNextJob(), null);

  const receiveRefs = await bareRemoteReceiveRefs(environment);
  assert.equal(receiveRefs.length, batchIds.length);
  for (const batchId of batchIds) {
    const completed = environment.batches.getBatch(batchId);
    const branch = `bot/${batchId}`;
    const head = `sud-icon-bot:${branch}`;
    const exactHeadPullRequests = github.pullRequests.filter((entry) => entry.head === head);

    assert.equal(completed.state, 'PR_CREATED');
    assert.equal(completed.delivery.checkpoint, 'PR_CREATED');
    assert.equal(completed.job?.state, 'COMPLETED');
    assert.equal(completed.job?.attempt, 1);
    assert.equal(completed.delivery.branch, branch);
    assert.equal(completed.delivery.commitSha, remoteHead(environment.pushRepositoryPath!, branch));
    assert.equal(receiveRefs.filter((ref) => ref === `refs/heads/${branch}`).length, 1);
    assert.equal(exactHeadPullRequests.length, 1);
    assert.equal(exactHeadPullRequests[0]?.pullRequest.isDraft, true);
    assert.deepEqual(
      await github.findPullRequest(
        environment.config.targetRepository.repository,
        head,
        `<!-- pink-icon-submit:batch=${batchId} -->`,
      ),
      { matching: exactHeadPullRequests[0]?.pullRequest, conflicting: null },
    );
    assert.equal(completed.delivery.pullRequest?.number, exactHeadPullRequests[0]?.pullRequest.number);
  }

  assert.equal(github.pullRequests.length, batchIds.length);
  assert.deepEqual(registeredWorktrees(environment.config.repositoryPath), initialWorktrees);
  assert.equal(await hasNoLegacyTemporaryEntries(environment.config.temporaryRoot), true);
});

test('remote worker runs and persists final Stage 1 validation before committing or pushing', async (t) => {
  const { environment, batchId } = await createQueuedRemoteBatch(t);

  await workerFor(environment).processNext();

  const completed = environment.batches.getBatch(batchId);
  assert.equal(completed.state, 'PR_CREATED');
  assert.equal(completed.delivery.checkpoint, 'PR_CREATED');
  assert.equal((completed.validation as { valid?: unknown } | null)?.valid, true);
  assert.equal(completed.delivery.commitSha, remoteHead(environment.pushRepositoryPath!, completed.delivery.branch!));
});

test('branch delivery phase stops after a safe push without creating a Draft PR', async (t) => {
  const { environment, batchId } = await createSubmittedRemoteBatch(t);
  const github = new FakeGitHubPullRequestClient();
  const delivery = environment.config.remoteDelivery!;
  const worker = new RemoteBranchWorker(environment.batches, {
    pushRemote: delivery.pushRemote,
    pushRepository: delivery.pushRepository,
    pushBranchPrefix: delivery.pushBranchPrefix,
    deliveryPhase: 'branch',
    committer: delivery.committer,
    targetRepository: environment.config.targetRepository,
    github,
    authentication: {
      username: delivery.pushRepository.split('/')[0],
      token: delivery.githubToken,
    },
  });

  await worker.processNext();
  const pushed = environment.batches.getBatch(batchId);
  assert.equal(pushed.state, 'BRANCH_PUSHED');
  assert.equal(pushed.delivery.checkpoint, 'BRANCH_PUSHED');
  assert.equal(pushed.job?.state, 'COMPLETED');
  assert.equal(remoteHead(environment.pushRepositoryPath!, pushed.delivery.branch!), pushed.delivery.commitSha);
  assert.equal(github.created.length, 0);
});

test('remote worker recovers BRANCH_PUSHED without repeating final validation, plan, or apply', async (t) => {
  const { environment, batchId } = await createSubmittedRemoteBatch(t);
  const github = new FakeGitHubPullRequestClient();
  const delivery = environment.config.remoteDelivery!;
  const branchWorker = new RemoteBranchWorker(environment.batches, {
    pushRemote: delivery.pushRemote,
    pushRepository: delivery.pushRepository,
    pushBranchPrefix: delivery.pushBranchPrefix,
    deliveryPhase: 'branch',
    committer: delivery.committer,
    targetRepository: environment.config.targetRepository,
    github,
    authentication: {
      username: delivery.pushRepository.split('/')[0],
      token: delivery.githubToken,
    },
  });
  await branchWorker.processNext();

  const inspection = new (await import('better-sqlite3')).default(environment.config.databasePath);
  inspection.prepare("UPDATE items SET design_name = 'final-validation-failure' WHERE batch_id = ?").run(batchId);
  inspection.close();
  assert.equal(environment.database.resumeBranchPushedJobs(), 1);

  await workerFor(environment, github).processNext();

  const recovered = environment.batches.getBatch(batchId);
  assert.equal(recovered.state, 'PR_CREATED');
  assert.equal(recovered.delivery.checkpoint, 'PR_CREATED');
  assert.equal(github.created.length, 1);
});

test('manual retry after a post-push target fetch failure only recovers the Draft PR', async (t) => {
  const { environment, batchId } = await createSubmittedRemoteBatch(t);
  const bareRemoteReceiveCount = await recordBareRemoteReceives(t, environment);
  const github = new FakeGitHubPullRequestClient();
  const operations = trackDeliveryOperations(environment);
  const repository = environment.batches.repository as unknown as { options: { targetRemote: string } };
  const targetRemote = repository.options.targetRemote;
  const findPullRequest = github.findPullRequest.bind(github);
  let failPostPushFetch = true;
  github.findPullRequest = async (...args) => {
    const lookup = await findPullRequest(...args);
    if (failPostPushFetch) {
      repository.options.targetRemote = 'missing';
    }
    return lookup;
  };

  await workerFor(environment, github).processNext();

  const failed = environment.batches.getBatch(batchId);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.delivery.checkpoint, 'BRANCH_PUSHED');
  assert.equal(failed.job?.state, 'FAILED');
  assert.equal(failed.job?.attempt, 1);
  assert.equal(failed.error?.code, 'GIT_COMMAND_FAILED');
  assert.equal(failed.failureHistory.at(-1)?.operation, 'git fetch');
  assert.ok(failed.baseCommit);
  assert.ok(failed.delivery.branch);
  assert.ok(failed.delivery.commitSha);
  const branchHead = remoteHead(environment.pushRepositoryPath!, failed.delivery.branch!);
  assert.equal(branchHead, failed.delivery.commitSha);
  assert.deepEqual(operations, { validate: 1, plan: 1, apply: 1 });
  assert.equal(await bareRemoteReceiveCount(), 1);
  assert.equal(github.createRequestLog.length, 0);

  repository.options.targetRemote = targetRemote;
  failPostPushFetch = false;
  const retried = await environment.batches.retry(batchId);
  assert.equal(retried.state, 'QUEUED');
  assert.equal(retried.delivery.checkpoint, 'BRANCH_PUSHED');
  assert.equal(retried.job?.attempt, 2);
  assert.equal(retried.delivery.branch, failed.delivery.branch);
  assert.equal(retried.delivery.commitSha, failed.delivery.commitSha);
  assert.equal(retried.baseCommit, failed.baseCommit);

  await workerFor(environment, github).processNext();

  const recovered = environment.batches.getBatch(batchId);
  assert.equal(recovered.state, 'PR_CREATED');
  assert.equal(recovered.delivery.checkpoint, 'PR_CREATED');
  assert.equal(recovered.job?.state, 'COMPLETED');
  assert.equal(recovered.job?.attempt, 2);
  assert.equal(remoteHead(environment.pushRepositoryPath!, recovered.delivery.branch!), branchHead);
  assert.deepEqual(operations, { validate: 1, plan: 1, apply: 1 });
  assert.equal(await bareRemoteReceiveCount(), 1);
  assert.equal(github.createRequestLog.length, 1);
  assert.equal(github.created.length, 1);
  assert.equal((await workerFor(environment, github).processNext()).processed, false);
  assert.equal(github.createRequestLog.length, 1);
});

test('a non-AppError after a pushed branch is not eligible for Draft PR retry', async (t) => {
  const { environment, batchId } = await createSubmittedRemoteBatch(t);
  const github = new FakeGitHubPullRequestClient();
  github.lookupFailure = new Error('Simulated unexpected GitHub client fault.');

  await workerFor(environment, github).processNext();

  const failed = environment.batches.getBatch(batchId);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.delivery.checkpoint, 'BRANCH_PUSHED');
  assert.equal(failed.error?.code, 'WORKER_UNEXPECTED');
  assert.equal(failed.job?.state, 'FAILED');
  assert.equal(failed.job?.attempt, 1);
  assert.equal(remoteHead(environment.pushRepositoryPath!, failed.delivery.branch!), failed.delivery.commitSha);
  await assert.rejects(() => environment.batches.retry(batchId), { code: 'BATCH_NOT_RETRYABLE' });
  assert.equal(environment.batches.getBatch(batchId).job?.attempt, 1);
});

test('remote worker refuses Draft PR creation after the target base advances without changing the bot branch', async (t) => {
  const { environment, batchId } = await createSubmittedRemoteBatch(t);
  const github = new FakeGitHubPullRequestClient();
  const delivery = environment.config.remoteDelivery!;
  const branchWorker = new RemoteBranchWorker(environment.batches, {
    pushRemote: delivery.pushRemote,
    pushRepository: delivery.pushRepository,
    pushBranchPrefix: delivery.pushBranchPrefix,
    deliveryPhase: 'branch',
    committer: delivery.committer,
    targetRepository: environment.config.targetRepository,
    github,
    authentication: {
      username: delivery.pushRepository.split('/')[0],
      token: delivery.githubToken,
    },
  });
  await branchWorker.processNext();

  const pushed = environment.batches.getBatch(batchId);
  const branch = pushed.delivery.branch!;
  const branchHead = remoteHead(environment.pushRepositoryPath!, branch);
  const advancedBaseCommit = await advanceTargetMain(environment);
  assert.notEqual(advancedBaseCommit, pushed.baseCommit);
  assert.equal(environment.database.resumeBranchPushedJobs(), 1);

  await workerFor(environment, github).processNext();

  const failed = environment.batches.getBatch(batchId);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.delivery.checkpoint, 'BRANCH_PUSHED');
  assert.deepEqual(failed.error, {
    code: 'TARGET_BASE_ADVANCED',
    message: `Target base changed before Draft PR creation (expected ${pushed.baseCommit!.slice(0, 12)}, actual ${advancedBaseCommit.slice(0, 12)}).`,
  });
  assert.equal(github.created.length, 0);
  assert.equal(remoteHead(environment.pushRepositoryPath!, branch), branchHead);
});

test('remote worker retains a Git failure diagnostic when a retry replaces the active job error', async (t) => {
  const { environment, batchId } = await createSubmittedRemoteBatch(t);
  const repository = environment.batches.repository as unknown as { options: { targetRemote: string } };
  repository.options.targetRemote = 'missing';

  await workerFor(environment).processNext();
  const failed = environment.database.getDetails(batchId);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.failureHistory.length, 1);
  assert.deepEqual(failed.failureHistory[0] && {
    attempt: failed.failureHistory[0].attempt,
    code: failed.failureHistory[0].code,
    operation: failed.failureHistory[0].operation,
    exitCode: failed.failureHistory[0].exitCode,
  }, {
    attempt: 1,
    code: 'GIT_COMMAND_FAILED',
    operation: 'git fetch',
    exitCode: 128,
  });
  assert.match(failed.failureHistory[0]?.command ?? '', /git -C .* fetch missing$/);
  assert.match(failed.failureHistory[0]?.stderr ?? '', /missing/);

  await environment.batches.retry(batchId);
  const retried = environment.database.getDetails(batchId);
  assert.equal(retried.job?.attempt, 2);
  assert.equal(retried.job?.error, null);
  assert.equal(retried.failureHistory.length, 1);
});

test('remote worker resumes a COMMIT_PREPARED push failure without replanning', async (t) => {
  const { environment, batchId } = await createSubmittedRemoteBatch(t);
  const operations = trackDeliveryOperations(environment);
  const receiveCount = await recordBareRemoteReceives(t, environment);
  const github = new FakeGitHubPullRequestClient();
  const repository = environment.batches.repository;
  const originalPush = repository.pushCommit.bind(repository);
  let failBeforePush = true;
  repository.pushCommit = async (...args: Parameters<typeof repository.pushCommit>) => {
    if (failBeforePush) {
      failBeforePush = false;
      throw new AppError('GIT_COMMAND_FAILED', 'Simulated failure before the remote accepted the branch.', 502);
    }
    return originalPush(...args);
  };

  await workerFor(environment, github).processNext();

  const failed = environment.batches.getBatch(batchId);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.delivery.checkpoint, 'COMMIT_PREPARED');
  assert.equal(failed.job?.attempt, 1);
  assert.equal(await receiveCount(), 0);
  assert.deepEqual(operations, { validate: 1, plan: 1, apply: 1 });

  await environment.batches.retry(batchId);
  await workerFor(environment, github).processNext();

  const recovered = environment.batches.getBatch(batchId);
  assert.equal(recovered.state, 'PR_CREATED');
  assert.equal(recovered.delivery.checkpoint, 'PR_CREATED');
  assert.equal(recovered.job?.state, 'COMPLETED');
  assert.equal(recovered.job?.attempt, 2);
  assert.equal(await receiveCount(), 1);
  assert.equal(github.created.length, 1);
  assert.deepEqual(operations, { validate: 1, plan: 1, apply: 1 });
});

test('remote worker recovers a successful push when only the COMMIT_PREPARED checkpoint survived', async (t) => {
  const { environment, batchId } = await createSubmittedRemoteBatch(t);
  const github = new FakeGitHubPullRequestClient();
  await workerFor(environment, github).processNext();
  const pushed = environment.batches.getBatch(batchId);
  const branch = pushed.delivery.branch!;
  const commitSha = pushed.delivery.commitSha!;

  environment.database.failJob(batchId, 'WORKER_INTERRUPTED', 'Simulated interruption after push.');
  const inspection = new (await import('better-sqlite3')).default(environment.config.databasePath);
  inspection.prepare(`
    UPDATE batches
    SET state = 'FAILED', delivery_checkpoint = 'COMMIT_PREPARED', pr_number = NULL, pr_url = NULL, pr_state = NULL,
        pr_is_draft = NULL, pr_created_at = NULL, handoff_at = NULL
    WHERE id = ?
  `).run(batchId);
  inspection.close();
  await environment.batches.retry(batchId);

  await workerFor(environment, github).processNext();
  const recovered = environment.batches.getBatch(batchId);
  assert.equal(recovered.state, 'PR_CREATED');
  assert.equal(recovered.delivery.checkpoint, 'PR_CREATED');
  assert.equal(recovered.delivery.commitSha, commitSha);
  assert.equal(remoteHead(environment.pushRepositoryPath!, branch), commitSha);
  assert.equal(recovered.job?.state, 'COMPLETED');
  assert.equal(github.created.length, 1);
});

test('remote worker recovers a successful Draft PR when only PR_CREATING survived', async (t) => {
  const { environment, batchId } = await createSubmittedRemoteBatch(t);
  const github = new FakeGitHubPullRequestClient();
  await workerFor(environment, github).processNext();

  environment.database.failJob(batchId, 'WORKER_INTERRUPTED', 'Simulated interruption after Draft PR creation.');
  const inspection = new (await import('better-sqlite3')).default(environment.config.databasePath);
  inspection.prepare(`
    UPDATE batches
    SET state = 'FAILED', delivery_checkpoint = 'PR_CREATING', pr_number = NULL, pr_url = NULL, pr_state = NULL,
        pr_is_draft = NULL, pr_created_at = NULL, handoff_at = NULL
    WHERE id = ?
  `).run(batchId);
  inspection.close();
  const mutateItem = new (await import('better-sqlite3')).default(environment.config.databasePath);
  mutateItem.prepare("UPDATE items SET design_name = 'final-validation-failure' WHERE batch_id = ?").run(batchId);
  mutateItem.close();
  await environment.batches.retry(batchId);
  const advancedBaseCommit = await advanceTargetMain(environment);
  assert.notEqual(advancedBaseCommit, environment.batches.getBatch(batchId).baseCommit);

  await workerFor(environment, github).processNext();
  const recovered = environment.batches.getBatch(batchId);
  assert.equal(recovered.state, 'PR_CREATED');
  assert.equal(recovered.delivery.checkpoint, 'PR_CREATED');
  assert.equal(recovered.delivery.pullRequest?.number, 1);
  assert.equal(github.created.length, 1);
  assert.equal(recovered.job?.state, 'COMPLETED');
});

test('manual retry records an already-created Draft PR after its create response is lost', async (t) => {
  const { environment, batchId } = await createSubmittedRemoteBatch(t);
  const bareRemoteReceiveCount = await recordBareRemoteReceives(t, environment);
  const github = new FakeGitHubPullRequestClient();
  const createDraftPullRequest = github.createDraftPullRequest.bind(github);
  let loseResponse = true;
  github.createDraftPullRequest = async (...args) => {
    const created = await createDraftPullRequest(...args);
    if (loseResponse) {
      loseResponse = false;
      throw new AppError('GITHUB_API_REQUEST_FAILED', 'Simulated Draft PR response loss.', 502);
    }
    return created;
  };

  await workerFor(environment, github).processNext();

  const failed = environment.batches.getBatch(batchId);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.delivery.checkpoint, 'PR_CREATING');
  assert.equal(failed.job?.state, 'FAILED');
  assert.equal(failed.job?.attempt, 1);
  assert.equal(github.created.length, 1);
  assert.equal(github.createRequestLog.length, 1);
  assert.equal(github.created[0]?.head, `sud-icon-bot:${failed.delivery.branch}`);
  assert.equal(remoteHead(environment.pushRepositoryPath!, failed.delivery.branch!), failed.delivery.commitSha);
  assert.equal(await bareRemoteReceiveCount(), 1);

  const retried = await environment.batches.retry(batchId);
  assert.equal(retried.job?.attempt, 2);
  await workerFor(environment, github).processNext();

  const recovered = environment.batches.getBatch(batchId);
  assert.equal(recovered.state, 'PR_CREATED');
  assert.equal(recovered.delivery.checkpoint, 'PR_CREATED');
  assert.equal(recovered.delivery.pullRequest?.number, 1);
  assert.equal(recovered.job?.state, 'COMPLETED');
  assert.equal(github.created.length, 1);
  assert.equal(github.createRequestLog.length, 1);
  assert.equal(await bareRemoteReceiveCount(), 1);
  assert.equal(remoteHead(environment.pushRepositoryPath!, recovered.delivery.branch!), recovered.delivery.commitSha);
});

test('post-push Draft PR retries reject business failures and incomplete persisted evidence', async (t) => {
  const environment = await createTestEnvironment(t, { executionMode: 'remote' });
  const batch = await environment.batches.createBatch({
    title: 'Post-push retry guard',
    description: 'Only complete infrastructure failures may resume Draft PR delivery.',
    submitter: { name: 'Designer', email: 'designer@example.invalid' },
  });
  environment.database.queueJob(batch.id);
  environment.database.claimNextJob();
  environment.database.recordCommitPrepared(
    batch.id,
    { baseCommit: 'a'.repeat(40), allowedFiles: ['src/icons/retry-guard.svg'], items: [] },
    'a'.repeat(40),
    { changedFiles: ['src/icons/retry-guard.svg'], patch: '' },
    `bot/${batch.id}`,
    'b'.repeat(40),
  );
  environment.database.recordBranchPushed(batch.id);
  for (const errorCode of [
    'FINAL_VALIDATION_FAILED',
    'TARGET_BASE_ADVANCED',
    'PR_BRANCH_ALREADY_EXISTS',
    'REMOTE_BRANCH_DIVERGED',
    'WORKER_UNEXPECTED',
  ]) {
    environment.database.failJob(batch.id, errorCode, `Simulated non-recoverable ${errorCode} failure.`);
    await assert.rejects(() => environment.batches.retry(batch.id), { code: 'BATCH_NOT_RETRYABLE' });
  }
  assert.equal(environment.batches.getBatch(batch.id).job?.attempt, 1);

  environment.database.failJob(batch.id, 'GIT_COMMAND_FAILED', 'Simulated temporary Draft PR infrastructure failure.');
  const inspection = new (await import('better-sqlite3')).default(environment.config.databasePath);
  inspection.prepare('UPDATE batches SET base_commit = NULL WHERE id = ?').run(batch.id);
  inspection.close();

  await assert.rejects(() => environment.batches.retry(batch.id), { code: 'BATCH_NOT_RETRYABLE' });
  const rejected = environment.batches.getBatch(batch.id);
  assert.equal(rejected.state, 'FAILED');
  assert.equal(rejected.delivery.checkpoint, 'BRANCH_PUSHED');
  assert.equal(rejected.job?.state, 'FAILED');
  assert.equal(rejected.job?.attempt, 1);
});

test('remote worker refuses to create a duplicate PR when the bot branch already has an unmarked PR', async (t) => {
  const { environment, batchId } = await createSubmittedRemoteBatch(t);
  const github = new FakeGitHubPullRequestClient();
  github.pullRequests.push({
    head: `sud-icon-bot:bot/${batchId}`,
    marker: null,
    pullRequest: {
      number: 77,
      url: 'https://github.example.invalid/existing/pull/77',
      state: 'open',
      isDraft: true,
      createdAt: '2026-08-06T00:00:00.000Z',
    },
  });

  await workerFor(environment, github).processNext();

  const failed = environment.batches.getBatch(batchId);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.error?.code, 'PR_BRANCH_ALREADY_EXISTS');
  assert.equal(github.created.length, 0);
});

test('remote worker refuses to create a PR from a bot branch changed by a developer', async (t) => {
  const { environment, batchId } = await createSubmittedRemoteBatch(t);
  const github = new FakeGitHubPullRequestClient();
  github.lookupFailure = new AppError('GITHUB_API_REQUEST_FAILED', 'Simulated GitHub lookup failure.', 502);
  await workerFor(environment, github).processNext();
  const pushed = environment.batches.getBatch(batchId);
  const branch = pushed.delivery.branch!;
  const developerClone = await mkdtemp(join(tmpdir(), 'pink-icon-submit-developer-'));
  t.after(async () => rm(developerClone, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', environment.pushRepositoryPath!, developerClone]);
  execFileSync('git', ['-C', developerClone, 'checkout', '-q', branch]);
  await writeFile(join(developerClone, 'developer-note.txt'), 'developer handoff change\n');
  execFileSync('git', ['-C', developerClone, 'add', 'developer-note.txt']);
  execFileSync('git', ['-C', developerClone, '-c', 'user.name=Developer', '-c', 'user.email=developer@example.invalid', 'commit', '-qm', 'developer handoff change']);
  execFileSync('git', ['-C', developerClone, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
  const developerHead = remoteHead(environment.pushRepositoryPath!, branch);
  assert.notEqual(developerHead, pushed.delivery.commitSha);

  await environment.batches.retry(batchId);
  github.lookupFailure = null;
  await workerFor(environment, github).processNext();

  const failed = environment.batches.getBatch(batchId);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.error?.code, 'REMOTE_BRANCH_DIVERGED');
  assert.equal(remoteHead(environment.pushRepositoryPath!, branch), developerHead);
  assert.equal(github.created.length, 0);
});
