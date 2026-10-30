import type { Advisory } from '@necromancer/core';
import { getJson, pool, type Fetch } from './http.js';

export interface PackageVersion {
  name: string;
  version: string;
}

export interface AdvisorySource {
  readonly name: string;
  /** Advisories per `name@version`. */
  lookup(packages: PackageVersion[]): Promise<Map<string, Advisory[]>>;
}

export const key = (p: PackageVersion) => `${p.name}@${p.version}`;

const SEVERITIES = new Set(['critical', 'high', 'moderate', 'low']);

/**
 * npm's bulk advisory endpoint, the one `npm audit` uses. It serves the
 * GitHub Advisory Database and lives on registry.npmjs.org, so it works
 * wherever installing packages works.
 */
export class NpmAdvisories implements AdvisorySource {
  readonly name = 'npm';

  constructor(
    private readonly fetch: Fetch = globalThis.fetch,
    private readonly base = 'https://registry.npmjs.org',
  ) {}

  async lookup(packages: PackageVersion[]): Promise<Map<string, Advisory[]>> {
    const out = new Map<string, Advisory[]>();
    // One version per name per request, so every advisory returned applies to that exact version.
    const chunks: PackageVersion[][] = [];
    for (let i = 0; i < packages.length; i += 100) chunks.push(packages.slice(i, i + 100));
    for (const chunk of chunks) {
      const body = Object.fromEntries(chunk.map((p) => [p.name, [p.version]]));
      const res = await getJson<Record<string, RawNpmAdvisory[]>>(this.fetch, `${this.base}/-/npm/v1/security/advisories/bulk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      for (const p of chunk) {
        out.set(
          key(p),
          (res[p.name] ?? []).map((a) => ({
            id: a.url?.split('/').pop() ?? String(a.id),
            title: a.title,
            severity: SEVERITIES.has(a.severity) ? (a.severity as Advisory['severity']) : 'unknown',
            url: a.url ?? null,
            vulnerableVersions: a.vulnerable_versions ?? null,
          })),
        );
      }
    }
    return out;
  }
}

interface RawNpmAdvisory {
  id: number;
  title: string;
  severity: string;
  url?: string;
  vulnerable_versions?: string;
}

/** OSV.dev. Broader than the npm endpoint (it merges several databases) but needs two round trips. */
export class OsvAdvisories implements AdvisorySource {
  readonly name = 'osv';

  constructor(
    private readonly fetch: Fetch = globalThis.fetch,
    private readonly base = 'https://api.osv.dev',
  ) {}

  async lookup(packages: PackageVersion[]): Promise<Map<string, Advisory[]>> {
    const ids = new Map<string, string[]>();
    for (let i = 0; i < packages.length; i += 1000) {
      const chunk = packages.slice(i, i + 1000);
      const res = await getJson<{ results: Array<{ vulns?: Array<{ id: string }> }> }>(this.fetch, `${this.base}/v1/querybatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queries: chunk.map((p) => ({ package: { name: p.name, ecosystem: 'npm' }, version: p.version })) }),
      });
      chunk.forEach((p, j) => ids.set(key(p), (res.results[j]?.vulns ?? []).map((v) => v.id)));
    }

    // querybatch only returns ids; details are one request each.
    const unique = [...new Set([...ids.values()].flat())];
    const details = new Map<string, Advisory>();
    await pool(unique, 8, async (id) => {
      const v = await getJson<RawOsvVuln>(this.fetch, `${this.base}/v1/vulns/${encodeURIComponent(id)}`);
      details.set(id, {
        id: v.aliases?.find((a) => a.startsWith('GHSA-')) ?? v.id,
        title: v.summary ?? v.details?.split('\n')[0] ?? v.id,
        severity: osvSeverity(v),
        url: v.references?.find((r) => r.type === 'ADVISORY')?.url ?? `https://osv.dev/vulnerability/${v.id}`,
        vulnerableVersions: null,
      });
    });

    const out = new Map<string, Advisory[]>();
    for (const [k, list] of ids) out.set(k, list.map((id) => details.get(id)).filter((a): a is Advisory => !!a));
    return out;
  }
}

interface RawOsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  references?: Array<{ type: string; url: string }>;
  database_specific?: { severity?: string };
}

function osvSeverity(v: RawOsvVuln): Advisory['severity'] {
  const s = v.database_specific?.severity?.toLowerCase();
  if (s === 'medium') return 'moderate';
  return s && SEVERITIES.has(s) ? (s as Advisory['severity']) : 'unknown';
}
