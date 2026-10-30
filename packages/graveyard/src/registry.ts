import { getJson, HttpError, type Fetch } from './http.js';

/** The parts of an npm packument the graveyard uses. Full packuments can be megabytes; we keep only this. */
export interface Packument {
  name: string;
  latest: string | null;
  versions: string[];
  /** Per-version deprecation message. */
  deprecated: Record<string, string>;
  /** Per-version publish time (ISO). */
  time: Record<string, string>;
  repository: string | null;
}

interface RawPackument {
  name: string;
  'dist-tags'?: { latest?: string };
  versions?: Record<string, { deprecated?: string | boolean; repository?: RawRepository }>;
  time?: Record<string, string>;
  repository?: RawRepository;
}
type RawRepository = string | { url?: string };

export class NpmRegistry {
  private readonly cache = new Map<string, Promise<Packument | null>>();

  constructor(
    private readonly fetch: Fetch = globalThis.fetch,
    private readonly base = 'https://registry.npmjs.org',
  ) {}

  /** null means the registry has no such package (unpublished, private, or a typo). */
  packument(name: string): Promise<Packument | null> {
    let hit = this.cache.get(name);
    if (!hit) {
      hit = this.load(name);
      this.cache.set(name, hit);
    }
    return hit;
  }

  private async load(name: string): Promise<Packument | null> {
    const url = `${this.base}/${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`;
    let raw: RawPackument;
    try {
      raw = await getJson<RawPackument>(this.fetch, url, { headers: { accept: 'application/json' } });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
    const versions = raw.versions ?? {};
    const latest = raw['dist-tags']?.latest ?? null;
    const deprecated: Record<string, string> = {};
    for (const [v, meta] of Object.entries(versions)) {
      if (meta.deprecated) deprecated[v] = typeof meta.deprecated === 'string' ? meta.deprecated : 'deprecated';
    }
    const time: Record<string, string> = {};
    for (const [v, t] of Object.entries(raw.time ?? {})) if (v in versions) time[v] = t;
    return {
      name: raw.name,
      latest,
      versions: Object.keys(versions),
      deprecated,
      time,
      repository: repoUrl(raw.repository ?? (latest ? versions[latest]?.repository : undefined)),
    };
  }
}

function repoUrl(repo: RawRepository | undefined): string | null {
  if (!repo) return null;
  return typeof repo === 'string' ? repo : (repo.url ?? null);
}
