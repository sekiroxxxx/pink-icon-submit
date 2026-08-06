import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Parser } from 'tar';

import { AppError, isAppError } from './errors.js';
import type { CatalogBaseline, NpmCatalogIcon, NpmCatalogSnapshot, NpmPackageCatalogOptions } from './types.js';

const cacheSchemaVersion = 1;
const maximumCatalogEntryBytes = 1024 * 1024;
const maximumCatalogArchiveBytes = 16 * 1024 * 1024;

interface ResolvedPackage {
  baseline: CatalogBaseline;
  tarballUrl: string;
}

interface CachedResolution {
  schemaVersion: 1;
  baseline: CatalogBaseline;
  tarballUrl: string;
}

interface CachedSnapshot {
  schemaVersion: 1;
  baseline: CatalogBaseline;
  icons: NpmCatalogIcon[];
}

interface PackageMetadata {
  'dist-tags'?: unknown;
  versions?: unknown;
}

interface PackageVersionMetadata {
  dist?: unknown;
  gitHead?: unknown;
}

interface PackageDistMetadata {
  integrity?: unknown;
  tarball?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('CATALOG_INVALID', `npm catalog ${field} is invalid.`, 502);
  }
  return value;
}

function validIconName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\s/\\]/.test(value);
}

function cacheKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function integrityDigest(integrity: string): Buffer {
  const match = integrity.split(/\s+/).map((entry) => entry.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)).find(Boolean);
  if (!match) {
    throw new AppError('CATALOG_INTEGRITY_INVALID', 'npm catalog dist.integrity must include a sha512 SRI value.', 502);
  }
  return Buffer.from(match[1], 'base64');
}

function verifyIntegrity(tarball: Buffer, integrity: string): void {
  const expected = integrityDigest(integrity);
  const actual = createHash('sha512').update(tarball).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new AppError('CATALOG_INTEGRITY_MISMATCH', 'Downloaded npm catalog tarball does not match its SRI integrity.', 502);
  }
}

function catalogGroup(primaryName: string): NpmCatalogIcon['group'] {
  if (primaryName.startsWith('pink-')) {
    return 'pink';
  }
  if (primaryName.startsWith('toolbar-')) {
    return 'toolbar';
  }
  return 'common';
}

function parseBaseline(value: unknown): CatalogBaseline {
  if (!isObject(value)) {
    throw new AppError('CATALOG_CACHE_INVALID', 'Cached npm catalog baseline is invalid.', 502);
  }
  const sourceCommit = requiredString(value.sourceCommit, 'sourceCommit');
  if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) {
    throw new AppError('CATALOG_CACHE_INVALID', 'Cached npm catalog sourceCommit is invalid.', 502);
  }
  return {
    packageName: requiredString(value.packageName, 'packageName'),
    requestedTag: requiredString(value.requestedTag, 'requestedTag'),
    version: requiredString(value.version, 'version'),
    integrity: requiredString(value.integrity, 'integrity'),
    sourceRepository: requiredString(value.sourceRepository, 'sourceRepository'),
    sourceCommit,
  };
}

function sameBaseline(left: CatalogBaseline, right: CatalogBaseline): boolean {
  return left.packageName === right.packageName
    && left.requestedTag === right.requestedTag
    && left.version === right.version
    && left.integrity === right.integrity
    && left.sourceRepository === right.sourceRepository
    && left.sourceCommit === right.sourceCommit;
}

