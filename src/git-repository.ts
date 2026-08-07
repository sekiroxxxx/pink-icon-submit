import { spawn } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { AppError, sanitizeDiagnosticText } from './errors.js';
import type { ExecutionMode } from './types.js';

export interface GitCommitIdentity {
  name: string;
  email: string;
}

export interface GitHubTokenAuthentication {
  username: string;
  token: string;
}

export interface GitRepositoryOptions {
  mode: ExecutionMode;
  targetRemote?: string;
  targetBranch?: string;
  remoteAuthentication?: GitHubTokenAuthentication;
  localTargetRef?: string;
}

function gitOperation(args: string[]): string {
  const command = args.find((argument) => [
    'fetch', 'rev-parse', 'remote', 'ls-remote', 'add', 'diff', 'commit', 'push', 'worktree', 'status',
  ].includes(argument));
  return `git ${command ?? 'command'}`;
}

export class GitRepository {
  constructor(
    private readonly repositoryPath: string,
    private readonly temporaryRoot: string,
    private readonly options: GitRepositoryOptions,
  ) {}

  async withBaseWorktree<T>(callback: (worktreePath: string) => Promise<T>): Promise<T> {
    return this.withWorktreeAt(await this.resolveBaseCommit(), callback);
  }

  async resolveBaseCommit(): Promise<string> {
    if (this.options.mode === 'local') {
      if (!this.options.localTargetRef) {
        throw new AppError('GIT_CONFIGURATION_INVALID', 'Local execution requires a configured local target ref.', 500);
      }
      return this.git(['-C', this.repositoryPath, 'rev-parse', this.options.localTargetRef]).then((output) => output.trim());
    }
    if (!this.options.targetRemote || !this.options.targetBranch) {
      throw new AppError('GIT_CONFIGURATION_INVALID', 'Remote execution requires a target remote and branch.', 500);
    }
    await this.withAuthentication(this.options.remoteAuthentication, (environment) => this.git([
      '-C', this.repositoryPath,
      'fetch', this.options.targetRemote!,
    ], environment));
    return this.git(['-C', this.repositoryPath, 'rev-parse', `${this.options.targetRemote}/${this.options.targetBranch}`]).then((output) => output.trim());
  }

  remoteUrl(remote: string): Promise<string> {
    return this.git(['-C', this.repositoryPath, 'remote', 'get-url', remote]).then((output) => output.trim());
  }

  async remoteBranchHead(remote: string, branch: string, authentication?: GitHubTokenAuthentication): Promise<string | null> {
    const output = await this.withAuthentication(authentication, (environment) => this.git([
      '-C', this.repositoryPath,
      'ls-remote', '--heads', remote, `refs/heads/${branch}`,
    ], environment));
    const match = /^([0-9a-f]{40})\s+refs\/heads\//m.exec(output);
    return match ? match[1] : null;
  }

  async commitPlannedChanges(
    worktreePath: string,
    expectedFiles: string[],
    identity: GitCommitIdentity,
    subject: string,
    body: string,
  ): Promise<string> {
    if (expectedFiles.length === 0) {
      throw new AppError('DIFF_EMPTY', 'Refusing to commit an empty planned diff.', 502);
    }
    await this.git(['-C', worktreePath, 'add', '--all', '--', ...expectedFiles]);
    const stagedFiles = (await this.git(['-C', worktreePath, 'diff', '--cached', '--name-only', '-z']))
      .split('\0')
      .filter(Boolean)
      .sort();
    const expected = [...new Set(expectedFiles)].sort();
    if (stagedFiles.length !== expected.length || stagedFiles.some((file, index) => file !== expected[index])) {
      throw new AppError('COMMIT_ALLOWLIST_VIOLATION', 'Staged files do not match plan.allowedFiles.', 502, {
        expectedFiles: expected,
        stagedFiles,
      });
    }
    await this.git([
      '-C', worktreePath,
      '-c', `user.name=${identity.name}`,
      '-c', `user.email=${identity.email}`,
      'commit', '--no-verify', '--no-gpg-sign', '-m', subject, '-m', body,
    ]);
    return this.head(worktreePath);
  }

  async pushCommit(
    remote: string,
    branch: string,
    commitSha: string,
    authentication?: GitHubTokenAuthentication,
  ): Promise<void> {
    await this.withAuthentication(authentication, (environment) => this.git([
      '-C', this.repositoryPath,
      'push', '--porcelain', remote, `${commitSha}:refs/heads/${branch}`,
    ], environment));
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

  private async withAuthentication<T>(authentication: GitHubTokenAuthentication | undefined, callback: (environment: NodeJS.ProcessEnv | undefined) => Promise<T>): Promise<T> {
    if (!authentication) {
      return callback(undefined);
    }
    const askPassDirectory = join(this.temporaryRoot, `askpass-${randomUUID()}`);
    const askPassScript = join(askPassDirectory, 'askpass.cjs');
    const askPassCommand = join(askPassDirectory, process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh');
    await mkdir(askPassDirectory, { recursive: true });
    await writeFile(askPassScript, "const prompt = process.argv.slice(2).join(' ');\nprocess.stdout.write(/username/i.test(prompt) ? (process.env.PINK_ICON_GIT_ASKPASS_USERNAME ?? '') : (process.env.PINK_ICON_GIT_ASKPASS_TOKEN ?? ''));\n", 'utf8');
    if (process.platform === 'win32') {
      await writeFile(askPassCommand, `@echo off\r\n"${process.execPath}" "${askPassScript}" %*\r\n`, 'utf8');
    } else {
      await writeFile(askPassCommand, `#!/bin/sh\n"${process.execPath}" "${askPassScript}" "$@"\n`, { encoding: 'utf8', mode: 0o700 });
      await chmod(askPassCommand, 0o700);
    }
    try {
      return await callback({
        ...process.env,
        GIT_ASKPASS: askPassCommand,
        GIT_TERMINAL_PROMPT: '0',
        PINK_ICON_GIT_ASKPASS_USERNAME: authentication.username,
        PINK_ICON_GIT_ASKPASS_TOKEN: authentication.token,
      });
    } finally {
      await rm(askPassDirectory, { recursive: true, force: true });
    }
  }

  private async git(args: string[], environment?: NodeJS.ProcessEnv): Promise<string> {
    const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      const processHandle = spawn('git', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(environment ? { env: environment } : {}),
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
    if (result.exitCode !== 0) {
      throw new AppError('GIT_COMMAND_FAILED', 'Git command failed.', 502, {
        operation: gitOperation(args),
        command: sanitizeDiagnosticText(['git', ...args].join(' '), 1_000),
        exitCode: result.exitCode,
        stderr: sanitizeDiagnosticText(result.stderr),
      });
    }
    return result.stdout;
  }
}
