import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AppError } from '../src/errors.js';
import { RuntimeLease } from '../src/runtime-lease.js';

test('a data directory has exactly one live service owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pink-runtime-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'runtime.sqlite');
  const first = RuntimeLease.acquire(path);
  t.after(() => first.close());

  assert.throws(
    () => RuntimeLease.acquire(path),
    (error: unknown) => error instanceof AppError && error.code === 'RUNTIME_ALREADY_RUNNING',
  );

  first.close();
  const replacement = RuntimeLease.acquire(path);
  replacement.close();
});
