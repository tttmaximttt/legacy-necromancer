import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { ExhumeReport, HttpRoute, ImportGraphData, RawMount, RawRoute, RepoHistory, SourceFile } from '@necromancer/core';
import { readHistory } from './churn.js';
import { checkout } from './clone.js';
import { isTooLarge, listRepoFiles } from './files.js';
import { analyzeGraph, buildImportGraph, type GraphAnalysis, type ImportGraph } from './graph.js';
import { auditManifests } from './install-scripts.js';
import { ImportParser, joinRoute, languageFor } from './parser.js';
import { ImportResolver } from './resolve.js';

export interface ExhumeOptions {
  /** Where remote repos are cloned. Defaults to the OS temp dir. */
  workdir?: string;
  /** Keep the clone after the run instead of deleting it. */
  keep?: boolean;
  /** Number of load-bearing files to report. */
  top?: number;
  /** Seed for Louvain, so clusters are reproducible. */
  seed?: number;
  includeTests?: boolean;
  onProgress?: (message: string) => void;
}

/** Phase 1: clone, parse, graph, cluster, rank, and audit install scripts. */
export async function exhume(source: string, options: ExhumeOptions = {}): Promise<ExhumeReport & { root?: string }> {
  const started = performance.now();
  const log = options.onProgress ?? (() => {});

  log(`checking out ${source}`);
  const repo = await checkout(source, { workdir: options.workdir });
  try {
    const allFiles = await listRepoFiles(repo.root);
    const sourcePaths = allFiles.filter((f) => languageFor(f));
    log(`parsing ${sourcePaths.length} source files`);

    const parser = await ImportParser.create();
    const resolver = new ImportResolver(allFiles, await readMains(repo.root, allFiles));
    const files: SourceFile[] = [];
    const routesByFile = new Map<string, RawRoute[]>();
    const mountsByFile = new Map<string, Array<RawMount & { target: string }>>();
    try {
      for (const rel of sourcePaths) {
        const abs = path.join(repo.root, rel);
        if (await isTooLarge(abs)) continue;
        const text = await readFile(abs, 'utf8');
        const language = languageFor(rel)!;
        const parsed = parser.parse(text, language);
        files.push({
          path: rel,
          language,
          loc: countLines(text),
          parseErrors: parsed.parseErrors,
          isTest: isTestFile(rel),
          imports: parsed.imports.map((imp) => resolver.resolve(rel, imp)),
        });
        if (parsed.routes.length && !isTestFile(rel)) routesByFile.set(rel, parsed.routes);
        const mounts = parsed.mounts.flatMap((m) => {
          const r = resolver.resolve(rel, { specifier: m.specifier, kind: 'require', line: m.line });
          return r.type === 'internal' ? [{ ...m, target: r.target }] : [];
        });
        if (mounts.length) mountsByFile.set(rel, mounts);
      }
    } finally {
      parser.dispose();
    }

    log('reading git history');
    const history = await readHistory(repo.root);

    log('building import graph');
    const graph = buildImportGraph(files);
    const analysis = analyzeGraph(graph, {
      churn: history.files,
      top: options.top,
      seed: options.seed,
      includeTests: options.includeTests,
    });

    log('auditing install scripts');
    const { findings, manifests } = await auditManifests(repo.root, allFiles);

    const external = new Map<string, Set<string>>();
    const caseMismatches: ExhumeReport['caseMismatches'] = [];
    let unresolved = 0;
    for (const f of files) {
      for (const imp of f.imports) {
        if (imp.type === 'unresolved') unresolved++;
        if (imp.type === 'internal' && imp.caseMismatch) {
          caseMismatches.push({ from: f.path, specifier: imp.raw.specifier, line: imp.raw.line, target: imp.target });
        }
        if (imp.type !== 'external') continue;
        let importers = external.get(imp.packageName);
        if (!importers) external.set(imp.packageName, (importers = new Set()));
        importers.add(f.path);
      }
    }

    const { files: _perFile, ...historySummary } = history;
    const report: ExhumeReport & { root?: string } = {
      repo: {
        source,
        commit: await headCommit(repo.root),
        packageManager: detectPackageManager(allFiles),
      },
      stats: {
        files: files.length,
        loc: files.reduce((n, f) => n + f.loc, 0),
        internalEdges: graph.size,
        externalPackages: external.size,
        unresolvedImports: unresolved,
        caseMismatchedImports: caseMismatches.length,
        testFiles: files.filter((f) => f.isTest).length,
        filesWithParseErrors: files.filter((f) => f.parseErrors > 0).length,
        durationMs: Math.round(performance.now() - started),
      },
      history: historySummary,
      clusters: analysis.clusters,
      loadBearing: analysis.loadBearing,
      orphans: analysis.orphans,
      externalPackages: [...external]
        .map(([name, importers]) => ({ name, importedBy: importers.size }))
        .sort((a, b) => b.importedBy - a.importedBy || a.name.localeCompare(b.name)),
      caseMismatches,
      manifests,
      installScripts: findings,
      graph: graphData(graph, analysis, history.files),
      routes: applyMounts(routesByFile, mountsByFile),
    };
    if (options.keep) report.root = repo.root;
    return report;
  } finally {
    if (!options.keep) await repo.cleanup();
  }
}

