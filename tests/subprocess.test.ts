import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SubprocessTimeoutError, runSubprocess } from '../src/subprocess.js';

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a timed out subprocess terminates its exact descendant tree and later calls still run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pink-subprocess-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childPidPath = join(root, 'child.pid');
  const scriptPath = join(root, 'hang.cjs');
  await writeFile(scriptPath, [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'), 'utf8');

  const startedAt = Date.now();
  await assert.rejects(
    runSubprocess(process.execPath, [scriptPath], { timeoutMs: 300 }),
    (error: unknown) => error instanceof SubprocessTimeoutError && error.timeoutMs === 300,
  );
  assert.ok(Date.now() - startedAt < 5_000);
  await waitForFile(childPidPath);
  const childPid = Number(await readFile(childPidPath, 'utf8'));
  assert.equal(processExists(childPid), false);

  const result = await runSubprocess(process.execPath, ['-e', "process.stdout.write('ok')"], { timeoutMs: 1_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ok');
});
