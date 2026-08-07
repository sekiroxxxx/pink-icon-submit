import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AppError } from '../src/errors.js';
import type { GitHubPullRequest, GitHubPullRequestClient, GitHubPullRequestLookup } from '../src/github-client.js';
import { RemoteBranchWorker } from '../src/remote-branch-worker.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';

function remoteHead(repositoryPath: string, branch: string): string {
  return execFileSync('git', [`--git-dir=${repositoryPath}`, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
}

class FakeGitHubPullRequestClient implements GitHubPullRequestClient {
  readonly created: Array<{ repository: string; title: string; head: string; base: string; body: string }> = [];
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
  environment.batches.submit((await environment.batches.validateBatch(batch.id)).id);
  return { environment, batchId: batch.id };
}

test('remote worker creates one bot branch commit and one Draft PR without touching target main', async (t) => {
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
  assert.throws(() => environment.batches.retry(batchId), /PR_CREATED/);
  assert.deepEqual(await readdir(environment.config.temporaryRoot), []);
  assert.equal(remoteHead(environment.pushRepositoryPath!, 'main'), environment.config.targetRepository.branch === 'main'
    ? execFileSync('git', ['-C', environment.config.repositoryPath, 'rev-parse', 'upstream/main'], { encoding: 'utf8' }).trim()
    : '');
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

  environment.batches.retry(batchId);
  const retried = environment.database.getDetails(batchId);
  assert.equal(retried.job?.attempt, 2);
  assert.equal(retried.job?.error, null);
  assert.equal(retried.failureHistory.length, 1);
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
  environment.batches.retry(batchId);

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
  environment.batches.retry(batchId);

  await workerFor(environment, github).processNext();
  const recovered = environment.batches.getBatch(batchId);
  assert.equal(recovered.state, 'PR_CREATED');
  assert.equal(recovered.delivery.checkpoint, 'PR_CREATED');
  assert.equal(recovered.delivery.pullRequest?.number, 1);
  assert.equal(github.created.length, 1);
  assert.equal(recovered.job?.state, 'COMPLETED');
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

  environment.batches.retry(batchId);
  github.lookupFailure = null;
  await workerFor(environment, github).processNext();

  const failed = environment.batches.getBatch(batchId);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.error?.code, 'REMOTE_BRANCH_DIVERGED');
  assert.equal(remoteHead(environment.pushRepositoryPath!, branch), developerHead);
  assert.equal(github.created.length, 0);
});
