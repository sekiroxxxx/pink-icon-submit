import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AppError } from '../src/errors.js';
import { IconBatchCli } from '../src/icon-batch-cli.js';

const secretNames = [
  'PINK_ICON_GITHUB_TOKEN',
  'PINK_ICON_BOOTSTRAP_PASSWORD',
  'PINK_ICON_CATALOG_AUTH_TOKEN',
] as const;

test('Stage 1 and npm children receive only the runtime environment allowlist', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pink-icon-cli-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts');
  await mkdir(scripts, { recursive: true });
  const stageScript = join(scripts, 'icon-batch.mjs');
  const npmCapture = join(root, 'npm-env.json');
  const npmScript = join(root, 'fake-npm.cjs');
  await writeFile(stageScript, "process.stdout.write(JSON.stringify({ env: process.env }));\n", 'utf8');
  await writeFile(npmScript, [
    "const { mkdirSync, writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(npmCapture)}, JSON.stringify(process.env));`,
    `mkdirSync(${JSON.stringify(join(root, 'node_modules'))}, { recursive: true });`,
  ].join('\n'), 'utf8');

  const previous = new Map<string, string | undefined>();
  for (const name of secretNames) {
    previous.set(name, process.env[name]);
    process.env[name] = `synthetic-${name.toLowerCase()}`;
  }
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const cli = new IconBatchCli({ timeoutMs: 2_000 }, process.execPath, npmScript);
  const result = await cli.catalog(root);
  const stageEnvironment = result.payload.env as NodeJS.ProcessEnv;
  const npmEnvironment = JSON.parse(await (await import('node:fs/promises')).readFile(npmCapture, 'utf8')) as NodeJS.ProcessEnv;
  for (const environment of [stageEnvironment, npmEnvironment]) {
    for (const name of secretNames) assert.equal(environment[name], undefined);
    assert.ok(environment.PATH ?? environment.Path);
    assert.ok(environment.TEMP ?? environment.TMP ?? environment.TMPDIR);
  }
});

test('Stage 1 timeout is explicit and a later invocation can complete', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pink-icon-cli-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await mkdir(scripts, { recursive: true });
  const stageScript = join(scripts, 'icon-batch.mjs');
  await writeFile(stageScript, 'setInterval(() => {}, 1000);\n', 'utf8');
  const cli = new IconBatchCli({ timeoutMs: 200 });

  await assert.rejects(
    cli.catalog(root),
    (error: unknown) => error instanceof AppError && error.code === 'ICON_BATCH_COMMAND_TIMEOUT',
  );
  await writeFile(stageScript, "process.stdout.write(JSON.stringify({ valid: true }));\n", 'utf8');
  assert.equal((await cli.catalog(root)).payload.valid, true);
});

test('npm dependency installation timeout is explicit and a later invocation can complete', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pink-icon-cli-npm-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts');
  await mkdir(scripts, { recursive: true });
  await writeFile(join(scripts, 'icon-batch.mjs'), "process.stdout.write(JSON.stringify({ valid: true }));\n", 'utf8');
  const npmScript = join(root, 'fake-npm.cjs');
  await writeFile(npmScript, 'setInterval(() => {}, 1000);\n', 'utf8');
  const cli = new IconBatchCli({ timeoutMs: 200 }, process.execPath, npmScript);

  await assert.rejects(
    cli.catalog(root),
    (error: unknown) => error instanceof AppError && error.code === 'ICON_BATCH_DEPENDENCY_INSTALL_TIMEOUT',
  );
  await writeFile(npmScript, `require('node:fs').mkdirSync(${JSON.stringify(join(root, 'node_modules'))}, { recursive: true });\n`, 'utf8');
  assert.equal((await cli.catalog(root)).payload.valid, true);
});
