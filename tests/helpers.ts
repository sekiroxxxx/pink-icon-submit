import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { BatchService } from '../src/batch-service.js';
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
  emit({ schemaVersion: 1, baseCommit: head(), icons: [], retiredCodepoints: [] });
} else if (command === 'validate') {
  const request = JSON.parse(readFileSync(inputPath, 'utf8'));
  emit({ schemaVersion: 1, batchId: request.batchId, requestSha256: 'a'.repeat(64), baseCommit: head(), valid: true, summary: { errorCount: 0, warningCount: 0 }, errors: [], warnings: [] });
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
}

export async function createTestEnvironment(t: TestContext): Promise<TestEnvironment> {
  const root = await mkdtemp(join(tmpdir(), 'pink-icon-submit-'));
  const upstream = join(root, 'upstream');
  const checkout = join(root, 'checkout');
  const data = join(root, 'data');
  await mkdir(join(upstream, 'src/icons'), { recursive: true });
  await mkdir(join(upstream, 'src/template'), { recursive: true });
  await mkdir(join(upstream, 'scripts'), { recursive: true });
  await writeFile(join(upstream, 'src/icons/existing.svg'), validSvg);
  await writeFile(join(upstream, 'src/template/mapping.json'), '{"50000":["existing"]}\n');
  await writeFile(join(upstream, 'src/template/metadata.json'), '{}\n');
  await writeFile(join(upstream, 'src/template/retired-codepoints.json'), '{"schemaVersion":1,"retired":[]}\n');
  await writeFile(join(upstream, 'scripts/icon-batch.mjs'), fakeIconBatchScript);
  execFileSync('git', ['init', '-q', '-b', 'main', upstream]);
  execFileSync('git', ['-C', upstream, 'add', '.']);
  execFileSync('git', ['-C', upstream, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);
  execFileSync('git', ['clone', '-q', upstream, checkout]);
  execFileSync('git', ['-C', checkout, 'remote', 'rename', 'origin', 'upstream']);

  const config: AppConfig = {
    databasePath: join(data, 'service.sqlite'),
    storageRoot: join(data, 'batches'),
    temporaryRoot: join(data, 'worktrees'),
    repositoryPath: checkout,
    upstreamRemote: 'upstream',
    upstreamBranch: 'main',
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
    new GitRepository(config.repositoryPath, config.temporaryRoot, config.upstreamRemote, config.upstreamBranch),
    new IconBatchCli(),
    config.maxUploadBytes,
  );
  return { config, database, batches, validSvg };
}
