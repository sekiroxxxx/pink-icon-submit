import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError, failureDiagnosticFromError } from '../src/errors.js';
import { GitRepository } from '../src/git-repository.js';
import { createTestEnvironment } from './helpers.js';

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
