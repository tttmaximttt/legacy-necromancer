import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Citation, ExhumeReport } from '@necromancer/core';

/** One file as the model sees it: the first `shown` lines, numbered. */
export interface EvidenceFile {
  path: string;
  /** Why it was picked, shown to the model so it knows what it's looking at. */
  role: string;
  lines: string[];
  totalLines: number;
}

export interface EvidencePack {
  files: EvidenceFile[];
  /** Every source path in the repo, for orientation; capped on big repos. */
  tree: string[];
  treeTruncated: number;
}

export interface GatherOptions {
  /** Total numbered lines across all files. Keeps the prompt to roughly 40k tokens. */
  lineBudget?: number;
  maxLinesPerFile?: number;
}

const README = /^readme(\.(md|markdown|txt|rst))?$/i;
const TREE_CAP = 400;

/**
 * Picks the files that best say what a project is for: the README and manifest first, then entry points,
 * the load-bearing files from the exhume report, one representative per cluster, and docs or examples.
 */
export async function gatherEvidence(root: string, report: ExhumeReport, allFiles: string[], options: GatherOptions = {}): Promise<EvidencePack> {
  const budget = options.lineBudget ?? 2400;
  const perFile = options.maxLinesPerFile ?? 220;
  const present = new Set(allFiles);
  const picks: Array<{ path: string; role: string; max: number }> = [];
  const add = (file: string | undefined, role: string, max = perFile) => {
    if (file && present.has(file) && !picks.some((p) => p.path === file)) picks.push({ path: file, role, max });
  };

  add(allFiles.find((f) => README.test(f)), 'README');
  add('package.json', 'package manifest', 150);
  for (const entry of await entryPoints(root, present)) add(entry, 'entry point');
  for (const f of report.loadBearing) add(f.path, `load-bearing file (${f.blastRadius} files depend on it)`);
  for (const c of report.clusters) {
    const best = c.files.find((f) => !picks.some((p) => p.path === f));
    add(best, `representative of the "${c.label}" cluster (${c.size} files)`, 100);
  }
  add(allFiles.find((f) => /^docs?\/[^/]+\.(md|markdown)$/i.test(f)), 'documentation', 120);
  add(allFiles.find((f) => /^examples?\/[^/]+\.[cm]?[jt]sx?$/i.test(f)), 'example', 100);
  add(allFiles.find((f) => /^(changelog|history)(\.md)?$/i.test(f)), 'changelog (newest entries)', 60);

  const files: EvidenceFile[] = [];
  let used = 0;
  for (const pick of picks) {
    if (used >= budget) break;
    const text = await readRepoFile(root, pick.path);
    if (text === null) continue;
    const all = text.split(/\r?\n/);
    const lines = all.slice(0, Math.min(pick.max, budget - used));
    used += lines.length;
    files.push({ path: pick.path, role: pick.role, lines, totalLines: all.length });
  }

  const source = report.graph.nodes.map((n) => n.id).sort();
  return { files, tree: source.slice(0, TREE_CAP), treeTruncated: Math.max(0, source.length - TREE_CAP) };
}

/** `main`, `bin` and the root `exports` entry of package.json, when they point at files that exist. */
async function entryPoints(root: string, present: Set<string>): Promise<string[]> {
  const text = await readRepoFile(root, 'package.json');
  if (!text) return [];
  let pkg: { main?: unknown; bin?: unknown; exports?: unknown; module?: unknown };
  try {
    pkg = JSON.parse(text) as typeof pkg;
  } catch {
    return [];
  }
  const candidates: unknown[] = [pkg.main, pkg.module];
  if (typeof pkg.bin === 'string') candidates.push(pkg.bin);
  else if (pkg.bin && typeof pkg.bin === 'object') candidates.push(...Object.values(pkg.bin));
  if (typeof pkg.exports === 'string') candidates.push(pkg.exports);
  const out: string[] = [];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const base = path.posix.normalize(c).replace(/^\.\//, '');
    const hit = [base, `${base}.js`, `${base}/index.js`, `${base}.ts`, `${base}/index.ts`].find((f) => present.has(f));
    if (hit) out.push(hit);
  }
  if (!out.length && present.has('index.js')) out.push('index.js');
  return out;
}

