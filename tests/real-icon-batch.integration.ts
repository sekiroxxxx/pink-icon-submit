import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { BatchService } from '../src/batch-service.js';
import { BatchDatabase } from '../src/database.js';
import { GitRepository } from '../src/git-repository.js';
import { IconBatchCli } from '../src/icon-batch-cli.js';
import { BatchStorage } from '../src/storage.js';

const sourceRepository = process.env.PINK_CODICONS_DIR;
const validSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h1v1H0z"/></svg>';

test('real Stage 1 icon-batch installs svgo in a disposable worktree and produces a local diff', {
  skip: sourceRepository ? false : 'PINK_CODICONS_DIR is required for the real integration test.',
}, async (t) => {
  const source = resolve(sourceRepository!);
  const root = await mkdtemp(join(tmpdir(), 'pink-icon-submit-real-'));
  const upstream = join(root, 'upstream.git');
  const checkout = join(root, 'checkout');
  const data = join(root, 'data');
  let database: BatchDatabase | undefined;
  t.after(async () => {
    database?.close();
    await rm(root, { recursive: true, force: true });
  });

  execFileSync('git', ['init', '--bare', '-q', upstream]);
  execFileSync('git', ['-C', source, 'push', '--quiet', upstream, 'HEAD:refs/heads/main']);
  execFileSync('git', ['-C', upstream, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  execFileSync('git', ['clone', '-q', upstream, checkout]);
  execFileSync('git', ['-C', checkout, 'remote', 'rename', 'origin', 'upstream']);
  execFileSync('git', ['-C', checkout, 'config', 'core.autocrlf', 'false']);

  database = new BatchDatabase(join(data, 'service.sqlite'));
  const batches = new BatchService(
    database,
    new BatchStorage(join(data, 'batches')),
    new GitRepository(checkout, join(data, 'worktrees'), 'upstream', 'main'),
    new IconBatchCli(),
    1024 * 1024,
    {
      packageName: '@pink/codicons',
      tag: 'beta',
      registryUrl: 'https://registry.npmjs.org',
      sourceRepository: 'sud-global/pink-codicons',
      cacheRoot: join(data, 'catalog-cache'),
      refreshIntervalMs: 60_000,
    },
  );
  const batch = batches.createBatch({
    title: 'Real icon-batch integration',
    description: 'Verifies the Stage 1 worktree dependency boundary.',
    designUrl: 'https://design.example.invalid/real-integration',
    submitter: { name: 'Integration test', email: 'integration@example.invalid' },
  });
  await batches.addItem(batch.id, {
    action: 'add',
    designName: 'platform-integration-icon',
    description: 'Platform integration icon',
  }, Buffer.from(validSvg));
  assert.equal((await batches.validateBatch(batch.id)).state, 'READY');
  batches.submit(batch.id);

  const { LocalDiffWorker } = await import('../src/worker.js');
  await new LocalDiffWorker(batches).processNext();

  const completed = batches.getBatch(batch.id);
  assert.equal(completed.state, 'LOCAL_DIFF_READY');
  assert.equal(completed.job?.state, 'COMPLETED');
  assert.ok((completed.localDiff as { changedFiles: string[] }).changedFiles.includes('src/icons/platform-integration-icon.svg'));
  assert.deepEqual(await readdir(join(data, 'worktrees')), []);
});
