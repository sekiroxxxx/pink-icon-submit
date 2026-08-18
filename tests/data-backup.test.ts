import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBackup, verifyBackup } from '../src/data-backup.js';
import { BatchDatabase } from '../src/database.js';
import { RuntimeLease } from '../src/runtime-lease.js';
import { runManageData } from '../src/manage-data.js';

const batchId = 'ICON-20260811-BACKUP01';
const itemId = 'item-backup';
const sourceFile = `uploads/${itemId}.svg`;

test('refuses backup while the service owns the runtime lease', async (t) => {
  const root = await fixtureRoot(t);
  const dataRoot = await seedDataRoot(root);
  const lease = RuntimeLease.acquire(`${join(dataRoot, 'pink-icon-submit.sqlite')}.runtime-lock`);
  try {
    await assert.rejects(
      createBackup(dataRoot, join(root, 'backup')),
      (error: unknown) => isErrorCode(error, 'RUNTIME_ALREADY_RUNNING'),
    );
  } finally {
    lease.close();
  }
});

test('creates and verifies a complete stopped-service backup', async (t) => {
  const root = await fixtureRoot(t);
  const dataRoot = await seedDataRoot(root);
  const destination = join(root, 'backup');

  await createBackup(dataRoot, destination);
  await verifyBackup(destination);

  const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8')) as {
    files: Array<{ path: string }>;
  };
  assert.deepEqual(manifest.files.map((file) => file.path), [
    `batches/${batchId}/${sourceFile}`,
    'pink-icon-submit.sqlite',
  ]);
  assert.equal(manifest.files.some((file) => file.path.includes('runtime-lock')), false);
});

test('rejects a backup destination whose directory link resolves inside the data root', async (t) => {
  const root = await fixtureRoot(t);
  const dataRoot = await seedDataRoot(root);
  const linkedParent = join(root, 'linked-destination-parent');
  await symlink(dataRoot, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(
    createBackup(dataRoot, join(linkedParent, 'backup')),
    /outside the data root/i,
  );
  await assert.rejects(
    lstat(join(dataRoot, 'backup')),
    (error: unknown) => isErrorCode(error, 'ENOENT'),
  );
});

test('detects a modified backup file', async (t) => {
  const root = await fixtureRoot(t);
  const dataRoot = await seedDataRoot(root);
  const destination = join(root, 'backup');
  await createBackup(dataRoot, destination);

  await writeFile(join(destination, 'data', 'batches', batchId, sourceFile), '<svg>tampered</svg>');
  await assert.rejects(verifyBackup(destination), /hash mismatch/i);
});

test('detects a missing SVG referenced by an item', async (t) => {
  const root = await fixtureRoot(t);
  const dataRoot = await seedDataRoot(root);
  const destination = join(root, 'backup');
  await createBackup(dataRoot, destination);

  const manifestPath = join(destination, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    files: Array<{ path: string; size: number; sha256: string }>;
  };
  manifest.files = manifest.files.filter((file) => file.path !== `batches/${batchId}/${sourceFile}`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await unlink(join(destination, 'data', 'batches', batchId, sourceFile));

  await assert.rejects(verifyBackup(destination), /missing the SVG referenced/i);
});

test('restored data preserves accounts, batches, jobs, and upload evidence', async (t) => {
  const root = await fixtureRoot(t);
  const dataRoot = await seedDataRoot(root);
  const destination = join(root, 'backup');
  const restoredRoot = join(root, 'restored-data');
  await createBackup(dataRoot, destination);
  await cp(join(destination, 'data'), restoredRoot, { recursive: true });

  const restoredBackup = join(root, 'restored-backup');
  await mkdir(restoredBackup);
  await cp(restoredRoot, join(restoredBackup, 'data'), { recursive: true });
  await cp(join(destination, 'manifest.json'), join(restoredBackup, 'manifest.json'));
  await verifyBackup(restoredBackup);

  const database = new BatchDatabase(join(restoredRoot, 'pink-icon-submit.sqlite'));
  try {
    assert.equal(database.findUserByUsername('backup-designer@internal.invalid')?.id, 'backup-user');
    assert.equal(database.findSessionUser('backup-session-hash', '2026-08-11T00:00:00.000Z')?.id, 'backup-user');
    const details = database.getDetails(batchId);
    assert.equal(details.title, 'Backup evidence');
    assert.equal(details.job?.state, 'QUEUED');
    assert.equal(details.items[0]?.sourceFile, sourceFile);
    assert.match(await readFile(join(restoredRoot, 'batches', batchId, sourceFile), 'utf8'), /<svg/);
  } finally {
    database.close();
  }
});

test('production data CLI creates and verifies a new backup without overwriting it', async (t) => {
  const root = await fixtureRoot(t);
  const dataRoot = await seedDataRoot(root);
  const destination = join(root, 'cli-backup');
  const output: string[] = [];
  const errors: string[] = [];
  const backupExitCode = await runManageData(
    ['backup', destination],
    { PINK_ICON_SUBMIT_DATA_DIR: dataRoot },
    (message) => output.push(message),
    (message) => errors.push(message),
  );
  assert.equal(backupExitCode, 0, errors.join('\n'));
  assert.equal(await runManageData(['verify', destination], {}, (message) => output.push(message), (message) => errors.push(message)), 0);
  assert.equal(await runManageData(['backup', destination], { PINK_ICON_SUBMIT_DATA_DIR: dataRoot }, () => undefined, (message) => errors.push(message)), 1);
  assert.equal(output.length, 2);
  assert.match(errors.at(-1) ?? '', /already exists/i);
});

async function fixtureRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pink-data-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function seedDataRoot(root: string): Promise<string> {
  const dataRoot = join(root, 'data-root');
  const databasePath = join(dataRoot, 'pink-icon-submit.sqlite');
  const database = new BatchDatabase(databasePath);
  database.createUser({
    id: 'backup-user',
    username: 'backup-designer@internal.invalid',
    passwordHash: 'test-password-hash',
  });
  database.createSession({
    tokenHash: 'backup-session-hash',
    userId: 'backup-user',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  database.createBatch(
    batchId,
    {
      title: 'Backup evidence',
      description: 'Retain database and upload evidence.',
      submitter: { name: 'Backup Designer', email: 'backup-designer@internal.invalid' },
    },
    {
      packageName: '@pink/codicons',
      requestedTag: 'beta',
      version: '1.0.0-test',
      integrity: 'sha512-test',
      sourceRepository: 'sud-global/pink-codicons',
      sourceCommit: 'a'.repeat(40),
    },
    { repository: 'example/pink-codicons', branch: 'main' },
    { executionMode: 'remote', pushRepository: 'bot/pink-codicons', pushBranchPrefix: 'bot/' },
    'backup-user',
  );
  database.insertItem(batchId, itemId, {
    action: 'add',
    designName: 'backup-icon',
    description: 'Backup fixture',
  }, sourceFile);
  database.queueJob(batchId);
  database.close();

  const svgPath = join(dataRoot, 'batches', batchId, sourceFile);
  await mkdir(join(svgPath, '..'), { recursive: true });
  await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>\n');
  return dataRoot;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
