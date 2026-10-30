import path from 'node:path';

/** Normalise an OS path to the repo-relative POSIX form used in reports. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
