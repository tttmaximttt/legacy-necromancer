import path from 'node:path';
import semver from 'semver';
import type {
  Advisory,
  Cause,
  DependencySummary,
  GraveyardReport,
  RepoHistory,
  SourceStatus,
  Tombstone,
  TombstoneStatus,
} from '@necromancer/core';
import { auditManifests, checkout, headCommit, listRepoFiles, readHistory } from '@necromancer/excavate';
import { key, NpmAdvisories, OsvAdvisories, type AdvisorySource } from './advisories.js';
import { dateRemains } from './era.js';
import { GitHubClient, githubSlug } from './github.js';
import { pool } from './http.js';
import { readLockedVersions } from './lockfile.js';
import { NpmRegistry, type Packument } from './registry.js';
import { suggestReplacement } from './replacements.js';

const YEAR = 365.25 * 24 * 3600 * 1000;
/** No release for this long and a package counts as abandoned. */
export const ABANDONED_AFTER_YEARS = 3;
/** Without a GitHub token we only spend the 60/hour budget on packages already quiet this long. */
const UNAUTHENTICATED_GITHUB_AFTER_YEARS = 2;

export interface Clients {
  registry: NpmRegistry;
  advisories: AdvisorySource | null;
  github: GitHubClient | null;
  /** Without a token, only probe GitHub for packages that already look quiet. */
  githubAuthenticated?: boolean;
}

export interface DigInput {
  source: string;
  commit: string | null;
  root: string;
  files: string[];
  manifests: DependencySummary[];
  history: Omit<RepoHistory, 'files'>;
  /** Injected so tests (and old reports) are reproducible. */
  now?: Date;
}

interface Dependency {
  name: string;
  /** Registry name when the spec is an `npm:` alias. */
  registryName: string;
  spec: string;
  range: string;
  dev: boolean;
  manifestDir: string;
}

