import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { create as createTar } from 'tar';

import { BatchService } from '../src/batch-service.js';
import { catalogOptionsFromConfig } from '../src/config.js';
import { BatchDatabase } from '../src/database.js';
import { GitRepository } from '../src/git-repository.js';
import { IconBatchCli } from '../src/icon-batch-cli.js';
import { BatchStorage } from '../src/storage.js';
import type { AppConfig } from '../src/types.js';

const validSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h1v1H0z"/></svg>';

const fakeIconBatchScript = String.raw`
import { execFileSync } from 'node:child_process';
  import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [command, inputPath, ...rest] = process.argv.slice(2);
const repoFlag = rest.indexOf('--repo');
const repo = repoFlag >= 0 ? rest[repoFlag + 1] : process.cwd();
const head = () => execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const emit = (value, exitCode = 0) => { process.stdout.write(JSON.stringify(value)); process.exitCode = exitCode; };
if (command === 'catalog') {
  emit({ schemaVersion: 1, baseCommit: head(), icons: [{ primaryName: 'existing', sourceName: 'existing', aliases: ['existing-alias'], codepoint: 50000, sourceFile: 'src/icons/existing.svg', metadataPresent: false }], retiredCodepoints: [] });
} else if (command === 'validate') {
  const request = JSON.parse(readFileSync(inputPath, 'utf8'));
  const warnings = request.items.some((item) => item.designName === 'warning-icon')
    ? [{ code: 'SVG_STROKE_PRESENT', message: 'Stroke usage requires manual review.', itemId: request.items.find((item) => item.designName === 'warning-icon').id }]
    : [];
  emit({ schemaVersion: 1, batchId: request.batchId, requestSha256: 'a'.repeat(64), baseCommit: head(), valid: true, summary: { errorCount: 0, warningCount: warnings.length }, errors: [], warnings });
} else if (command === 'name-preview') {
  const input = inputPath;
  const normalizedName = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  const collision = normalizedName === 'existing' || normalizedName === 'existing-alias'
    ? { primaryName: 'existing', aliases: ['existing-alias'] }
    : null;
  emit({ schemaVersion: 1, baseCommit: head(), input, normalizedName, valid: normalizedName.length > 0 && normalizedName.length <= 100, collision });
} else if (command === 'plan') {
  const request = JSON.parse(readFileSync(inputPath, 'utf8'));
  const items = request.items.map((item, index) => ({
    id: item.id,
    action: 'add',
    initialName: item.designName,
    plannedName: item.designName,
    sourceFile: item.sourceFile,
    sourceSha256: 'b'.repeat(64),
    targetFile: 'src/icons/' + item.designName + '.svg',
    codepoint: 50050 + index,
    mappingAction: 'add',
    metadataAction: 'none',
  }));
  emit({ schemaVersion: 1, batchId: request.batchId, requestSha256: 'a'.repeat(64), baseCommit: head(), allowedFiles: [...items.map((item) => item.targetFile), 'src/template/mapping.json'].sort(), items });
} else if (command === 'apply') {
  const plan = JSON.parse(readFileSync(inputPath, 'utf8'));
  const requestDirectory = dirname(inputPath);
  const mappingPath = join(repo, 'src', 'template', 'mapping.json');
  const mapping = JSON.parse(readFileSync(mappingPath, 'utf8'));
  for (const item of plan.items) {
    const source = readFileSync(join(requestDirectory, item.sourceFile));
    const output = join(repo, item.targetFile);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, source);
    mapping[String(item.codepoint)] = [item.plannedName];
  }
  if (plan.items.some((item) => item.plannedName === 'unsafe-worker-icon')) {
    writeFileSync(join(repo, 'outside-plan.txt'), 'unexpected change\n');
  }
  writeFileSync(mappingPath, JSON.stringify(mapping, null, 2) + '\n');
  emit({ schemaVersion: 1, batchId: plan.batchId, baseCommit: plan.baseCommit, applied: true, modifiedFiles: plan.allowedFiles });
} else {
  process.exitCode = 1;
}
`;

export interface TestEnvironment {
  config: AppConfig;
  database: BatchDatabase;
  batches: BatchService;
  validSvg: string;
  registryRequests: { metadata: number; tarball: number };
  pushRepositoryPath?: string;
}

export interface TestEnvironmentOptions {
  executionMode?: 'local' | 'remote';
}

