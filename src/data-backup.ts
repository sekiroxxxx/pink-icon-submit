import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { RuntimeLease } from './runtime-lease.js';
import { currentSchemaVersion } from './database.js';

const backupFormatVersion = 1;
const databaseRelativePath = 'pink-icon-submit.sqlite';
const manifestFileName = 'manifest.json';
const snapshotDirectoryName = 'data';

interface BackupManifestFile {
  path: string;
  size: number;
  sha256: string;
}

interface BackupManifest {
  formatVersion: number;
  createdAt: string;
  databasePath: string;
  schemaVersion: number;
  files: BackupManifestFile[];
}

export async function createBackup(dataRoot: string, destination: string): Promise<void> {
  const sourceRoot = resolve(dataRoot);
  const outputRoot = resolve(destination);
  const databasePath = join(sourceRoot, databaseRelativePath);
  await assertPathDoesNotExist(outputRoot, 'Backup destination already exists.');
  await assertRegularFile(databasePath, 'The PinK Icon Submit database does not exist.');
  const physicalSourceRoot = await realpath(sourceRoot);
  const physicalOutputCandidate = join(
    await resolvePhysicalPathFromExistingAncestor(dirname(outputRoot)),
    basename(outputRoot),
  );
  assertDestinationOutsideDataRoot(physicalSourceRoot, physicalOutputCandidate);
  const runtimeLockPath = `${databasePath}.runtime-lock`;
  const lease = RuntimeLease.acquire(runtimeLockPath);

  try {
    const schemaVersion = checkpointAndInspectDatabase(databasePath);
    await mkdir(dirname(outputRoot), { recursive: true });
    await mkdir(outputRoot);

    try {
      const physicalOutputRoot = await realpath(outputRoot);
      assertDestinationOutsideDataRoot(physicalSourceRoot, physicalOutputRoot);
      const snapshotRoot = join(physicalOutputRoot, snapshotDirectoryName);
      await mkdir(snapshotRoot);
      const sourceFiles = await listRegularFiles(sourceRoot, (relativePath) => isRuntimeLockFile(relativePath));
      const files: BackupManifestFile[] = [];
      for (const relativePath of sourceFiles) {
        const source = resolveContainedPath(sourceRoot, relativePath);
        const target = resolveContainedPath(snapshotRoot, relativePath);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
        const fileStat = await stat(target);
        files.push({ path: relativePath, size: fileStat.size, sha256: await sha256(target) });
      }

      const manifest: BackupManifest = {
        formatVersion: backupFormatVersion,
        createdAt: new Date().toISOString(),
        databasePath: databaseRelativePath,
        schemaVersion,
        files,
      };
      await writeFile(join(physicalOutputRoot, manifestFileName), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    } catch (error) {
      await rm(outputRoot, { recursive: true, force: true });
      throw error;
    }
  } finally {
    lease.close();
  }
}

export async function verifyBackup(backupRoot: string): Promise<void> {
  const root = resolve(backupRoot);
  const manifest = await readManifest(join(root, manifestFileName));
  const snapshotRoot = join(root, snapshotDirectoryName);
  const actualFiles = await listRegularFiles(snapshotRoot);
  const expectedPaths = manifest.files.map((file) => file.path);
  if (!sameStringArray(actualFiles, expectedPaths)) {
    throw new Error('Backup files do not match the manifest.');
  }

  for (const file of manifest.files) {
    const path = resolveContainedPath(snapshotRoot, file.path);
    const fileStat = await stat(path);
    if (fileStat.size !== file.size || await sha256(path) !== file.sha256) {
      throw new Error(`Backup file hash mismatch: ${file.path}`);
    }
  }

  const databasePath = resolveContainedPath(snapshotRoot, manifest.databasePath);
  const inspectionRoot = await mkdtemp(join(tmpdir(), 'pink-backup-verify-'));
  try {
    const inspectionDatabasePath = join(inspectionRoot, databaseRelativePath);
    await copyFile(databasePath, inspectionDatabasePath);
    const database = new Database(inspectionDatabasePath, { readonly: true, fileMustExist: true });
    try {
      assertIntegrity(database);
      const schemaVersion = readSchemaVersion(database);
      if (schemaVersion > currentSchemaVersion) {
        throw new Error(`Backup schema version ${schemaVersion} is newer than supported version ${currentSchemaVersion}.`);
      }
      if (schemaVersion !== manifest.schemaVersion) {
        throw new Error('Backup database schema version does not match the manifest.');
      }
      assertReferencedSvgsExist(database, snapshotRoot);
    } finally {
      database.close();
    }
  } finally {
    await rm(inspectionRoot, { recursive: true, force: true });
  }
}

function checkpointAndInspectDatabase(databasePath: string): number {
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    const checkpoint = database.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
    if (checkpoint.some((row) => row.busy !== 0)) {
      throw new Error('SQLite WAL checkpoint could not complete.');
    }
    assertIntegrity(database);
    const schemaVersion = readSchemaVersion(database);
    if (schemaVersion > currentSchemaVersion) {
      throw new Error(`Database schema version ${schemaVersion} is newer than supported version ${currentSchemaVersion}.`);
    }
    return schemaVersion;
  } finally {
    database.close();
  }
}