/** Phase 2, given an already checked-out repo. */
export async function digGraveyard(input: DigInput, clients: Clients): Promise<GraveyardReport> {
  const now = input.now ?? new Date();
  const warnings: string[] = [];
  const { deps, nonRegistry } = collectDependencies(input.manifests);

  // Registry
  const registryErrors: string[] = [];
  const packuments = new Map<string, Packument | null>();
  await pool(deps, 8, async (d) => {
    try {
      packuments.set(d.registryName, await clients.registry.packument(d.registryName));
    } catch (err) {
      registryErrors.push(`${d.registryName}: ${message(err)}`);
    }
  });
  const registryFailures = registryErrors.length;
  if (registryFailures && registryFailures === deps.length) {
    warnings.push(`could not reach the npm registry for any package (${registryErrors[0]}); check network and proxy settings`);
  } else if (registryFailures > 3) {
    warnings.push(`registry lookup failed for ${registryFailures} packages, e.g. ${registryErrors.slice(0, 3).join('; ')}`);
  } else {
    for (const e of registryErrors) warnings.push(`registry lookup failed for ${e}`);
  }

  // Versions actually used
  const locks = new Map<string, Map<string, string>>();
  for (const dir of new Set(deps.map((d) => d.manifestDir))) locks.set(dir, await readLockedVersions(input.root, dir, input.files));
  const died = input.history.lastCommit;
  const resolved = new Map<string, { version: string; from: Tombstone['resolvedFrom'] } | null>();
  for (const d of deps) resolved.set(d.name, resolveVersion(d, packuments.get(d.registryName), locks.get(d.manifestDir), died));

  // Advisories
  let advisoryStatus: SourceStatus = clients.advisories ? 'ok' : 'skipped';
  let advisories = new Map<string, Advisory[]>();
  const queries = deps.flatMap((d) => {
    const r = resolved.get(d.name);
    return r ? [{ name: d.registryName, version: r.version }] : [];
  });
  if (clients.advisories && queries.length) {
    try {
      advisories = await clients.advisories.lookup(queries);
    } catch (err) {
      advisoryStatus = 'failed';
      warnings.push(`${clients.advisories.name} advisory lookup failed: ${message(err)}`);
    }
  }

  // GitHub archived flags
  let githubStatus: SourceStatus = clients.github ? 'ok' : 'skipped';
  const archived = new Map<string, boolean | null>();
  if (clients.github) {
    const github = clients.github;
    const candidates = deps.filter((d) => {
      const pkg = packuments.get(d.registryName);
      if (!pkg || !githubSlug(pkg.repository)) return false;
      if (clients.githubAuthenticated) return true;
      const last = lastPublished(pkg);
      return !!last && now.getTime() - Date.parse(last) > UNAUTHENTICATED_GITHUB_AFTER_YEARS * YEAR;
    });
    if (!clients.githubAuthenticated && candidates.length) {
      warnings.push(`no GITHUB_TOKEN: checked only the ${candidates.length} packages with no release in ${UNAUTHENTICATED_GITHUB_AFTER_YEARS}+ years for archived repos`);
    }
    let failures = 0;
    await pool(candidates, 4, async (d) => {
      const slug = githubSlug(packuments.get(d.registryName)!.repository)!;
      try {
        const repo = await github.repo(slug);
        archived.set(d.name, repo ? repo.archived : null);
      } catch (err) {
        if (failures++ === 0) warnings.push(`GitHub lookup failed (${message(err)}); archived flags may be missing`);
      }
    });
    if (failures) githubStatus = failures === candidates.length ? 'failed' : 'partial';
  }

  const tombstones = deps.map((d) =>
    carve(d, packuments.get(d.registryName), resolved.get(d.name) ?? null, advisories, archived.get(d.name) ?? null, now, packuments.has(d.registryName)),
  );
  tombstones.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));

  const root = input.manifests.find((m) => m.manifest === 'package.json') ?? input.manifests[0];
  const era = dateRemains({
    history: input.history,
    dependencies: { ...root?.devDependencies, ...root?.dependencies },
    packuments: new Map([...packuments].filter(([name]) => name in { ...root?.devDependencies, ...root?.dependencies })),
    nodeRange: root?.engines.node ?? null,
  });

  const summary = { total: tombstones.length, dead: 0, dying: 0, ailing: 0, alive: 0, unknown: 0, vulnerable: 0 };
  for (const t of tombstones) {
    summary[t.status]++;
    if (t.advisories.length) summary.vulnerable++;
  }

  return {
    repo: { source: input.source, commit: input.commit },
    era,
    summary,
    tombstones,
    sources: {
      registry: registryFailures === 0 ? 'ok' : registryFailures === deps.length ? 'failed' : 'partial',
      advisories: advisoryStatus,
      advisoryProvider: clients.advisories?.name ?? 'none',
      github: githubStatus,
    },
    nonRegistry,
    warnings,
  };
}

export interface GraveyardOptions {
  workdir?: string;
  /** 'npm' (default) uses the same database as `npm audit`; 'osv' queries OSV.dev; 'none' skips. */
  advisories?: 'npm' | 'osv' | 'none';
  /** Skip the GitHub archived check entirely. */
  noGithub?: boolean;
  fetch?: typeof globalThis.fetch;
  now?: Date;
  onProgress?: (message: string) => void;
}

/** Clone (or open) a repo and dig its graveyard. */
export async function graveyard(source: string, options: GraveyardOptions = {}): Promise<GraveyardReport> {
  const log = options.onProgress ?? (() => {});
  const fetch = options.fetch ?? globalThis.fetch;
  log(`checking out ${source}`);
  const repo = await checkout(source, { workdir: options.workdir });
  try {
    const files = await listRepoFiles(repo.root);
    const { manifests } = await auditManifests(repo.root, files);
    const { files: _perFile, ...history } = await readHistory(repo.root);
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const provider = options.advisories ?? 'npm';
    log(`digging up ${manifests.reduce((n, m) => n + Object.keys(m.dependencies).length + Object.keys(m.devDependencies).length, 0)} dependencies`);
    return await digGraveyard(
      { source, commit: await headCommit(repo.root), root: repo.root, files, manifests, history, now: options.now },
      {
        registry: new NpmRegistry(fetch),
        advisories: provider === 'none' ? null : provider === 'osv' ? new OsvAdvisories(fetch) : new NpmAdvisories(fetch),
        github: options.noGithub ? null : new GitHubClient(fetch, token),
        githubAuthenticated: !!token,
      },
    );
  } finally {
    await repo.cleanup();
  }
}

