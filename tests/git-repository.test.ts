import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

import { AppError, failureDiagnosticFromError } from '../src/errors.js';
import { GitRepository } from '../src/git-repository.js';
import { createTestEnvironment } from './helpers.js';

function registeredWorktreePaths(repositoryPath: string): string[] {
  return execFileSync('git', ['-C', repositoryPath, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)));
}

function longBatchWorktreeRoot(): string {
  return join(
    tmpdir(),
    `pink-long-data-${'x'.repeat(85)}`,
    `batches-${'y'.repeat(85)}`,
    'worktrees',
  );
}

function isWithin(root: string, candidate: string): boolean {
  const pathRelative = relative(resolve(root), resolve(candidate));
  return pathRelative !== '' && pathRelative !== '..' && !pathRelative.startsWith(`..${sep}`) && !isAbsolute(pathRelative);
}

test('git failures expose a sanitized logical command, exit code, and stderr diagnostic', async (t) => {
  const environment = await createTestEnvironment(t, { executionMode: 'remote' });
  const repository = new GitRepository(environment.config.repositoryPath, environment.config.temporaryRoot, {
    mode: 'remote',
    targetRemote: 'missing',
    targetBranch: 'main',
  });

  await assert.rejects(
    repository.resolveBaseCommit(),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'GIT_COMMAND_FAILED');
      assert.deepEqual(failureDiagnosticFromError(error), {
        operation: 'git fetch',
        command: `git -C ${environment.config.repositoryPath} fetch missing`,
        exitCode: 128,
        stderr: 'fatal: \'missing\' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n',
      });
      return true;
    },
  );
});

test('uses a short owned system-temporary worktree for long data paths and removes it from Git', async (t) => {
  const environment = await createTestEnvironment(t, { executionMode: 'remote' });
  const longRoot = longBatchWorktreeRoot();
  await mkdir(longRoot, { recursive: true });
  t.after(async () => {
    await rm(longRoot, { recursive: true, force: true });
  });
  const repository = new GitRepository(environment.config.repositoryPath, longRoot, {
    mode: 'remote',
    targetRemote: 'origin',
    targetBranch: 'main',
  });
  const remoteHeadBefore = execFileSync('git', [`--git-dir=${environment.pushRepositoryPath!}`, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  let worktreePath = '';

  await repository.withBaseWorktree(async (path) => {
    worktreePath = path;
    await access(path);
    assert.equal(isWithin(longRoot, path), false);
    assert.equal(isWithin(tmpdir(), path), true);
    assert.match(basename(dirname(path)), /^pink-git-/);
    assert.ok(path.length < longRoot.length);
    assert.equal(await repository.head(path), execFileSync('git', ['-C', environment.config.repositoryPath, 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim());
  });

  await assert.rejects(access(worktreePath));
  assert.deepEqual(await readdir(longRoot), []);
  assert.equal(registeredWorktreePaths(environment.config.repositoryPath).includes(resolve(worktreePath)), false);
  assert.equal(execFileSync('git', [`--git-dir=${environment.pushRepositoryPath!}`, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), remoteHeadBefore);
});

test('cleans an owned short worktree after a callback failure without replacing the original error', async (t) => {
  const environment = await createTestEnvironment(t);
  const longRoot = longBatchWorktreeRoot();
  await mkdir(longRoot, { recursive: true });
  t.after(async () => {
    await rm(longRoot, { recursive: true, force: true });
  });
  const repository = new GitRepository(environment.config.repositoryPath, longRoot, {
    mode: 'local',
    localTargetRef: 'main',
  });
  const originalError = new AppError('ICON_BATCH_COMMAND_FAILED', 'Simulated Stage 1 failure.', 502);
  let worktreePath = '';

  await assert.rejects(
    repository.withBaseWorktree(async (path) => {
      worktreePath = path;
      throw originalError;
    }),
    (error: unknown) => error === originalError,
  );

  await assert.rejects(access(worktreePath));
  assert.deepEqual(await readdir(longRoot), []);
  assert.equal(registeredWorktreePaths(environment.config.repositoryPath).includes(resolve(worktreePath)), false);
});

test('surfaces a temporary worktree removal failure without remote writes', async (t) => {
  const environment = await createTestEnvironment(t, { executionMode: 'remote' });
  const longRoot = longBatchWorktreeRoot();
  await mkdir(longRoot, { recursive: true });
  t.after(async () => {
    await rm(longRoot, { recursive: true, force: true });
  });
  const repository = new GitRepository(environment.config.repositoryPath, longRoot, {
    mode: 'remote',
    targetRemote: 'origin',
    targetBranch: 'main',
  });
  const remoteHeadBefore = execFileSync('git', [`--git-dir=${environment.pushRepositoryPath!}`, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  let worktreePath = '';

  await assert.rejects(
    repository.withBaseWorktree(async (path) => {
      worktreePath = path;
      execFileSync('git', ['-C', environment.config.repositoryPath, 'worktree', 'lock', path]);
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'GIT_COMMAND_FAILED');
      const diagnostic = failureDiagnosticFromError(error);
      assert.equal(diagnostic?.operation, 'git worktree');
      assert.match(diagnostic?.command ?? '', /worktree remove --force/);
      assert.equal(typeof diagnostic?.exitCode, 'number');
      assert.match(diagnostic?.stderr ?? '', /locked/i);
      return true;
    },
  );

  await assert.rejects(access(worktreePath));
  assert.deepEqual(await readdir(longRoot), []);
  assert.equal(execFileSync('git', [`--git-dir=${environment.pushRepositoryPath!}`, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), remoteHeadBefore);
});