function graphData(graph: ImportGraph, analysis: GraphAnalysis, churn: RepoHistory['files']): ImportGraphData {
  const ranked = new Map(analysis.ranked.map((f) => [f.path, f]));
  const clusterOf = new Map<string, number>();
  for (const c of analysis.clusters) for (const f of c.files) clusterOf.set(f, c.id);
  return {
    nodes: graph.mapNodes((id, attrs) => ({
      id,
      cluster: clusterOf.get(id) ?? -1,
      loc: attrs.loc,
      isTest: attrs.isTest,
      fanIn: graph.inDegree(id),
      fanOut: graph.outDegree(id),
      score: ranked.get(id)?.score ?? null,
      blastRadius: ranked.get(id)?.blastRadius ?? null,
      churn: churn[id]?.commits ?? 0,
    })),
    edges: graph.mapEdges((_e, _a, source, target) => [source, target] as [string, string]),
  };
}

/**
 * Prefixes each file's routes with the paths it is mounted under (`app.use('/api', require('./api'))`),
 * following mounts of mounts. A file that is never mounted serves its routes as written.
 */
export function applyMounts(routesByFile: Map<string, RawRoute[]>, mountsByFile: Map<string, Array<RawMount & { target: string }>>): HttpRoute[] {
  const mountedAt = new Map<string, Array<{ from: string; prefix: string }>>();
  for (const [from, mounts] of mountsByFile) {
    for (const m of mounts) mountedAt.set(m.target, [...(mountedAt.get(m.target) ?? []), { from, prefix: m.prefix }]);
  }
  const prefixes = (file: string, depth: number): string[] => {
    const parents = mountedAt.get(file);
    if (!parents || depth > 5) return [''];
    return parents.flatMap((p) => prefixes(p.from, depth + 1).map((outer) => joinRoute(outer, p.prefix)));
  };
  const out: HttpRoute[] = [];
  const seen = new Set<string>();
  for (const [file, routes] of [...routesByFile].sort(([a], [b]) => a.localeCompare(b))) {
    for (const prefix of prefixes(file, 0)) {
      for (const r of routes) {
        const route = { method: r.method, path: joinRoute(prefix, r.path), file, line: r.line };
        const key = `${route.method} ${route.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(route);
        }
      }
    }
  }
  return out;
}

export function isTestFile(file: string): boolean {
  return /(^|\/)(test|tests|__tests__|__mocks__|spec|specs)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

/** `main` of every package.json, keyed by its directory, so `require('../..')` resolves like Node would. */
async function readMains(root: string, files: string[]): Promise<Record<string, string>> {
  const mains: Record<string, string> = {};
  for (const manifest of files.filter((f) => f === 'package.json' || f.endsWith('/package.json'))) {
    try {
      const pkg = JSON.parse(await readFile(path.join(root, manifest), 'utf8')) as { main?: unknown };
      if (typeof pkg.main === 'string') mains[path.posix.dirname(manifest).replace(/^\.$/, '')] = pkg.main;
    } catch {
      // Unparseable manifests are reported by the install-script audit.
    }
  }
  return mains;
}

function countLines(text: string): number {
  return text.split('\n').filter((l) => l.trim()).length;
}

export async function headCommit(root: string): Promise<string | null> {
  try {
    return (await simpleGit(root).revparse(['HEAD'])).trim();
  } catch {
    return null;
  }
}

export function detectPackageManager(files: string[]): ExhumeReport['repo']['packageManager'] {
  const has = (f: string) => files.includes(f);
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('package-lock.json') || has('npm-shrinkwrap.json') || has('package.json')) return 'npm';
  if (has('bower.json')) return 'bower';
  return 'unknown';
}
