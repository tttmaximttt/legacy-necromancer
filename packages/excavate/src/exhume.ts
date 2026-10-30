import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { ExhumeReport, SourceFile } from '@necromancer/core';
import { readHistory } from './churn.js';
import { checkout } from './clone.js';
import { isTooLarge, listRepoFiles } from './files.js';
import { analyzeGraph, buildImportGraph } from './graph.js';
import { auditManifests } from './install-scripts.js';
import { ImportParser, languageFor } from './parser.js';
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
    };
    if (options.keep) report.root = repo.root;
    return report;
  } finally {
    if (!options.keep) await repo.cleanup();
  }
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
  if (!text) return 0;
  return text.split('\n').filter((l) => l.trim()).length;
}

async function headCommit(root: string): Promise<string | null> {
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