const ORDER: Record<TombstoneStatus, number> = { dead: 0, dying: 1, ailing: 2, unknown: 3, alive: 4 };

export function collectDependencies(manifests: DependencySummary[]): { deps: Dependency[]; nonRegistry: Array<{ name: string; spec: string }> } {
  const byName = new Map<string, Dependency>();
  const nonRegistry: Array<{ name: string; spec: string }> = [];
  const ordered = [...manifests].sort((a, b) => (a.manifest === 'package.json' ? -1 : b.manifest === 'package.json' ? 1 : 0));
  const workspaceNames = new Set(manifests.map((m) => m.name).filter(Boolean));

  for (const m of ordered) {
    const dir = path.posix.dirname(m.manifest).replace(/^\.$/, '');
    for (const [deps, dev] of [[m.dependencies, false], [m.devDependencies, true]] as const) {
      for (const [name, spec] of Object.entries(deps)) {
        if (workspaceNames.has(name)) continue;
        const existing = byName.get(name);
        if (existing) {
          if (!dev) existing.dev = false;
          continue;
        }
        const parsed = registrySpec(name, spec);
        if (!parsed) {
          if (!nonRegistry.some((n) => n.name === name)) nonRegistry.push({ name, spec });
          continue;
        }
        byName.set(name, { name, registryName: parsed.name, spec, range: parsed.range, dev, manifestDir: dir });
      }
    }
  }
  return { deps: [...byName.values()], nonRegistry };
}

/** null for git, file:, link:, workspace:, tarball URLs and GitHub shorthands. */
export function registrySpec(name: string, spec: string): { name: string; range: string } | null {
  const s = spec.trim();
  const alias = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@(.*))?$/.exec(s);
  if (alias) return { name: alias[1]!, range: alias[2] || '*' };
  if (/^(git|file|link|workspace|portal|patch|http|https|github|gitlab|bitbucket)[:+]/.test(s)) return null;
  if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(s)) return null;
  if (s === '' || s === 'latest' || s === '*' || s === 'x') return { name, range: '*' };
  return semver.validRange(s, { loose: true }) ? { name, range: s } : null;
}

function resolveVersion(
  d: Dependency,
  pkg: Packument | null | undefined,
  lock: Map<string, string> | undefined,
  died: string | null,
): { version: string; from: Tombstone['resolvedFrom'] } | null {
  if (!pkg) {
    const locked = lock?.get(d.name);
    return locked && semver.valid(locked) ? { version: locked, from: 'lockfile' } : null;
  }
  const locked = lock?.get(d.name);
  if (locked && pkg.versions.includes(locked)) return { version: locked, from: 'lockfile' };

  const range = d.range;
  if (died) {
    const then = pkg.versions.filter((v) => pkg.time[v] && pkg.time[v]! <= died);
    const v = maxSatisfying(then, range);
    if (v) return { version: v, from: 'era' };
  }
  const v = maxSatisfying(pkg.versions, range);
  return v ? { version: v, from: 'latest' } : null;
}

function maxSatisfying(versions: string[], range: string): string | null {
  try {
    return semver.maxSatisfying(versions, range, { loose: true });
  } catch {
    return null;
  }
}

function lastPublished(pkg: Packument): string | null {
  let last: string | null = null;
  for (const t of Object.values(pkg.time)) if (!last || t > last) last = t;
  return last;
}

