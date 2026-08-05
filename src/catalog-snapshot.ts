import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { AppError } from './errors.js';
import { GitRepository } from './git-repository.js';
import { IconBatchCli } from './icon-batch-cli.js';
import type { CatalogGroup, CatalogPage, CatalogPageIcon, CatalogPageInput, IconNamePreview } from './types.js';

interface CatalogIconSnapshot extends CatalogPageIcon {
  sourceName: string;
}

interface CatalogSnapshot {
  baseCommit: string;
  icons: CatalogIconSnapshot[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('CATALOG_INVALID', `Catalog ${field} is invalid.`, 502);
  }
  return value;
}

function readAliases(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((alias) => typeof alias === 'string')) {
    throw new AppError('CATALOG_INVALID', 'Catalog aliases are invalid.', 502);
  }
  return value;
}

function namePreview(payload: Record<string, unknown>, baseCommit: string, input: string): IconNamePreview {
  if (payload.schemaVersion !== 1 || payload.baseCommit !== baseCommit || payload.input !== input) {
    throw new AppError('NAME_PREVIEW_INVALID', 'Name preview does not match the requested repository state.', 502);
  }
  if (typeof payload.normalizedName !== 'string') {
    throw new AppError('NAME_PREVIEW_INVALID', 'Name preview normalizedName is invalid.', 502);
  }
  const normalizedName = payload.normalizedName;
  if (typeof payload.valid !== 'boolean') {
    throw new AppError('NAME_PREVIEW_INVALID', 'Name preview valid flag is invalid.', 502);
  }
  if (payload.collision === null) {
    return { schemaVersion: 1, baseCommit, input, normalizedName, valid: payload.valid, collision: null };
  }
  if (!isObject(payload.collision)) {
    throw new AppError('NAME_PREVIEW_INVALID', 'Name preview collision is invalid.', 502);
  }
  return {
    schemaVersion: 1,
    baseCommit,
    input,
    normalizedName,
    valid: payload.valid,
    collision: {
      primaryName: requiredString(payload.collision.primaryName, 'collision.primaryName'),
      aliases: readAliases(payload.collision.aliases),
    },
  };
}

function iconGroup(primaryName: string): Exclude<CatalogGroup, 'all'> {
  if (primaryName.startsWith('pink-')) {
    return 'pink';
  }
  if (primaryName.startsWith('toolbar-')) {
    return 'toolbar';
  }
  return 'common';
}

function safeIconPath(worktreePath: string, sourceFile: string): string {
  if (!sourceFile.startsWith('src/icons/') || !sourceFile.endsWith('.svg')) {
    throw new AppError('CATALOG_ICON_INVALID', `Catalog source path is invalid for ${sourceFile}.`, 502);
  }
  const root = resolve(worktreePath);
  const sourcePath = resolve(root, sourceFile);
  const pathFromRoot = relative(root, sourcePath);
  if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new AppError('CATALOG_ICON_INVALID', `Catalog source path escapes the worktree for ${sourceFile}.`, 502);
  }
  return sourcePath;
}

export class CatalogSnapshotCache {
  private snapshot: CatalogSnapshot | undefined;
  private inFlight: Promise<CatalogSnapshot> | undefined;
  private readonly namePreviews = new Map<string, IconNamePreview>();

  constructor(
    private readonly repository: GitRepository,
    private readonly iconBatch: IconBatchCli,
  ) {}

  invalidate(): void {
    this.snapshot = undefined;
    this.namePreviews.clear();
  }

  async page(input: CatalogPageInput): Promise<CatalogPage> {
    const snapshot = await this.latestSnapshot();
    const query = input.query?.trim().toLocaleLowerCase() ?? '';
    const group = input.group ?? 'all';
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 24;
    const filtered = snapshot.icons.filter((icon) => {
      if (group !== 'all' && icon.group !== group) {
        return false;
      }
      return !query || [icon.primaryName, ...icon.aliases].some((name) => name.toLocaleLowerCase().includes(query));
    });
    const start = (page - 1) * pageSize;
    return {
      baseCommit: snapshot.baseCommit,
      page,
      pageSize,
      total: filtered.length,
      icons: filtered.slice(start, start + pageSize).map(({ primaryName, aliases, group: iconGroupValue, svg }) => ({
        primaryName,
        aliases,
        group: iconGroupValue,
        svg,
      })),
    };
  }