function parseCachedSnapshot(value: unknown, expected: CatalogBaseline): NpmCatalogSnapshot {
  if (!isObject(value) || value.schemaVersion !== cacheSchemaVersion || !Array.isArray(value.icons)) {
    throw new AppError('CATALOG_CACHE_INVALID', 'Cached npm catalog snapshot is invalid.', 502);
  }
  const baseline = parseBaseline(value.baseline);
  if (!sameBaseline(baseline, expected)) {
    throw new AppError('CATALOG_CACHE_INVALID', 'Cached npm catalog snapshot does not match the resolved package.', 502);
  }
  const names = new Set<string>();
  const icons = value.icons.map((entry): NpmCatalogIcon => {
    if (!isObject(entry)) {
      throw new AppError('CATALOG_CACHE_INVALID', 'Cached npm catalog icon is invalid.', 502);
    }
    const primaryName = requiredString(entry.primaryName, 'icon.primaryName');
    const sourceName = requiredString(entry.sourceName, 'icon.sourceName');
    if (!Array.isArray(entry.aliases) || !entry.aliases.every(validIconName)) {
      throw new AppError('CATALOG_CACHE_INVALID', 'Cached npm catalog aliases are invalid.', 502);
    }
    if (typeof entry.codepoint !== 'number' || !Number.isSafeInteger(entry.codepoint) || entry.codepoint < 0) {
      throw new AppError('CATALOG_CACHE_INVALID', 'Cached npm catalog codepoint is invalid.', 502);
    }
    if (entry.group !== 'pink' && entry.group !== 'toolbar' && entry.group !== 'common') {
      throw new AppError('CATALOG_CACHE_INVALID', 'Cached npm catalog icon group is invalid.', 502);
    }
    const svg = requiredString(entry.svg, 'icon.svg');
    if (!validIconName(primaryName) || !validIconName(sourceName) || !entry.aliases.includes(primaryName)) {
      throw new AppError('CATALOG_CACHE_INVALID', 'Cached npm catalog names are invalid.', 502);
    }
    for (const name of entry.aliases) {
      if (names.has(name)) {
        throw new AppError('CATALOG_CACHE_INVALID', `Cached npm catalog name is duplicated: ${name}.`, 502);
      }
      names.add(name);
    }
    return { primaryName, sourceName, aliases: [...entry.aliases], codepoint: entry.codepoint, group: entry.group, svg };
  });
  return { baseline, icons: icons.sort((left, right) => left.primaryName.localeCompare(right.primaryName)) };
}

function mappingIcons(mapping: unknown, svgByName: Map<string, string>): NpmCatalogIcon[] {
  if (!isObject(mapping)) {
    throw new AppError('CATALOG_MAPPING_INVALID', 'npm catalog mapping.json must be an object.', 502);
  }
  const names = new Set<string>();
  const icons: NpmCatalogIcon[] = [];
  for (const [codepointText, aliasesValue] of Object.entries(mapping)) {
    if (!/^\d+$/.test(codepointText)) {
      throw new AppError('CATALOG_MAPPING_INVALID', `npm catalog codepoint is invalid: ${codepointText}.`, 502);
    }
    const codepoint = Number(codepointText);
    if (!Number.isSafeInteger(codepoint) || codepoint < 0) {
      throw new AppError('CATALOG_MAPPING_INVALID', `npm catalog codepoint is invalid: ${codepointText}.`, 502);
    }
    if (!Array.isArray(aliasesValue) || aliasesValue.length === 0 || !aliasesValue.every(validIconName)) {
      throw new AppError('CATALOG_MAPPING_INVALID', `npm catalog aliases are invalid for codepoint ${codepointText}.`, 502);
    }
    const aliases = [...aliasesValue];
    if (new Set(aliases).size !== aliases.length) {
      throw new AppError('CATALOG_MAPPING_INVALID', `npm catalog aliases are duplicated for codepoint ${codepointText}.`, 502);
    }
    for (const name of aliases) {
      if (names.has(name)) {
        throw new AppError('CATALOG_MAPPING_INVALID', `npm catalog name is duplicated: ${name}.`, 502);
      }
      names.add(name);
    }
    const sourceNames = aliases.filter((name) => svgByName.has(name));
    if (sourceNames.length !== 1) {
      throw new AppError('CATALOG_MAPPING_INVALID', `Codepoint ${codepointText} must resolve to exactly one SVG source among its aliases.`, 502);
    }
    const primaryName = aliases[0];
    const sourceName = sourceNames[0];
    icons.push({
      primaryName,
      sourceName,
      aliases,
      codepoint,
      group: catalogGroup(primaryName),
      svg: svgByName.get(sourceName)!,
    });
  }
  return icons.sort((left, right) => left.primaryName.localeCompare(right.primaryName));
}