function assertIntegrity(database: Database.Database): void {
  const rows = database.pragma('integrity_check') as Array<Record<string, unknown>>;
  if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== 'ok') {
    throw new Error('SQLite integrity_check failed.');
  }
}

function readSchemaVersion(database: Database.Database): number {
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!table) {
    throw new Error('Backup database has no schema_migrations table.');
  }
  const row = database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number };
  if (!Number.isInteger(row.version) || row.version < 1) {
    throw new Error('Backup database has an invalid schema version.');
  }
  return row.version;
}

function assertReferencedSvgsExist(database: Database.Database, snapshotRoot: string): void {
  const rows = database.prepare(`
    SELECT batch_id, source_file FROM items
    WHERE source_file IS NOT NULL AND source_file <> ''
  `).all() as Array<{ batch_id: string; source_file: string }>;
  for (const row of rows) {
    const batchRoot = resolveContainedPath(join(snapshotRoot, 'batches'), row.batch_id);
    const sourcePath = resolveContainedPath(batchRoot, normalizeManifestPath(row.source_file));
    try {
      const sourceStat = statSync(sourcePath);
      if (!sourceStat.isFile()) throw new Error('not a regular file');
    } catch {
      throw new Error(`Backup is missing the SVG referenced by item ${row.batch_id}/${row.source_file}.`);
    }
  }
}

async function readManifest(path: string): Promise<BackupManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Backup manifest is missing or invalid.');
  }
  if (!isRecord(parsed)
    || parsed.formatVersion !== backupFormatVersion
    || typeof parsed.createdAt !== 'string'
    || parsed.databasePath !== databaseRelativePath
    || !Number.isInteger(parsed.schemaVersion)
    || !Array.isArray(parsed.files)) {
    throw new Error('Backup manifest is invalid.');
  }

  const files = parsed.files.map((file): BackupManifestFile => {
    if (!isRecord(file)
      || typeof file.path !== 'string'
      || typeof file.size !== 'number'
      || !Number.isInteger(file.size)
      || file.size < 0
      || typeof file.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('Backup manifest contains an invalid file entry.');
    }
    const normalized = normalizeManifestPath(file.path);
    return { path: normalized, size: file.size, sha256: file.sha256 };
  });
  const paths = files.map((file) => file.path);
  if (!sameStringArray(paths, [...new Set(paths)].sort())) {
    throw new Error('Backup manifest file entries must be unique and sorted.');
  }
  return {
    formatVersion: backupFormatVersion,
    createdAt: parsed.createdAt,
    databasePath: databaseRelativePath,
    schemaVersion: parsed.schemaVersion as number,
    files,
  };
}

async function listRegularFiles(root: string, excluded: (relativePath: string) => boolean = () => false): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = toManifestPath(relative(root, absolutePath));
      if (excluded(relativePath)) continue;
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(normalizeManifestPath(relativePath));
      } else {
        throw new Error(`Backup source contains an unsupported filesystem entry: ${relativePath}`);
      }
    }
  }
  await visit(root);
  return files.sort();
}

function isRuntimeLockFile(relativePath: string): boolean {
  const lockPath = `${databaseRelativePath}.runtime-lock`;
  return relativePath === lockPath || relativePath.startsWith(`${lockPath}-`);
}

function assertDestinationOutsideDataRoot(dataRoot: string, destination: string): void {
  const pathFromRoot = relative(dataRoot, destination);
  if (pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))) {
    throw new Error('Backup destination must be outside the data root.');
  }
}

async function resolvePhysicalPathFromExistingAncestor(path: string): Promise<string> {
  let existingPath = resolve(path);
  const missingParts: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(existingPath), ...missingParts.reverse());
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      const parent = dirname(existingPath);
      if (parent === existingPath) throw error;
      missingParts.push(basename(existingPath));
      existingPath = parent;
    }
  }
}

async function assertPathDoesNotExist(path: string, message: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(message);
}

async function assertRegularFile(path: string, message: string): Promise<void> {
  try {
    if ((await stat(path)).isFile()) return;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
  throw new Error(message);
}

function resolveContainedPath(root: string, relativePath: string): string {
  const normalized = normalizeManifestPath(relativePath);
  const output = resolve(root, ...normalized.split('/'));
  const pathFromRoot = relative(resolve(root), output);
  if (pathFromRoot === '' || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === '..' || isAbsolute(pathFromRoot)) {
    throw new Error(`Backup path escapes its root: ${relativePath}`);
  }
  return output;
}

function normalizeManifestPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Invalid backup path: ${path}`);
  }
  return normalized;
}

function toManifestPath(path: string): string {
  return path.split(sep).join('/');
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
