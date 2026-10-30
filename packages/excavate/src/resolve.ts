import { builtinModules } from 'node:module';
import path from 'node:path';
import type { RawImport, ResolvedImport } from '@necromancer/core';
import { SOURCE_EXTENSIONS } from './parser.js';

const BUILTINS = new Set(builtinModules);

/** Extensions tried, in order, when a relative specifier omits one. `.json` is last so code wins. */
const PROBE_EXTENSIONS = [...SOURCE_EXTENSIONS, '.json'];

/** TS lets `./foo.js` refer to `./foo.ts`; these are the source files each runtime extension may stand for. */
const TS_SUBSTITUTES: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/**
 * Resolves import specifiers against the set of files in the repo, without
 * touching the filesystem. Keeps analysis fast and lets tests run on
 * in-memory file lists.
 */
export class ImportResolver {
  private readonly files: Set<string>;
  private readonly lowercase = new Map<string, string>();

  /**
   * @param files every repo file, so imports of JSON or assets still count as resolved
   * @param mains package.json `main` per directory ('' for the repo root), for `require('../..')`
   */
  constructor(
    files: Iterable<string>,
    private readonly mains: Record<string, string> = {},
  ) {
    this.files = new Set(files);
    for (const f of this.files) this.lowercase.set(f.toLowerCase(), f);
  }

  resolve(fromFile: string, raw: RawImport): ResolvedImport {
    const spec = raw.specifier;

    if (spec.startsWith('node:')) return { type: 'builtin', module: spec.slice(5), raw };

    if (spec.startsWith('.') || spec.startsWith('/')) {
      const base = spec.startsWith('/')
        ? spec.slice(1)
        : path.posix.join(path.posix.dirname(fromFile), spec);
      const dir = normalizeDir(base);
      const target = this.probe(dir, this.files);
      if (target) return { type: 'internal', target, raw };
      // Works on macOS/Windows, breaks on Linux: worth surfacing, not hiding.
      const insensitive = this.probe(dir.toLowerCase(), this.lowercase);
      if (insensitive) return { type: 'internal', target: this.lowercase.get(insensitive)!, raw, caseMismatch: true };
      return { type: 'unresolved', raw };
    }

    const packageName = packageNameOf(spec);
    if (!packageName) return { type: 'unresolved', raw };
    if (BUILTINS.has(packageName)) return { type: 'builtin', module: packageName, raw };
    return { type: 'external', packageName, raw };
  }

  private probe(base: string, known: { has(file: string): boolean }, followMain = true): string | null {
    const prefix = base ? `${base}/` : '';
    const candidates = base ? [base, ...PROBE_EXTENSIONS.map((ext) => base + ext)] : [];

    const ext = path.posix.extname(base);
    for (const sub of TS_SUBSTITUTES[ext] ?? []) candidates.push(base.slice(0, -ext.length) + sub);

    const hit = candidates.find((c) => known.has(c));
    if (hit) return hit;

    const main = followMain ? this.mainOf(base, known === this.lowercase) : undefined;
    if (main) {
      const viaMain = this.probe(normalizeDir(prefix + main), known, false);
      if (viaMain) return viaMain;
    }
    return PROBE_EXTENSIONS.map((e) => `${prefix}index${e}`).find((c) => known.has(c)) ?? null;
  }

  private mainOf(dir: string, insensitive: boolean): string | undefined {
    if (!insensitive) return this.mains[dir];
    const key = Object.keys(this.mains).find((d) => d.toLowerCase() === dir);
    return key === undefined ? undefined : this.mains[key]?.toLowerCase();
  }
}

/** Normalises to a repo-relative path without leading `./` or trailing `/`; the root is ''. */
function normalizeDir(p: string): string {
  const n = path.posix.normalize(p).replace(/\/+$/, '');
  return n === '.' ? '' : n.replace(/^\.\//, '');
}

/** `lodash/fp` → `lodash`, `@babel/core/lib/x` → `@babel/core`. Also strips webpack loader prefixes. */
export function packageNameOf(specifier: string): string | null {
  const spec = specifier.split('!').pop() ?? '';
  if (!spec || spec.startsWith('.')) return null;
  const parts = spec.split('/');
  if (spec.startsWith('@')) return parts.length >= 2 && parts[1] ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}
