import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Top-level versions pinned by a lockfile next to the manifest. Supports
 * package-lock / npm-shrinkwrap (v1–v3) and yarn.lock v1, which covers
 * nearly every project old enough to need resurrecting.
 */
export async function readLockedVersions(root: string, manifestDir: string, files: string[]): Promise<Map<string, string>> {
  const at = (f: string) => (manifestDir ? `${manifestDir}/${f}` : f);
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json']) {
    if (files.includes(at(name))) {
      const text = await readFile(path.join(root, at(name)), 'utf8').catch(() => null);
      if (text) return parseNpmLock(text);
    }
  }
  if (files.includes(at('yarn.lock'))) {
    const text = await readFile(path.join(root, at('yarn.lock')), 'utf8').catch(() => null);
    if (text) return parseYarnLock(text);
  }
  return new Map();
}

export function parseNpmLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let lock: { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
  try {
    lock = JSON.parse(text);
  } catch {
    return out;
  }
  if (lock.packages) {
    for (const [key, meta] of Object.entries(lock.packages)) {
      // Only direct children of the root node_modules.
      const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (m && meta.version) out.set(m[1]!, meta.version);
    }
  } else if (lock.dependencies) {
    for (const [name, meta] of Object.entries(lock.dependencies)) if (meta.version) out.set(name, meta.version);
  }
  return out;
}

/** yarn.lock v1 maps `name@range` keys to one resolved version. The newest is the one a top-level range most likely got. */
export function parseYarnLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith(' ') && line.trim().endsWith(':') && !line.startsWith('#')) {
      names = line
        .slice(0, -1)
        .split(',')
        .map((k) => k.trim().replace(/^"|"$/g, ''))
        .map((k) => k.slice(0, k.lastIndexOf('@') > 0 ? k.lastIndexOf('@') : undefined));
      continue;
    }
    const v = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
    if (v && names.length) {
      for (const n of new Set(names)) out.set(n, v[1]!);
      names = [];
    }
  }
  return out;
}
