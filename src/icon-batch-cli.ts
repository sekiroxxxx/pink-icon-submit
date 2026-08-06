import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { AppError } from './errors.js';
import type { IconBatchResult } from './types.js';

export interface IconBatchCliOptions {
  sourceDirectory?: string;
}

export interface IconBatchV2Input {
  catalogTarball: string;
  targetRepository: string;
}

export class IconBatchCli {
  constructor(
    private readonly options: IconBatchCliOptions = {},
    private readonly nodeExecutable = process.execPath,
    private readonly npmCliPath = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ) {}

  catalog(repositoryPath: string): Promise<IconBatchResult> {
    return this.run(['catalog', '--repo', repositoryPath], repositoryPath, [0]);
  }

  namePreview(repositoryPath: string, name: string): Promise<IconBatchResult> {
    return this.run(['name-preview', name, '--repo', repositoryPath], repositoryPath, [0], false);
  }

  validate(repositoryPath: string, requestPath: string, input?: IconBatchV2Input): Promise<IconBatchResult> {
    return this.run(['validate', requestPath, '--repo', repositoryPath, ...this.v2Arguments(input)], repositoryPath, [0, 2]);
  }

  plan(repositoryPath: string, requestPath: string, input?: IconBatchV2Input): Promise<IconBatchResult> {
    return this.run(['plan', requestPath, '--repo', repositoryPath, ...this.v2Arguments(input)], repositoryPath, [0, 2]);
  }

  apply(repositoryPath: string, planPath: string, input?: IconBatchV2Input & { requestPath: string }): Promise<IconBatchResult> {
    return this.run([
      'apply',
      planPath,
      '--repo',
      repositoryPath,
      ...(input ? ['--request', input.requestPath] : []),
      ...this.v2Arguments(input),
    ], repositoryPath, [0]);
  }

  private async run(args: string[], cwd: string, acceptedExitCodes: number[], needsDependencies = true): Promise<IconBatchResult> {
    const sourceDirectory = this.options.sourceDirectory ?? cwd;
    if (needsDependencies) {
      await this.ensureDependencies(sourceDirectory, Boolean(this.options.sourceDirectory));
    }
    const result = await this.execute(this.nodeExecutable, [join(sourceDirectory, 'scripts', 'icon-batch.mjs'), ...args], cwd);

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

  private v2Arguments(input: IconBatchV2Input | undefined): string[] {
    return input ? ['--catalog-tarball', input.catalogTarball, '--target-repository', input.targetRepository] : [];
  }

  private async ensureDependencies(repositoryPath: string, localSource: boolean): Promise<void> {
    try {
      await access(join(repositoryPath, 'node_modules'));
      return;
    } catch {
      if (localSource) {
        throw new AppError('ICON_BATCH_DEPENDENCIES_MISSING', 'The configured local Stage 1 source directory has no node_modules directory. Run npm ci there before starting the platform.', 500);
      }
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