/** Reads a repo-relative file, refusing anything that resolves outside the repo. */
export async function readRepoFile(root: string, rel: string): Promise<string | null> {
  try {
    const realRoot = await realpath(root);
    const abs = await realpath(path.join(realRoot, rel));
    if (abs !== realRoot && !abs.startsWith(realRoot + path.sep)) return null;
    return await readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

export function renderEvidence(pack: EvidencePack): string {
  const blocks = pack.files.map((f) => {
    const width = String(f.lines.length).length;
    const body = f.lines.map((l, i) => `${String(i + 1).padStart(width)}| ${l}`).join('\n');
    const span = f.lines.length < f.totalLines ? `1-${f.lines.length} of ${f.totalLines}` : `1-${f.totalLines}`;
    return `<file path="${f.path}" role="${f.role}" lines="${span}">\n${body}\n</file>`;
  });
  const more = pack.treeTruncated ? `\n… and ${pack.treeTruncated} more` : '';
  return `<source_tree>\n${pack.tree.join('\n')}${more}\n</source_tree>\n\n${blocks.join('\n\n')}`;
}

export interface CitationCheck {
  citation: Citation;
  /** Set when the quote was found, but on other lines than the model said. */
  moved: boolean;
}

/**
 * Checks a citation against the file on disk. A quote that's on the cited lines (whitespace-insensitive,
 * `...` allowed between fragments) is verified; one that is elsewhere in the file, exactly once, is verified
 * with its line numbers corrected. Anything else stays in the report, marked unverified.
 */
export async function verifyCitation(root: string, raw: Omit<Citation, 'verified'>, cache = new Map<string, string[] | null>()): Promise<CitationCheck> {
  const file = raw.file.replace(/^\.?\//, '');
  let lines = cache.get(file);
  if (lines === undefined) {
    const text = await readRepoFile(root, file);
    lines = text === null ? null : text.split(/\r?\n/);
    cache.set(file, lines);
  }
  const startLine = Math.max(1, Math.round(Math.min(raw.startLine, raw.endLine)));
  const endLine = Math.max(startLine, Math.round(Math.max(raw.startLine, raw.endLine)));
  const citation: Citation = { file, startLine, endLine, quote: raw.quote, verified: false };
  if (!lines) return { citation, moved: false };

  const fragments = raw.quote
    .split('\n')
    .map((l) => l.replace(/^\s*\d+\|\s?/, ''))
    .join(' ')
    .split(/\s*(?:\.\.\.|…)\s*/)
    .map(squash)
    .filter((f) => f.length >= 3);
  if (!fragments.length) return { citation, moved: false };
  const within = (from: number, to: number) => {
    const text = squash(lines.slice(from - 1, to).join(' '));
    let at = 0;
    for (const f of fragments) {
      const i = text.indexOf(f, at);
      if (i < 0) return false;
      at = i + f.length;
    }
    return true;
  };

  // Allow the model to be a line or two off at either end.
  if (within(Math.max(1, startLine - 2), Math.min(lines.length, endLine + 2))) {
    return { citation: { ...citation, verified: true }, moved: false };
  }
  // Search the whole file: squash it once, remembering where each line starts.
  const starts: number[] = [];
  let whole = '';
  for (const line of lines) {
    starts.push(whole.length);
    whole += `${squash(line)} `;
  }
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const first = whole.indexOf(fragments[0]!);
  const span = endLine - startLine;
  if (first >= 0 && whole.indexOf(fragments[0]!, first + 1) < 0) {
    const s = lineAt(first);
    if (within(s, Math.min(lines.length, s + span + 2))) {
      return { citation: { ...citation, startLine: s, endLine: Math.min(lines.length, s + span), verified: true }, moved: true };
    }
  }
  return { citation, moved: false };
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
