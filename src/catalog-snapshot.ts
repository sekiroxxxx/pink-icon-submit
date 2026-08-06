import { AppError } from './errors.js';
import { GitRepository } from './git-repository.js';
import { IconBatchCli } from './icon-batch-cli.js';
import { NpmPackageCatalog } from './npm-package-catalog.js';
import type { CatalogBaseline, CatalogPage, CatalogPageInput, IconNamePreview, NpmCatalogSnapshot, NpmPackageCatalogOptions } from './types.js';

interface TargetCatalogIcon {
  primaryName: string;
  aliases: string[];
}

interface TargetCatalogSnapshot {
  baseCommit: string;
  icons: TargetCatalogIcon[];
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

export class CatalogSnapshotCache {
  private targetSnapshot: TargetCatalogSnapshot | undefined;
  private targetInFlight: Promise<TargetCatalogSnapshot> | undefined;
  private readonly namePreviews = new Map<string, IconNamePreview>();
  private readonly npmCatalog: NpmPackageCatalog;

  constructor(
    private readonly repository: GitRepository,
    private readonly iconBatch: IconBatchCli,
    options: NpmPackageCatalogOptions,
  ) {
    this.npmCatalog = new NpmPackageCatalog(options);
  }

  invalidate(): void {
    this.targetSnapshot = undefined;
    this.namePreviews.clear();
    this.npmCatalog.invalidate();
  }

  async summary(): Promise<{ schemaVersion: 1; catalogBaseline: CatalogBaseline; total: number }> {
    const snapshot = await this.latestNpmSnapshot();
    return { schemaVersion: 1, catalogBaseline: snapshot.baseline, total: snapshot.icons.length };
  }

  async page(input: CatalogPageInput): Promise<CatalogPage> {
    const snapshot = await this.latestNpmSnapshot();
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
      catalogBaseline: snapshot.baseline,
      page,
      pageSize,
      total: filtered.length,
      icons: filtered.slice(start, start + pageSize).map(({ primaryName, aliases, group: iconGroup, svg }) => ({
        primaryName,
        aliases,
        group: iconGroup,
        svg,
      })),
    };
  }

  async canonicalName(name: string): Promise<string> {
    const snapshot = await this.latestTargetSnapshot();
    const icon = snapshot.icons.find((candidate) => candidate.primaryName === name || candidate.aliases.includes(name));
    if (!icon) {
      throw new AppError('CATALOG_ICON_NOT_FOUND', `Icon ${name} is not available on the current target branch. Refresh the catalog and choose an existing icon.`, 409);
    }
    return icon.primaryName;
  }

  async previewName(input: string): Promise<IconNamePreview> {
    const baseCommit = await this.repository.resolveBaseCommit();
    const cacheKey = `${baseCommit}\u0000${input}`;
    const cached = this.namePreviews.get(cacheKey);
    if (cached) {
      return cached;
    }
    const preview = await this.repository.withWorktreeAt(baseCommit, async (worktreePath) => {
      const result = await this.iconBatch.namePreview(worktreePath, input);
      return namePreview(result.payload, baseCommit, input);
    });
    this.namePreviews.set(cacheKey, preview);
    return preview;
  }

  async svg(name: string): Promise<Buffer> {
    const snapshot = await this.latestNpmSnapshot();
    const icon = snapshot.icons.find((candidate) => candidate.primaryName === name || candidate.aliases.includes(name));
    if (!icon) {
      throw new AppError('CATALOG_ICON_NOT_FOUND', `Unknown npm catalog icon: ${name}`, 404);
    }
    return Buffer.from(icon.svg, 'utf8');
  }

  async baseline(): Promise<CatalogBaseline> {
    return (await this.latestNpmSnapshot()).baseline;
  }

  tarballPath(baseline: CatalogBaseline): Promise<string> {
    return this.npmCatalog.cachedTarballPath(baseline);
  }

  private latestNpmSnapshot(): Promise<NpmCatalogSnapshot> {
    return this.npmCatalog.latest();
  }

  private async latestTargetSnapshot(): Promise<TargetCatalogSnapshot> {
    const baseCommit = await this.repository.resolveBaseCommit();
    if (this.targetSnapshot?.baseCommit === baseCommit) {
      return this.targetSnapshot;
    }
    if (this.targetInFlight) {
      const pending = await this.targetInFlight;
      if (pending.baseCommit === baseCommit) {
        return pending;
      }
    }
    const build = this.buildTargetSnapshot(baseCommit);
    this.targetInFlight = build;
    try {
      const snapshot = await build;
      this.targetSnapshot = snapshot;
      return snapshot;
    } finally {
      if (this.targetInFlight === build) {
        this.targetInFlight = undefined;
      }
    }
  }

  private async buildTargetSnapshot(baseCommit: string): Promise<TargetCatalogSnapshot> {
    return this.repository.withWorktreeAt(baseCommit, async (worktreePath) => {
      const catalog = (await this.iconBatch.catalog(worktreePath)).payload;
      if (catalog.baseCommit !== baseCommit || !Array.isArray(catalog.icons)) {
        throw new AppError('CATALOG_INVALID', 'Target repository catalog is invalid.', 502);
      }
      const names = new Set<string>();
      const icons = catalog.icons.map((entry): TargetCatalogIcon => {
        if (!isObject(entry)) {
          throw new AppError('CATALOG_INVALID', 'Target repository catalog icon is invalid.', 502);
        }
        const primaryName = requiredString(entry.primaryName, 'primaryName');
        const aliases = readAliases(entry.aliases);
        for (const name of new Set([primaryName, ...aliases])) {
          if (names.has(name)) {
            throw new AppError('CATALOG_INVALID', `Target repository catalog name is duplicated: ${name}.`, 502);
          }
          names.add(name);
        }
        return { primaryName, aliases };
      });
      return { baseCommit, icons };
    });
  }
}
