import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RemoteBranchWorker } from '../src/remote-branch-worker.js';
import { createTestEnvironment, type TestEnvironment } from './helpers.js';

function remoteHead(repositoryPath: string, branch: string): string {
  return execFileSync('git', [`--git-dir=${repositoryPath}`, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
}

function workerFor(environment: TestEnvironment): RemoteBranchWorker {
  const delivery = environment.config.remoteDelivery;
  if (!delivery) {
    throw new Error('Remote test environment is missing delivery config.');
  }
  return new RemoteBranchWorker(environment.batches, {
    pushRemote: delivery.pushRemote,
    pushBranchPrefix: delivery.pushBranchPrefix,
    committer: delivery.committer,
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

test('remote worker creates one bot branch commit and pushes it without touching target main', async (t) => {
  const { environment, batchId } = await createSubmittedRemoteBatch(t);
  const outcome = await workerFor(environment).processNext();
  assert.deepEqual(outcome, { processed: true, batchId });

  const completed = environment.batches.getBatch(batchId);
  const branch = `bot/${batchId}`;
  assert.equal(completed.state, 'BRANCH_PUSHED');
  assert.equal(completed.delivery.checkpoint, 'BRANCH_PUSHED');
  assert.equal(completed.delivery.branch, branch);
  assert.equal(completed.delivery.commitSha, remoteHead(environment.pushRepositoryPath!, branch));
  assert.equal(completed.job?.state, 'COMPLETED');
  const message = execFileSync('git', [`--git-dir=${environment.pushRepositoryPath!}`, 'log', '-1', '--format=%B', branch], { encoding: 'utf8' });
  assert.match(message, new RegExp(`PinK-Icon-Batch: ${batchId}`));
  assert.match(message, /PinK-Icon-Request-SHA256: a{64}/);
  assert.deepEqual(await readdir(environment.config.temporaryRoot), []);
  assert.equal(remoteHead(environment.pushRepositoryPath!, 'main'), environment.config.targetRepository.branch === 'main'
    ? execFileSync('git', ['-C', environment.config.repositoryPath, 'rev-parse', 'upstream/main'], { encoding: 'utf8' }).trim()
    : '');
});

test('remote worker recovers a successful push when only the COMMIT_PREPARED checkpoint survived', async (t) => {
  const { environment, batchId } = await createSubmittedRemoteBatch(t);
  await workerFor(environment).processNext();
  const pushed = environment.batches.getBatch(batchId);
  const branch = pushed.delivery.branch!;
  const commitSha = pushed.delivery.commitSha!;

  environment.database.failJob(batchId, 'WORKER_INTERRUPTED', 'Simulated interruption after push.');
  const inspection = new (await import('better-sqlite3')).default(environment.config.databasePath);
  inspection.prepare("UPDATE batches SET delivery_checkpoint = 'COMMIT_PREPARED' WHERE id = ?").run(batchId);
  inspection.close();
  environment.batches.retry(batchId);

  await workerFor(environment).processNext();
  const recovered = environment.batches.getBatch(batchId);
  assert.equal(recovered.state, 'BRANCH_PUSHED');
  assert.equal(recovered.delivery.checkpoint, 'BRANCH_PUSHED');
  assert.equal(recovered.delivery.commitSha, commitSha);
  assert.equal(remoteHead(environment.pushRepositoryPath!, branch), commitSha);
  assert.equal(recovered.job?.state, 'COMPLETED');
});

test('remote worker refuses to overwrite a bot branch changed by a developer', async (t) => {
  const { environment, batchId } = await createSubmittedRemoteBatch(t);
  await workerFor(environment).processNext();
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

  environment.database.failJob(batchId, 'WORKER_INTERRUPTED', 'Simulated restart after developer handoff.');
  environment.batches.retry(batchId);
  await workerFor(environment).processNext();

  const failed = environment.batches.getBatch(batchId);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.error?.code, 'REMOTE_BRANCH_DIVERGED');
  assert.equal(remoteHead(environment.pushRepositoryPath!, branch), developerHead);
});
