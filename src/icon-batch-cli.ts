import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { AppError } from './errors.js';
import type { IconBatchResult } from './types.js';

export class IconBatchCli {
  constructor(
    private readonly nodeExecutable = process.execPath,
    private readonly npmCliPath = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ) {}

  catalog(repositoryPath: string): Promise<IconBatchResult> {
    return this.run(['catalog', '--repo', repositoryPath], repositoryPath, [0]);
  }

  namePreview(repositoryPath: string, name: string): Promise<IconBatchResult> {
    return this.run(['name-preview', name, '--repo', repositoryPath], repositoryPath, [0], false);
  }

  validate(repositoryPath: string, requestPath: string): Promise<IconBatchResult> {
    return this.run(['validate', requestPath, '--repo', repositoryPath], repositoryPath, [0, 2]);
  }

  plan(repositoryPath: string, requestPath: string): Promise<IconBatchResult> {
    return this.run(['plan', requestPath, '--repo', repositoryPath], repositoryPath, [0, 2]);
  }

  apply(repositoryPath: string, planPath: string): Promise<IconBatchResult> {
    return this.run(['apply', planPath, '--repo', repositoryPath], repositoryPath, [0]);
  }

  private async run(args: string[], cwd: string, acceptedExitCodes: number[], needsDependencies = true): Promise<IconBatchResult> {
    if (needsDependencies) {
      await this.ensureDependencies(cwd);
    }
    const result = await this.execute(this.nodeExecutable, [join(cwd, 'scripts', 'icon-batch.mjs'), ...args], cwd);

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      throw new AppError('ICON_BATCH_INVALID_OUTPUT', 'icon-batch did not return JSON output.', 502, {
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }

    if (!acceptedExitCodes.includes(result.exitCode)) {
      throw new AppError('ICON_BATCH_COMMAND_FAILED', 'icon-batch command failed.', 502, {
        exitCode: result.exitCode,
        stderr: result.stderr,
        payload,
      });
    }
    return { exitCode: result.exitCode, payload };
  }

  private async ensureDependencies(repositoryPath: string): Promise<void> {
    try {
      await access(join(repositoryPath, 'node_modules'));
      return;
    } catch {
      // Temporary worktrees start without dependencies. Install exactly what the upstream lockfile declares.
    }

    let result: { exitCode: number; stdout: string; stderr: string };
    try {
      result = await this.execute(this.nodeExecutable, [this.npmCliPath, 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], repositoryPath);
    } catch (error) {
      throw new AppError('ICON_BATCH_DEPENDENCY_INSTALL_FAILED', 'Unable to start npm ci for the temporary worktree.', 502, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (result.exitCode !== 0) {
      throw new AppError('ICON_BATCH_DEPENDENCY_INSTALL_FAILED', 'npm ci failed for the temporary worktree.', 502, {
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }
  }

  private async execute(executable: string, args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const processHandle = spawn(executable, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      processHandle.stdout.setEncoding('utf8');
      processHandle.stderr.setEncoding('utf8');
      processHandle.stdout.on('data', (chunk: string) => { stdout += chunk; });
      processHandle.stderr.on('data', (chunk: string) => { stderr += chunk; });
      processHandle.once('error', reject);
      processHandle.once('close', (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
    });
  }
}
