import { AppError } from './errors.js';
import { NpmPackageCatalog } from './npm-package-catalog.js';
import type { CatalogBaseline, CatalogPage, CatalogPageInput, NpmCatalogSnapshot, NpmPackageCatalogOptions } from './types.js';

export class CatalogSnapshotCache {
  private readonly npmCatalog: NpmPackageCatalog;

  constructor(options: NpmPackageCatalogOptions) {
    this.npmCatalog = new NpmPackageCatalog(options);
  }

  invalidate(): void {
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
    const snapshot = await this.latestNpmSnapshot();
    const icon = snapshot.icons.find((candidate) => candidate.primaryName === name || candidate.aliases.includes(name));
    if (!icon) {
      throw new AppError('CATALOG_ICON_NOT_FOUND', `Icon ${name} is not available in the catalog. Refresh the catalog and choose an existing icon.`, 409);
    }
    return icon.primaryName;
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
}
