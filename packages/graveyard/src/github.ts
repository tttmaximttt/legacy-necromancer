import { getJson, HttpError, type Fetch } from './http.js';

export interface RepoStatus {
  archived: boolean;
  pushedAt: string | null;
}

/** `git+https://github.com/a/b.git`, `git://github.com/a/b`, `github:a/b`, `a/b` → `a/b`. Non-GitHub → null. */
export function githubSlug(url: string | null): string | null {
  if (!url) return null;
  const shorthand = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#.*)?$/.exec(url);
  if (shorthand && !url.includes('://') && !url.includes('@')) return `${shorthand[1]}/${shorthand[2]}`;
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Reads `archived` from the GitHub API. Unauthenticated calls get 60 an
 * hour, so set GITHUB_TOKEN (or GH_TOKEN) for real projects.
 */
export class GitHubClient {
  private readonly cache = new Map<string, Promise<RepoStatus | null>>();

  constructor(
    private readonly fetch: Fetch = globalThis.fetch,
    private readonly token: string | undefined = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    private readonly base = 'https://api.github.com',
  ) {}

  /** null when the repo is gone (404). Throws on rate limits and network errors so callers can report them. */
  repo(slug: string): Promise<RepoStatus | null> {
    let hit = this.cache.get(slug.toLowerCase());
    if (!hit) {
      hit = this.load(slug);
      this.cache.set(slug.toLowerCase(), hit);
    }
    return hit;
  }

  private async load(slug: string): Promise<RepoStatus | null> {
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'necromancer' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    try {
      const r = await getJson<{ archived?: boolean; pushed_at?: string }>(this.fetch, `${this.base}/repos/${slug}`, { headers });
      return { archived: !!r.archived, pushedAt: r.pushed_at ?? null };
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }
}