async function createNpmCatalogFixture(t: TestContext, root: string): Promise<{ registryUrl: string; registryRequests: { metadata: number; tarball: number } }> {
  const packageRoot = join(root, 'npm-catalog');
  const packageDirectory = join(packageRoot, 'package');
  const tarballPath = join(packageRoot, 'pink-codicons.tgz');
  await mkdir(join(packageDirectory, 'src/icons'), { recursive: true });
  await mkdir(join(packageDirectory, 'src/template'), { recursive: true });
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
    name: '@pink/codicons',
    version: '0.0.46-test.1',
  }));
  await writeFile(join(packageDirectory, 'src/icons/existing.svg'), validSvg);
  await writeFile(join(packageDirectory, 'src/template/mapping.json'), JSON.stringify({ 50000: ['existing', 'existing-alias'] }));
  await createTar({ cwd: packageRoot, file: tarballPath, gzip: true }, ['package']);
  const tarball = await readFile(tarballPath);
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  const registryRequests = { metadata: 0, tarball: 0 };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (decodeURIComponent(url.pathname) === '/@pink/codicons') {
      registryRequests.metadata += 1;
      const address = server.address() as AddressInfo;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        'dist-tags': { beta: '0.0.46-test.1' },
        versions: {
          '0.0.46-test.1': {
            gitHead: 'f'.repeat(40),
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
      registryRequests.tarball += 1;
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
  const address = server.address() as AddressInfo;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return { registryUrl: `http://127.0.0.1:${address.port}`, registryRequests };
}

export async function createTestEnvironment(t: TestContext, options: TestEnvironmentOptions = {}): Promise<TestEnvironment> {
  const executionMode = options.executionMode ?? 'local';
  const root = await mkdtemp(join(tmpdir(), 'pink-icon-submit-'));
  const upstream = join(root, 'upstream');
  const checkout = join(root, 'checkout');
  const pushRepositoryPath = join(root, 'push.git');
  const data = join(root, 'data');
  const npmCatalog = await createNpmCatalogFixture(t, root);
  await mkdir(join(upstream, 'src/icons'), { recursive: true });
  await mkdir(join(upstream, 'src/template'), { recursive: true });
  await mkdir(join(upstream, 'scripts'), { recursive: true });
  await writeFile(join(upstream, 'src/icons/existing.svg'), validSvg);
  await writeFile(join(upstream, 'src/template/mapping.json'), '{"50000":["existing","existing-alias"]}\n');
  await writeFile(join(upstream, 'src/template/metadata.json'), '{}\n');
  await writeFile(join(upstream, 'src/template/retired-codepoints.json'), '{"schemaVersion":1,"retired":[]}\n');
  await writeFile(join(upstream, 'scripts/icon-batch.mjs'), fakeIconBatchScript);
  await writeFile(join(upstream, 'package.json'), JSON.stringify({
    name: 'pink-codicons-test-fixture',
    private: true,
    version: '1.0.0',
  }, null, 2));
  await writeFile(join(upstream, 'package-lock.json'), JSON.stringify({
    name: 'pink-codicons-test-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'pink-codicons-test-fixture',
        version: '1.0.0',
      },
    },
  }, null, 2));
  execFileSync('git', ['init', '-q', '-b', 'main', upstream]);
  execFileSync('git', ['-C', upstream, 'add', '.']);
  execFileSync('git', ['-C', upstream, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);
  execFileSync('git', ['clone', '-q', upstream, checkout]);
  execFileSync('git', ['-C', checkout, 'remote', 'rename', 'origin', 'upstream']);
  if (executionMode === 'remote') {
    execFileSync('git', ['clone', '-q', '--bare', upstream, pushRepositoryPath]);
    execFileSync('git', ['-C', checkout, 'remote', 'add', 'origin', pushRepositoryPath]);
  }
  execFileSync('git', ['-C', checkout, 'config', 'core.autocrlf', 'false']);

  const config: AppConfig = {
    databasePath: join(data, 'service.sqlite'),
    storageRoot: join(data, 'batches'),
    temporaryRoot: join(data, 'worktrees'),
    repositoryPath: checkout,
    executionMode,
    ...(executionMode === 'local' ? { localTargetRef: 'main' } : {}),
    targetRepository: { repository: 'sekiroxxxx/sekiroxxxx-pink-codicons-automation-test', branch: 'main' },
    ...(executionMode === 'remote' ? {
      remoteDelivery: {
        targetRemote: 'upstream',
        pushRepository: 'sud-icon-bot/sekiroxxxx-pink-codicons-automation-test',
        pushRemote: 'origin',
        pushBranchPrefix: 'bot/' as const,
        githubToken: 'test-only-token',
        committer: { name: 'Test Bot', email: 'test-bot@example.invalid' },
      },
    } : {}),
    catalogPackageName: '@pink/codicons',
    catalogTag: 'beta',
    catalogRegistryUrl: npmCatalog.registryUrl,
    catalogSourceRepository: 'sud-global/pink-codicons',
    catalogCacheRoot: join(data, 'catalog-cache'),
    catalogRefreshIntervalMs: 60_000,
    workerPollIntervalMs: 10,
    maxUploadBytes: 1024 * 1024,
  };
  const database = new BatchDatabase(config.databasePath);
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const batches = new BatchService(
    database,
    new BatchStorage(config.storageRoot),
    new GitRepository(config.repositoryPath, config.temporaryRoot, {
      mode: config.executionMode,
      ...(config.localTargetRef ? { localTargetRef: config.localTargetRef } : {}),
      ...(config.remoteDelivery ? {
        targetRemote: config.remoteDelivery.targetRemote,
        targetBranch: config.targetRepository.branch,
        remoteAuthentication: {
          username: config.remoteDelivery.pushRepository.split('/')[0],
          token: config.remoteDelivery.githubToken,
        },
      } : {}),
    }),
    new IconBatchCli(),
    config.maxUploadBytes,
    catalogOptionsFromConfig(config),
    config.targetRepository,
    {
      executionMode: config.executionMode,
      pushRepository: config.remoteDelivery?.pushRepository ?? null,
      pushBranchPrefix: config.remoteDelivery?.pushBranchPrefix ?? null,
    },
  );
  return {
    config,
    database,
    batches,
    validSvg,
    registryRequests: npmCatalog.registryRequests,
    ...(executionMode === 'remote' ? { pushRepositoryPath } : {}),
  };
}
