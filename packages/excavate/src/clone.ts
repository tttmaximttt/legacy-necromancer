import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { errorMessage } from '@necromancer/core';

export interface Checkout {
  root: string;
  /** Removes the checkout if we created it; a no-op for local paths. */
  cleanup(): Promise<void>;
}

/**
 * Accepts a git URL or a local directory. Remote repos are cloned into a temp
 * dir with symlinks disabled, so a planted link can't make us read files
 * outside the checkout. Nothing from the repo is ever executed.
 */
export async function checkout(source: string, options: { workdir?: string } = {}): Promise<Checkout> {
  if (await isDirectory(source)) {
    return { root: path.resolve(source), cleanup: async () => {} };
  }

  const parent = options.workdir ?? path.join(os.tmpdir(), 'necromancer');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, `${slug(source)}-`));
  const git = simpleGit({ config: ['core.symlinks=false'] });
  const base = ['--single-branch', '--no-tags'];
  try {
    // Partial clone: full commit history (needed for churn) without every historical blob.
    await git.clone(source, root, [...base, '--filter=blob:none']);
  } catch {
    await rm(root, { recursive: true, force: true });
    try {
      await git.clone(source, root, base);
    } catch (err) {
      await rm(root, { recursive: true, force: true });
      const detail = errorMessage(err).trim().split('\n').at(-1);
      throw new Error(`could not clone ${source}; is it public and spelled correctly? (${detail})`);
    }
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function slug(source: string): string {
  const name = source.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).at(-1) ?? 'repo';
  return name.replace(/[^\w.-]/g, '_').slice(0, 40);
}
