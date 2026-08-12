import { spawn, type ChildProcess } from 'node:child_process';

const inheritedEnvironmentNames = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'NO_COLOR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;

export interface SubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SubprocessOptions {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export class SubprocessTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Subprocess exceeded its ${timeoutMs}ms deadline.`);
    this.name = 'SubprocessTimeoutError';
  }
}

export function subprocessEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of inheritedEnvironmentNames) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...overrides };
}

async function waitForExit(processHandle: ChildProcess): Promise<void> {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  await new Promise<void>((resolve) => processHandle.once('close', () => resolve()));
}

async function terminateWindowsProcessTree(processHandle: ChildProcess, pid: number): Promise<void> {
  const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
    stdio: 'ignore',
    windowsHide: true,
    env: subprocessEnvironment(),
  });
  await new Promise<void>((resolve) => {
    killer.once('error', () => resolve());
    killer.once('close', () => resolve());
  });
  if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill('SIGKILL');
}

async function terminatePosixProcessTree(processHandle: ChildProcess, pid: number): Promise<void> {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    processHandle.kill('SIGTERM');
  }
  await Promise.race([
    waitForExit(processHandle),
    new Promise((resolve) => setTimeout(resolve, 250)),
  ]);
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    processHandle.kill('SIGKILL');
  }
}

async function terminateProcessTree(processHandle: ChildProcess): Promise<void> {
  const pid = processHandle.pid;
  if (pid === undefined || processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  if (process.platform === 'win32') await terminateWindowsProcessTree(processHandle, pid);
  else await terminatePosixProcessTree(processHandle, pid);
}

export function runSubprocess(executable: string, args: string[], options: SubprocessOptions): Promise<SubprocessResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new TypeError('Subprocess timeoutMs must be a positive finite number.');
  }
  return new Promise((resolve, reject) => {
    const processHandle = spawn(executable, args, {
      cwd: options.cwd,
      env: subprocessEnvironment(options.environment),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    processHandle.stdout?.setEncoding('utf8');
    processHandle.stderr?.setEncoding('utf8');
    processHandle.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    processHandle.stderr?.on('data', (chunk: string) => { stderr += chunk; });

    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(processHandle);
    }, options.timeoutMs);
    timer.unref();

    processHandle.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    processHandle.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new SubprocessTimeoutError(options.timeoutMs));
        return;
      }
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}
