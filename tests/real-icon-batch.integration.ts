import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { create as createTar } from 'tar';

import { BatchService } from '../src/batch-service.js';
import { BatchDatabase } from '../src/database.js';
import { GitRepository } from '../src/git-repository.js';
import { IconBatchCli } from '../src/icon-batch-cli.js';
import { BatchStorage } from '../src/storage.js';

const sourceRepository = process.env.PINK_ICON_STAGE1_SOURCE_DIR;
const validSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h1v1H0z"/></svg>';

async function hasNoLegacyWorktrees(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function createFixtureRegistry(t: test.TestContext, root: string, source: string, sourceCommit: string): Promise<string> {
  const packageRoot = join(root, 'catalog-package');
  const packageDirectory = join(packageRoot, 'package');
  const tarballPath = join(packageRoot, 'pink-codicons.tgz');
  await mkdir(join(packageDirectory, 'src/template'), { recursive: true });
  await cp(join(source, 'src/icons'), join(packageDirectory, 'src/icons'), { recursive: true });
  await cp(join(source, 'src/template/mapping.json'), join(packageDirectory, 'src/template/mapping.json'));
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
    name: '@pink/codicons',
    version: '0.0.46-test.1',
  }));
  await createTar({ cwd: packageRoot, file: tarballPath, gzip: true }, ['package']);
  const tarball = await readFile(tarballPath);
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (decodeURIComponent(url.pathname) === '/@pink/codicons') {
      const address = server.address() as AddressInfo;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        'dist-tags': { beta: '0.0.46-test.1' },
        versions: {
          '0.0.46-test.1': {
            gitHead: sourceCommit,
            dist: {
              integrity,
              tarball: `http://127.0.0.1:${address.port}/tarballs/pink-codicons.tgz`,
            },
          },
        },
      }));
      return;
    }
    if (url.pathname === '/tarballs/pink-codicons.tgz') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(tarball);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('real Stage 1 v2 uses a cached npm tarball and local worktree without contacting the target remote', {
  skip: sourceRepository ? false : 'PINK_ICON_STAGE1_SOURCE_DIR is required for the real integration test.',
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
  const sourceCommit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const registryUrl = await createFixtureRegistry(t, root, source, sourceCommit);
  execFileSync('git', ['-C', checkout, 'remote', 'set-url', 'upstream', join(root, 'intentionally-unavailable.git')]);

  database = new BatchDatabase(join(data, 'service.sqlite'));
  const batches = new BatchService(
    database,
    new BatchStorage(join(data, 'batches')),
    new GitRepository(checkout, join(data, 'worktrees'), { mode: 'local', localTargetRef: 'main' }),
    new IconBatchCli({ sourceDirectory: source }),
    1024 * 1024,
    {
      packageName: '@pink/codicons',
      tag: 'beta',
      registryUrl,
      sourceRepository: 'sud-global/pink-codicons',
      cacheRoot: join(data, 'catalog-cache'),
      refreshIntervalMs: 60_000,
    },
    { repository: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test', branch: 'main' },
  );
  const batch = await batches.createBatch({
    title: 'Real icon-batch integration',
    description: 'Verifies the local Stage 1 v2 tarball and worktree boundary.',
    designUrl: 'https://design.example.invalid/real-integration',
    submitter: { name: 'Integration test', email: 'integration@example.invalid' },
  });
  await batches.addItem(batch.id, {
    action: 'add',
    designName: 'platform-integration-icon',
    description: 'Platform integration icon',
  }, Buffer.from(validSvg));
  assert.equal((await batches.validateBatch(batch.id)).state, 'READY');
  await batches.submit(batch.id);

  const { LocalDiffWorker } = await import('../src/worker.js');
  await new LocalDiffWorker(batches).processNext();

  const completed = batches.getBatch(batch.id);
  assert.equal(completed.state, 'LOCAL_DIFF_READY');
  assert.equal(completed.job?.state, 'COMPLETED');
  assert.equal((completed.validation as { schemaVersion: number }).schemaVersion, 2);
  assert.equal(completed.catalogBaseline?.integrity.startsWith('sha512-'), true);
  assert.deepEqual(completed.targetRepository, {
    repository: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test',
    branch: 'main',
  });
  assert.ok((completed.localDiff as { changedFiles: string[] }).changedFiles.includes('src/icons/platform-integration-icon.svg'));
  const request = JSON.parse(await readFile(join(data, 'batches', batch.id, 'request.json'), 'utf8')) as {
    schemaVersion: number;
    targetRepository: { repository: string; branch: string };
  };
  assert.equal(request.schemaVersion, 2);
  assert.deepEqual(request.targetRepository, {
    repository: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test',
    branch: 'main',
  });
  assert.equal(execFileSync('git', ['--git-dir', upstream, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim(), sourceCommit);
  assert.equal(await hasNoLegacyWorktrees(join(data, 'worktrees')), true);
});
