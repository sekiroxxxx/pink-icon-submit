import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { create as createTar } from 'tar';

import { NpmPackageCatalog } from '../src/npm-package-catalog.js';
import type { NpmPackageCatalogOptions } from '../src/types.js';

const validSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h1v1H0z"/></svg>';

interface PackageRelease {
  version: string;
  sourceCommit: string;
  integrity: string;
  tarball: Buffer;
}

async function createTarball(t: test.TestContext, mapping: Record<string, string[]>, icons: Record<string, string>): Promise<Buffer> {
  const root = await mkdtemp(join(tmpdir(), 'pink-icon-submit-npm-catalog-'));
  const packageRoot = join(root, 'package');
  const tarballPath = join(root, 'catalog.tgz');
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(packageRoot, 'src/icons'), { recursive: true });
  await mkdir(join(packageRoot, 'src/template'), { recursive: true });
  await writeFile(join(packageRoot, 'src/template/mapping.json'), JSON.stringify(mapping));
  await Promise.all(Object.entries(icons).map(([name, svg]) => writeFile(join(packageRoot, 'src/icons', `${name}.svg`), svg)));
  await createTar({ cwd: root, file: tarballPath, gzip: true }, ['package']);
  return readFile(tarballPath);
}

function release(version: string, sourceCommit: string, tarball: Buffer): PackageRelease {
  return {
    version,
    sourceCommit,
    integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    tarball,
  };
}

function options(cacheRoot: string): NpmPackageCatalogOptions {
  return {
    packageName: '@pink/codicons',
    tag: 'beta',
    registryUrl: 'https://registry.example.invalid',
    sourceRepository: 'sud-global/pink-codicons',
    cacheRoot,
    refreshIntervalMs: 60_000,
  };
}

function registryFetch(current: () => PackageRelease, requests: { metadata: number; tarball: number }): typeof fetch {
  return async (input) => {
    const url = String(input);
    const currentRelease = current();
    if (url.includes('%40pink%2Fcodicons')) {
      requests.metadata += 1;
      return new Response(JSON.stringify({
        'dist-tags': { beta: currentRelease.version },
        versions: {
          [currentRelease.version]: {
            gitHead: currentRelease.sourceCommit,
            dist: {
              integrity: currentRelease.integrity,
              tarball: 'https://registry.example.invalid/tarballs/pink-codicons.tgz',
            },
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://registry.example.invalid/tarballs/pink-codicons.tgz') {
      requests.tarball += 1;
      return new Response(currentRelease.tarball, { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
}

async function cacheRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pink-icon-submit-npm-cache-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

test('reads a scoped beta package tarball into an immutable catalog snapshot', async (t) => {
  const tarball = await createTarball(t, { 50000: ['pink-existing', 'pink-existing-alias'] }, { 'pink-existing': validSvg });
  const currentRelease = release('0.0.46-test.1', 'a'.repeat(40), tarball);
  const requests = { metadata: 0, tarball: 0 };
  const catalog = new NpmPackageCatalog(options(await cacheRoot(t)), registryFetch(() => currentRelease, requests));

  const snapshot = await catalog.latest();

  assert.deepEqual(snapshot.baseline, {
    packageName: '@pink/codicons',
    requestedTag: 'beta',
    version: '0.0.46-test.1',
    integrity: currentRelease.integrity,
    sourceRepository: 'sud-global/pink-codicons',
    sourceCommit: 'a'.repeat(40),
  });
  assert.deepEqual(snapshot.icons, [{
    primaryName: 'pink-existing',
    sourceName: 'pink-existing',
    aliases: ['pink-existing', 'pink-existing-alias'],
    codepoint: 50000,
    group: 'pink',
    svg: validSvg,
  }]);
  assert.deepEqual(requests, { metadata: 1, tarball: 1 });
});

test('rejects a tarball whose bytes do not match the npm SRI integrity', async (t) => {
  const tarball = await createTarball(t, { 50000: ['existing'] }, { existing: validSvg });
  const validRelease = release('0.0.46-test.1', 'b'.repeat(40), tarball);
  const tampered = Buffer.from(tarball);
  tampered[tampered.length - 1] ^= 0x01;
  const requests = { metadata: 0, tarball: 0 };
  const catalog = new NpmPackageCatalog(options(await cacheRoot(t)), registryFetch(() => ({ ...validRelease, tarball: tampered }), requests));

  await assert.rejects(catalog.latest(), { code: 'CATALOG_INTEGRITY_MISMATCH' });
});

test('rejects mappings that cannot resolve exactly one SVG source', async (t) => {
  const tarball = await createTarball(t, { 50000: ['existing', 'existing-alias'] }, {});
  const currentRelease = release('0.0.46-test.1', 'c'.repeat(40), tarball);
  const requests = { metadata: 0, tarball: 0 };
  const catalog = new NpmPackageCatalog(options(await cacheRoot(t)), registryFetch(() => currentRelease, requests));

  await assert.rejects(catalog.latest(), { code: 'CATALOG_MAPPING_INVALID' });
});

test('reuses an integrity-addressed disk snapshot without downloading the tarball again', async (t) => {
  const tarball = await createTarball(t, { 50000: ['existing'] }, { existing: validSvg });
  const currentRelease = release('0.0.46-test.1', 'd'.repeat(40), tarball);
  const requests = { metadata: 0, tarball: 0 };
  const sharedOptions = options(await cacheRoot(t));

  await new NpmPackageCatalog(sharedOptions, registryFetch(() => currentRelease, requests)).latest();
  await new NpmPackageCatalog(sharedOptions, registryFetch(() => currentRelease, requests)).latest();

  assert.deepEqual(requests, { metadata: 2, tarball: 1 });
});

test('refreshes beta when the tag resolves to a new immutable package version', async (t) => {
  const firstTarball = await createTarball(t, { 50000: ['existing'] }, { existing: validSvg });
  const secondTarball = await createTarball(t, { 50001: ['pink-new'] }, { 'pink-new': validSvg });
  let currentRelease = release('0.0.46-test.1', 'e'.repeat(40), firstTarball);
  let currentTime = 0;
  const requests = { metadata: 0, tarball: 0 };
  const catalog = new NpmPackageCatalog(
    options(await cacheRoot(t)),
    registryFetch(() => currentRelease, requests),
    () => currentTime,
  );

  assert.equal((await catalog.latest()).baseline.version, '0.0.46-test.1');
  currentRelease = release('0.0.46-test.2', 'f'.repeat(40), secondTarball);
  currentTime = 60_000;
  const refreshed = await catalog.latest();

  assert.equal(refreshed.baseline.version, '0.0.46-test.2');
  assert.equal(refreshed.icons[0].primaryName, 'pink-new');
  assert.deepEqual(requests, { metadata: 2, tarball: 2 });
});
