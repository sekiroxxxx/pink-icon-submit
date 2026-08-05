import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { AppError } from './errors.js';

export class GitRepository {
  constructor(
    private readonly repositoryPath: string,
    private readonly temporaryRoot: string,
    private readonly upstreamRemote: string,
    private readonly upstreamBranch: string,
  ) {}

  async withLatestWorktree<T>(callback: (worktreePath: string) => Promise<T>): Promise<T> {
    const upstreamCommit = await this.fetchUpstreamHead();
    return this.withWorktreeAt(upstreamCommit, callback);
  }

  async fetchUpstreamHead(): Promise<string> {
    await this.git(['-C', this.repositoryPath, 'fetch', this.upstreamRemote]);
    return this.git(['-C', this.repositoryPath, 'rev-parse', `${this.upstreamRemote}/${this.upstreamBranch}`]).then((output) => output.trim());
  }

  async withWorktreeAt<T>(commit: string, callback: (worktreePath: string) => Promise<T>): Promise<T> {
    await mkdir(this.temporaryRoot, { recursive: true });
    const worktreePath = join(this.temporaryRoot, `worktree-${randomUUID()}`);
    await this.git(['-C', this.repositoryPath, 'worktree', 'add', '--detach', worktreePath, commit]);
    try {
      return await callback(worktreePath);
    } finally {
      try {
        await this.git(['-C', this.repositoryPath, 'worktree', 'remove', '--force', worktreePath]);
      } finally {
        await rm(worktreePath, { recursive: true, force: true });
      }
    }
  }

  async diffFiles(worktreePath: string): Promise<string[]> {
    const output = await this.git(['-C', worktreePath, 'status', '--porcelain=v1', '-z']);
    const entries = output.split('\0').filter(Boolean);
    const files: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const status = entry.slice(0, 2);
      files.push(entry.slice(3));
      if (status.includes('R') || status.includes('C')) {
        index += 1;
      }
    }
    return [...new Set(files)].sort();
  }

  diffPatch(worktreePath: string): Promise<string> {
    return this.git(['-C', worktreePath, 'diff', '--binary']);
  }

  head(worktreePath: string): Promise<string> {
    return this.git(['-C', worktreePath, 'rev-parse', 'HEAD']).then((stdout) => stdout.trim());
  }

  private async git(args: string[]): Promise<string> {
    const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      const processHandle = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      processHandle.stdout.setEncoding('utf8');
      processHandle.stderr.setEncoding('utf8');
      processHandle.stdout.on('data', (chunk: string) => { stdout += chunk; });
      processHandle.stderr.on('data', (chunk: string) => { stderr += chunk; });
      processHandle.once('error', reject);
      processHandle.once('close', (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
    });
    if (result.exitCode !== 0) {
      throw new AppError('GIT_COMMAND_FAILED', `git ${args.join(' ')} failed.`, 502, {
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }
    return result.stdout;
  }
}