function carve(
  d: Dependency,
  pkg: Packument | null | undefined,
  resolved: { version: string; from: Tombstone['resolvedFrom'] } | null,
  advisoryMap: Map<string, Advisory[]>,
  archived: boolean | null,
  now: Date,
  looked: boolean,
): Tombstone {
  const causes: Cause[] = [];
  const base = {
    name: d.name,
    declared: d.spec,
    dev: d.dev,
    resolved: resolved?.version ?? null,
    resolvedFrom: resolved?.from ?? null,
  };

  if (!looked) {
    return { ...base, latest: null, majorsBehind: null, lastPublished: null, repository: null, status: 'unknown', causes, advisories: [], replacement: suggestReplacement(d.name, null, false), epitaph: `${d.name}: registry lookup failed.` };
  }
  if (pkg === null || pkg === undefined) {
    causes.push({ kind: 'missing', detail: 'not on the npm registry (unpublished, private, or renamed)' });
    return { ...base, latest: null, majorsBehind: null, lastPublished: null, repository: null, status: 'dead', causes, advisories: [], replacement: suggestReplacement(d.name, null, true), epitaph: `${d.name}: gone from the registry.` };
  }

  const latest = pkg.latest;
  const last = lastPublished(pkg);
  const wholePackageDeprecated = latest ? pkg.deprecated[latest] : undefined;
  const versionDeprecated = resolved ? pkg.deprecated[resolved.version] : undefined;
  const deprecation = wholePackageDeprecated ?? versionDeprecated ?? null;

  let status = 'alive' as TombstoneStatus;
  const worsen = (s: TombstoneStatus) => {
    if (ORDER[s] < ORDER[status]) status = s;
  };

  if (wholePackageDeprecated) {
    causes.push({ kind: 'deprecated', detail: wholePackageDeprecated.trim() });
    worsen('dead');
  } else if (versionDeprecated) {
    causes.push({ kind: 'deprecated', detail: `${resolved!.version} is deprecated: ${versionDeprecated.trim()}` });
    worsen('ailing');
  }
  if (archived) {
    causes.push({ kind: 'archived', detail: `source repository ${githubSlug(pkg.repository)} is archived` });
    worsen('dead');
  }
  if (last && now.getTime() - Date.parse(last) > ABANDONED_AFTER_YEARS * YEAR) {
    causes.push({ kind: 'abandoned', detail: `no release since ${last.slice(0, 10)}` });
    worsen('dying');
  }
  const advisories = resolved ? (advisoryMap.get(key({ name: d.registryName, version: resolved.version })) ?? []) : [];
  if (advisories.length) {
    causes.push({ kind: 'vulnerable', detail: `${advisories.length} advisor${advisories.length === 1 ? 'y' : 'ies'}, worst ${worstSeverity(advisories)}` });
    worsen('ailing');
  }
  const majorsBehind = resolved && latest && semver.valid(resolved.version) && semver.valid(latest) ? Math.max(0, semver.major(latest) - semver.major(resolved.version)) : null;
  if (majorsBehind !== null && majorsBehind >= 2) {
    causes.push({ kind: 'outdated', detail: `${majorsBehind} majors behind (${resolved!.version} → ${latest})` });
    worsen('ailing');
  }

  const replacement = suggestReplacement(d.name, deprecation, status === 'dead' || status === 'dying');
  return {
    ...base,
    latest,
    majorsBehind,
    lastPublished: last,
    repository: pkg.repository,
    status,
    causes,
    advisories,
    replacement,
    epitaph: epitaph(d.name, resolved?.version ?? null, status, causes, replacement?.name ?? null),
  };
}

const SEVERITY_RANK = ['critical', 'high', 'moderate', 'low', 'unknown'] as const;
function worstSeverity(list: Advisory[]): Advisory['severity'] {
  return SEVERITY_RANK.find((s) => list.some((a) => a.severity === s)) ?? 'unknown';
}

function epitaph(name: string, version: string | null, status: TombstoneStatus, causes: Cause[], successor: string | null): string {
  const who = version ? `${name}@${version}` : name;
  if (status === 'alive') return `${who}: alive and well.`;
  const short = causes.map((c) => {
    switch (c.kind) {
      case 'deprecated':
        return c.detail.length > 90 ? `deprecated: "${c.detail.slice(0, 87)}…"` : `deprecated: "${c.detail}"`;
      case 'archived':
        return 'source archived';
      case 'abandoned':
        return c.detail;
      default:
        return c.detail;
    }
  });
  return `${who}: ${short.join('; ')}.${successor ? ` Successor: ${successor}.` : ''}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
