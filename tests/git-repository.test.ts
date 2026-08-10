import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, rm } from 'node:fs/promises';
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

interface AskPassCapture {
  root: string;
  command: string;
  script: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}

async function assertAskPassDoesNotPersist(capture: AskPassCapture): Promise<void> {
  await assert.rejects(access(capture.command));
  await assert.rejects(access(capture.script));
  await assert.rejects(access(capture.root));
}

function runAskPass(command: string, prompt: string, environment: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') {
    return execFileSync('cmd.exe', ['/d', '/s', '/c', `call ${command} "${prompt}"`], {
      encoding: 'utf8',
      env: environment,
    });
  }
  return execFileSync(command, [prompt], { encoding: 'utf8', env: environment });
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
  let temporaryRoot = '';
  const registeredBefore = registeredWorktreePaths(environment.config.repositoryPath);

  await repository.withBaseWorktree(async (path) => {
    worktreePath = path;
    temporaryRoot = dirname(path);
    await access(path);
    assert.equal(isWithin(longRoot, path), false);
    assert.equal(isWithin(tmpdir(), path), true);
    assert.match(basename(dirname(path)), /^pink-git-/);
    assert.ok(path.length < longRoot.length);
    assert.equal(await repository.head(path), execFileSync('git', ['-C', environment.config.repositoryPath, 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim());
  });

  await assert.rejects(access(worktreePath));
  await assert.rejects(access(temporaryRoot));
  assert.deepEqual(await readdir(longRoot), []);
  assert.deepEqual(registeredWorktreePaths(environment.config.repositoryPath), registeredBefore);
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
  let temporaryRoot = '';
  const registeredBefore = registeredWorktreePaths(environment.config.repositoryPath);

  await assert.rejects(
    repository.withBaseWorktree(async (path) => {
      worktreePath = path;
      temporaryRoot = dirname(path);
      throw originalError;
    }),
    (error: unknown) => error === originalError,
  );

  await assert.rejects(access(worktreePath));
  await assert.rejects(access(temporaryRoot));
  assert.deepEqual(await readdir(longRoot), []);
  assert.deepEqual(registeredWorktreePaths(environment.config.repositoryPath), registeredBefore);
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
  let temporaryRoot = '';
  let registeredWorktreePath = '';
  const registeredBefore = registeredWorktreePaths(environment.config.repositoryPath);

  await assert.rejects(
    repository.withBaseWorktree(async (path) => {
      worktreePath = path;
      temporaryRoot = dirname(path);
      execFileSync('git', ['-C', environment.config.repositoryPath, 'worktree', 'lock', path]);
      registeredWorktreePath = registeredWorktreePaths(environment.config.repositoryPath).find((candidate) =>
        basename(candidate) === 'w' && basename(dirname(candidate)) === basename(temporaryRoot),
      ) ?? '';
      assert.notEqual(registeredWorktreePath, '');
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
  await assert.rejects(access(temporaryRoot));
  assert.deepEqual(await readdir(longRoot), []);
  assert.deepEqual(
    registeredWorktreePaths(environment.config.repositoryPath).sort(),
    [...registeredBefore, registeredWorktreePath].sort(),
  );
  assert.equal(execFileSync('git', [`--git-dir=${environment.pushRepositoryPath!}`, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), remoteHeadBefore);
});

test('uses an ephemeral askpass helper without placing its token in files, commands, or the parent environment', async (t) => {
  const environment = await createTestEnvironment(t, { executionMode: 'remote' });
  const repository = new GitRepository(environment.config.repositoryPath, environment.config.temporaryRoot, {
    mode: 'remote',
    targetRemote: 'origin',
    targetBranch: 'main',
  });
  const syntheticToken = 'synthetic-token-for-askpass-test-only';
  const authentication = { username: 'test-bot', token: syntheticToken };
  const originalFailure = new AppError('GIT_COMMAND_FAILED', 'Simulated authenticated Git failure.', 502);
  const captured: AskPassCapture[] = [];
  let invocation = 0;
  const controlledRepository = repository as unknown as {
    git(args: string[], commandEnvironment?: NodeJS.ProcessEnv): Promise<string>;
  };

  controlledRepository.git = async (args, commandEnvironment) => {
    assert.ok(commandEnvironment);
    const command = commandEnvironment.GIT_ASKPASS;
    assert.ok(command);
    const root = dirname(command);
    const script = join(root, 'askpass.cjs');
    captured.push({ root, command, script, args, environment: commandEnvironment });

    assert.equal(args.some((argument) => argument.includes(syntheticToken)), false);
    assert.equal(command.includes(syntheticToken), false);
    assert.equal(JSON.stringify(process.env).includes(syntheticToken), false);
    assert.equal(commandEnvironment.PINK_ICON_GIT_ASKPASS_TOKEN, syntheticToken);
    assert.equal(
      Object.entries(commandEnvironment)
        .filter(([name]) => name !== 'PINK_ICON_GIT_ASKPASS_TOKEN')
        .some(([, value]) => value?.includes(syntheticToken)),
      false,
    );
    assert.equal((await readFile(command, 'utf8')).includes(syntheticToken), false);
    assert.equal((await readFile(script, 'utf8')).includes(syntheticToken), false);
    assert.equal(runAskPass(command, "Username for 'https://example.invalid':", commandEnvironment), authentication.username);
    assert.equal(runAskPass(command, "Password for 'https://example.invalid':", commandEnvironment), syntheticToken);

    invocation += 1;
    if (invocation === 1) {
      return `${'a'.repeat(40)}\trefs/heads/main\n`;
    }
    throw originalFailure;
  };

  assert.equal(
    await repository.remoteBranchHead('https://example.invalid/pink-codicons.git', 'main', authentication),
    'a'.repeat(40),
  );
  await assertAskPassDoesNotPersist(captured[0]);

  await assert.rejects(
    repository.remoteBranchHead('https://example.invalid/pink-codicons.git', 'main', authentication),
    (error: unknown) => error === originalFailure,
  );
  await assertAskPassDoesNotPersist(captured[1]);
  assert.equal(captured.length, 2);
});
