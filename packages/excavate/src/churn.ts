import { simpleGit } from 'simple-git';
import type { FileChurn, RepoHistory } from '@necromancer/core';

const COMMIT_MARK = '\u0001';

const EMPTY: RepoHistory = { commits: 0, authors: 0, firstCommit: null, lastCommit: null, files: {} };

/**
 * Reads the whole history in one `git log` call and counts, per file, how
 * many commits touched it and by how many authors. Merge commits are skipped
 * because they double-count changes already made on a branch.
 */
export async function readHistory(root: string): Promise<RepoHistory> {
  let out: string;
  try {
    out = await simpleGit(root).raw([
      'log',
      '--no-merges',
      '--no-renames',
      '--name-only',
      `--format=${COMMIT_MARK}%H%x09%ae%x09%aI`,
    ]);
  } catch {
    // Not a git repo, or a repo with no commits yet.
    return EMPTY;
  }
  return parseLog(out);
}

export function parseLog(out: string): RepoHistory {
  const files = new Map<string, { commits: number; authors: Set<string>; lastTouched: string }>();
  const authors = new Set<string>();
  let commits = 0;
  let first: string | null = null;
  let last: string | null = null;

  for (const block of out.split(COMMIT_MARK)) {
    if (!block.trim()) continue;
    const [header = '', ...paths] = block.split('\n');
    const [, email = '', date = ''] = header.split('\t');
    commits++;
    authors.add(email);
    // git log is newest first.
    last ??= date;
    first = date;

    for (const file of paths) {
      if (!file) continue;
      let entry = files.get(file);
      if (!entry) {
        entry = { commits: 0, authors: new Set(), lastTouched: date };
        files.set(file, entry);
      }
      entry.commits++;
      entry.authors.add(email);
    }
  }

  const perFile: Record<string, FileChurn> = {};
  for (const [file, e] of files) {
    perFile[file] = { commits: e.commits, authors: e.authors.size, lastTouched: e.lastTouched };
  }
  return { commits, authors: authors.size, firstCommit: first, lastCommit: last, files: perFile };
}