  async canonicalName(name: string): Promise<string> {
    const snapshot = await this.latestSnapshot();
    const icon = snapshot.icons.find((candidate) => candidate.primaryName === name || candidate.aliases.includes(name));
    if (!icon) {
      throw new AppError('CATALOG_ICON_NOT_FOUND', `Unknown catalog icon: ${name}`, 404);
    }
    return icon.primaryName;
  }

  async previewName(input: string): Promise<IconNamePreview> {
    const snapshot = await this.latestSnapshot();
    const cacheKey = `${snapshot.baseCommit}\u0000${input}`;
    const cached = this.namePreviews.get(cacheKey);
    if (cached) {
      return cached;
    }
    const preview = await this.repository.withWorktreeAt(snapshot.baseCommit, async (worktreePath) => {
      const result = await this.iconBatch.namePreview(worktreePath, input);
      return namePreview(result.payload, snapshot.baseCommit, input);
    });
    this.namePreviews.set(cacheKey, preview);
    return preview;
  }

  async svg(name: string): Promise<Buffer> {
    const snapshot = await this.latestSnapshot();
    const icon = snapshot.icons.find((candidate) => candidate.primaryName === name || candidate.aliases.includes(name));
    if (!icon) {
      throw new AppError('CATALOG_ICON_NOT_FOUND', `Unknown catalog icon: ${name}`, 404);
    }
    return Buffer.from(icon.svg, 'utf8');
  }

  private async latestSnapshot(): Promise<CatalogSnapshot> {
    const upstreamCommit = await this.repository.fetchUpstreamHead();
    if (this.snapshot?.baseCommit === upstreamCommit) {
      return this.snapshot;
    }
    if (this.inFlight) {
      const pending = await this.inFlight;
      if (pending.baseCommit === upstreamCommit) {
        return pending;
      }
    }
    const build = this.buildSnapshot(upstreamCommit);
    this.inFlight = build;
    try {
      const snapshot = await build;
      this.snapshot = snapshot;
      return snapshot;
    } finally {
      if (this.inFlight === build) {
        this.inFlight = undefined;
      }
    }
  }

  private async buildSnapshot(baseCommit: string): Promise<CatalogSnapshot> {
    return this.repository.withWorktreeAt(baseCommit, async (worktreePath) => {
      const catalog = (await this.iconBatch.catalog(worktreePath)).payload;
      if (catalog.baseCommit !== baseCommit) {
        throw new AppError('CATALOG_BASE_COMMIT_MISMATCH', 'Catalog does not match the requested upstream commit.', 502);
      }
      if (!Array.isArray(catalog.icons)) {
        throw new AppError('CATALOG_INVALID', 'Catalog icons are invalid.', 502);
      }
      const seen = new Set<string>();
      const icons = await Promise.all(catalog.icons.map(async (entry): Promise<CatalogIconSnapshot> => {
        if (!isObject(entry)) {
          throw new AppError('CATALOG_INVALID', 'Catalog icon entry is invalid.', 502);
        }
        const primaryName = requiredString(entry.primaryName, 'primaryName');
        if (seen.has(primaryName)) {
          throw new AppError('CATALOG_INVALID', `Catalog primary name is duplicated: ${primaryName}.`, 502);
        }
        seen.add(primaryName);
        const sourceName = requiredString(entry.sourceName, 'sourceName');
        const aliases = readAliases(entry.aliases);
        const sourceFile = requiredString(entry.sourceFile, 'sourceFile');
        const svg = await readFile(safeIconPath(worktreePath, sourceFile), 'utf8');
        return { primaryName, sourceName, aliases, group: iconGroup(primaryName), svg };
      }));
      return { baseCommit, icons: icons.sort((left, right) => left.primaryName.localeCompare(right.primaryName)) };
    });
  }
}