async function readTarballEntries(tarball: Buffer): Promise<{ mapping: Buffer; svgByName: Map<string, string> }> {
  let mapping: Buffer | undefined;
  const svgByName = new Map<string, string>();
  let totalBytes = 0;
  let failure: Error | undefined;
  const parser = new Parser({ strict: true, maxDecompressionRatio: 100 });

  try {
    await new Promise<void>((resolve, reject) => {
      parser.on('error', reject);
      parser.on('end', resolve);
      parser.on('entry', (entry) => {
        const mappingEntry = entry.path === 'package/src/template/mapping.json';
        const svgMatch = entry.path.match(/^package\/src\/icons\/([^/\\]+)\.svg$/);
        const shouldCollect = entry.type === 'File' && (mappingEntry || svgMatch);
        const chunks: Buffer[] = [];
        let entryBytes = 0;
        entry.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          entryBytes += chunk.length;
          if (!failure && (totalBytes > maximumCatalogArchiveBytes || (shouldCollect && entryBytes > maximumCatalogEntryBytes))) {
            failure = new Error('npm catalog archive exceeds the allowed size.');
            parser.abort(failure);
            return;
          }
          if (shouldCollect) {
            chunks.push(Buffer.from(chunk));
          }
        });
        entry.on('end', () => {
          if (failure || !shouldCollect) {
            return;
          }
          const content = Buffer.concat(chunks);
          if (mappingEntry) {
            if (mapping) {
              failure = new Error('npm catalog archive contains mapping.json more than once.');
              parser.abort(failure);
              return;
            }
            mapping = content;
            return;
          }
          const sourceName = svgMatch![1];
          if (svgByName.has(sourceName)) {
            failure = new Error(`npm catalog archive contains ${sourceName}.svg more than once.`);
            parser.abort(failure);
            return;
          }
          svgByName.set(sourceName, content.toString('utf8'));
        });
        entry.resume();
      });
      parser.end(tarball);
    });
  } catch (error) {
    throw new AppError('CATALOG_ARCHIVE_INVALID', failure?.message ?? (error instanceof Error ? error.message : 'Unable to parse npm catalog archive.'), 502);
  }

  if (failure) {
    throw new AppError('CATALOG_ARCHIVE_INVALID', failure.message, 502);
  }
  if (!mapping) {
    throw new AppError('CATALOG_ARCHIVE_INVALID', 'npm catalog archive does not contain src/template/mapping.json.', 502);
  }
  return { mapping, svgByName };
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function writeBufferAtomically(path: string, value: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, value);
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export class NpmPackageCatalog {
  private snapshot: NpmCatalogSnapshot | undefined;
  private inFlight: Promise<NpmCatalogSnapshot> | undefined;
  private lastResolvedAt = 0;

  constructor(
    private readonly options: NpmPackageCatalogOptions,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  invalidate(): void {
    this.lastResolvedAt = 0;
  }

  async latest(): Promise<NpmCatalogSnapshot> {
    if (this.snapshot && this.now() - this.lastResolvedAt < this.options.refreshIntervalMs) {
      return this.snapshot;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    const load = this.loadLatest();
    this.inFlight = load;
    try {
      const snapshot = await load;
      this.snapshot = snapshot;
      this.lastResolvedAt = this.now();
      return snapshot;
    } finally {
      if (this.inFlight === load) {
        this.inFlight = undefined;
      }
    }
  }

  async cachedTarballPath(baseline: CatalogBaseline): Promise<string> {
    const tarball = await this.readCachedTarball(baseline);
    if (!tarball) {
      throw new AppError('CATALOG_TARBALL_CACHE_MISSING', `The cached npm catalog tarball for ${baseline.packageName}@${baseline.version} is unavailable. Create a new batch after refreshing the catalog.`, 409);
    }
    return this.tarballPath(baseline.integrity);
  }

  private async loadLatest(): Promise<NpmCatalogSnapshot> {
    const resolved = await this.resolvePackage();
    if (this.snapshot && sameBaseline(this.snapshot.baseline, resolved.baseline)) {
      await this.ensureCachedTarball(resolved);
      return this.snapshot;
    }
    const cached = await this.readSnapshot(resolved.baseline);
    if (cached) {
      await this.ensureCachedTarball(resolved);
      return cached;
    }
    const tarball = await this.ensureCachedTarball(resolved);
    const entries = await readTarballEntries(tarball);
    let mapping: unknown;
    try {
      mapping = JSON.parse(entries.mapping.toString('utf8'));
    } catch {
      throw new AppError('CATALOG_MAPPING_INVALID', 'npm catalog mapping.json is not valid JSON.', 502);
    }
    const snapshot: NpmCatalogSnapshot = {
      baseline: resolved.baseline,
      icons: mappingIcons(mapping, entries.svgByName),
    };
    await this.writeSnapshot(snapshot);
    return snapshot;
  }

  private async ensureCachedTarball(resolved: ResolvedPackage): Promise<Buffer> {
    const cached = await this.readCachedTarball(resolved.baseline);
    if (cached) {
      return cached;
    }
    const response = await this.fetchCatalogTarball(resolved.tarballUrl);
    const tarball = Buffer.from(await response.arrayBuffer());
    verifyIntegrity(tarball, resolved.baseline.integrity);
    await writeBufferAtomically(this.tarballPath(resolved.baseline.integrity), tarball);
    return tarball;
  }

  private async resolvePackage(): Promise<ResolvedPackage> {
    try {
      const response = await this.fetchImplementation(`${this.registryUrl()}/${encodeURIComponent(this.options.packageName)}`, {
        headers: this.requestHeaders(this.registryUrl()),
      });
      if (!response.ok) {
        throw new AppError('CATALOG_REGISTRY_UNAVAILABLE', `npm registry returned ${response.status} while resolving ${this.options.packageName}.`, 502);
      }
      const metadata = await response.json() as PackageMetadata;
      const resolved = this.resolveMetadata(metadata);
      await writeJsonAtomically(this.resolutionPath(), {
        schemaVersion: cacheSchemaVersion,
        baseline: resolved.baseline,
        tarballUrl: resolved.tarballUrl,
      } satisfies CachedResolution);
      return resolved;
    } catch (error) {
      if (isAppError(error) && error.code !== 'CATALOG_REGISTRY_UNAVAILABLE') {
        throw error;
      }
      const cached = await this.readCachedResolution();
      if (cached) {
        return cached;
      }
      if (isAppError(error)) {
        throw error;
      }
      throw new AppError('CATALOG_REGISTRY_UNAVAILABLE', `Unable to resolve npm catalog ${this.options.packageName}@${this.options.tag}.`, 502);
    }
  }

  private resolveMetadata(metadata: PackageMetadata): ResolvedPackage {
    if (!isObject(metadata['dist-tags']) || !isObject(metadata.versions)) {
      throw new AppError('CATALOG_REGISTRY_INVALID', `npm registry metadata for ${this.options.packageName} is invalid.`, 502);
    }
    const taggedVersion = metadata['dist-tags'][this.options.tag];
    const version = typeof taggedVersion === 'string'
      ? taggedVersion
      : Object.hasOwn(metadata.versions, this.options.tag) ? this.options.tag : undefined;
    if (!version || !isObject(metadata.versions[version])) {
      throw new AppError('CATALOG_TAG_NOT_FOUND', `npm catalog tag ${this.options.tag} is not available for ${this.options.packageName}.`, 502);
    }
    const versionMetadata = metadata.versions[version] as PackageVersionMetadata;
    if (!isObject(versionMetadata.dist)) {
      throw new AppError('CATALOG_REGISTRY_INVALID', `npm catalog version ${version} has no dist metadata.`, 502);
    }
    const dist = versionMetadata.dist as PackageDistMetadata;
    const integrity = requiredString(dist.integrity, 'dist.integrity');
    integrityDigest(integrity);
    const tarballUrl = requiredString(dist.tarball, 'dist.tarball');
    try {
      const url = new URL(tarballUrl);
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('unsupported protocol');
      }
    } catch {
      throw new AppError('CATALOG_REGISTRY_INVALID', `npm catalog tarball URL is invalid for ${version}.`, 502);
    }
    const sourceCommit = requiredString(versionMetadata.gitHead, 'gitHead');
    if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) {
      throw new AppError('CATALOG_REGISTRY_INVALID', `npm catalog gitHead is invalid for ${version}.`, 502);
    }
    return {
      baseline: {
        packageName: this.options.packageName,
        requestedTag: this.options.tag,
        version,
        integrity,
        sourceRepository: this.options.sourceRepository,
        sourceCommit,
      },
      tarballUrl,
    };
  }

  private async fetchCatalogTarball(tarballUrl: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImplementation(tarballUrl, { headers: this.requestHeaders(tarballUrl) });
    } catch {
      throw new AppError('CATALOG_TARBALL_UNAVAILABLE', 'Unable to download the npm catalog tarball.', 502);
    }
    if (!response.ok) {
      throw new AppError('CATALOG_TARBALL_UNAVAILABLE', `npm catalog tarball returned ${response.status}.`, 502);
    }
    return response;
  }

  private async readSnapshot(baseline: CatalogBaseline): Promise<NpmCatalogSnapshot | undefined> {
    try {
      const content = await readFile(this.snapshotPath(baseline.integrity), 'utf8');
      return parseCachedSnapshot(JSON.parse(content), baseline);
    } catch {
      return undefined;
    }
  }

  private async readCachedTarball(baseline: CatalogBaseline): Promise<Buffer | undefined> {
    try {
      const tarball = await readFile(this.tarballPath(baseline.integrity));
      verifyIntegrity(tarball, baseline.integrity);
      return tarball;
    } catch {
      return undefined;
    }
  }

  private async writeSnapshot(snapshot: NpmCatalogSnapshot): Promise<void> {
    await writeJsonAtomically(this.snapshotPath(snapshot.baseline.integrity), {
      schemaVersion: cacheSchemaVersion,
      baseline: snapshot.baseline,
      icons: snapshot.icons,
    } satisfies CachedSnapshot);
  }

  private async readCachedResolution(): Promise<ResolvedPackage | undefined> {
    try {
      const content = await readFile(this.resolutionPath(), 'utf8');
      const value = JSON.parse(content) as unknown;
      if (!isObject(value) || value.schemaVersion !== cacheSchemaVersion) {
        return undefined;
      }
      const baseline = parseBaseline(value.baseline);
      const tarballUrl = requiredString(value.tarballUrl, 'tarballUrl');
      if (baseline.packageName !== this.options.packageName || baseline.requestedTag !== this.options.tag || baseline.sourceRepository !== this.options.sourceRepository) {
        return undefined;
      }
      return { baseline, tarballUrl };
    } catch {
      return undefined;
    }
  }

  private registryUrl(): string {
    return this.options.registryUrl.replace(/\/$/, '');
  }

  private requestHeaders(url: string): Record<string, string> {
    const headers = { accept: 'application/json' };
    if (!this.options.authToken) {
      return headers;
    }
    try {
      if (new URL(url).origin === new URL(this.registryUrl()).origin) {
        return { ...headers, authorization: `Bearer ${this.options.authToken}` };
      }
    } catch {
      // URL shape is validated before this method is reached.
    }
    return headers;
  }

  private resolutionPath(): string {
    return join(this.options.cacheRoot, 'resolutions', `${cacheKey(`${this.options.packageName}\u0000${this.options.tag}`)}.json`);
  }

  private snapshotPath(integrity: string): string {
    return join(this.options.cacheRoot, 'snapshots', cacheKey(integrity), 'catalog.json');
  }

  private tarballPath(integrity: string): string {
    return join(this.options.cacheRoot, 'tarballs', `${cacheKey(integrity)}.tgz`);
  }
}
