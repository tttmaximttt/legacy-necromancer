import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { toPosix } from '@necromancer/core';

/** Directories that hold vendored, generated or installed code rather than the project's own. */
const IGNORED_DIRS = new Set([
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor',
  'dist',
  'build',
  'coverage',
  '.git',
  '.next',
  '.nuxt',
  '.cache',
  'tmp',
]);

const MAX_FILE_BYTES = 512 * 1024;

export function isIgnoredPath(file: string): boolean {
  const parts = file.split('/');
  if (parts.slice(0, -1).some((p) => IGNORED_DIRS.has(p))) return true;
  const name = parts.at(-1) ?? '';
  return /\.min\.[cm]?js$/.test(name) || /[.-]bundle\.js$/.test(name);
}

/**
 * Lists repo-relative POSIX paths. Uses `git ls-files` when possible so
 * .gitignore is respected; falls back to a directory walk.
 */
export async function listRepoFiles(root: string): Promise<string[]> {
  let files: string[];
  try {
    const out = await simpleGit(root).raw(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    files = out.split('\0').filter(Boolean);
  } catch {
    files = await walk(root, '');
  }
  return files.filter((f) => !isIgnoredPath(f)).sort();
}

async function walk(root: string, rel: string): Promise<string[]> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) out.push(...(await walk(root, child)));
    } else if (entry.isFile()) {
      out.push(toPosix(child));
    }
  }
  return out;
}

export async function isTooLarge(file: string): Promise<boolean> {
  try {
    return (await stat(file)).size > MAX_FILE_BYTES;
  } catch {
    return true;
  }
}
