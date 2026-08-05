import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { AppError } from './errors.js';
import type { IconBatchResult } from './types.js';

export class IconBatchCli {
  constructor(private readonly nodeExecutable = process.execPath) {}

  catalog(repositoryPath: string): Promise<IconBatchResult> {
    return this.run(['catalog', '--repo', repositoryPath], repositoryPath, [0]);
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

  private async run(args: string[], cwd: string, acceptedExitCodes: number[]): Promise<IconBatchResult> {
    const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      const processHandle = spawn(this.nodeExecutable, [join(cwd, 'scripts', 'icon-batch.mjs'), ...args], {
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
}
