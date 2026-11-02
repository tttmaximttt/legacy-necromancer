import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BuildRecipe, RecipeOp, ResurrectPhase } from '@necromancer/core';
import { changesRecipe } from './recipe.js';

export interface FailureContext {
  phase: ResurrectPhase;
  log: string;
  recipe: BuildRecipe;
  /** package.json dependencies and devDependencies, by name. */
  dependencies: Record<string, string>;
  /** Names that are only in devDependencies. */
  devOnly: Set<string>;
}

export interface KnownFix {
  id: string;
  description: string;
  /** The failure this fixes; checked against the tail of the failing step's log. */
  matches: (ctx: FailureContext) => boolean;
  ops: (ctx: FailureContext) => RecipeOp[];
}

/** Debian-based images up to node 10 ship release names whose mirrors moved to archive.debian.org. */
function oldDebian(image: string): boolean {
  const tag = image.replace(/^node:/, '');
  if (/(jessie|stretch|wheezy|buster)/.test(tag)) return true;
  const major = Number(/^(\d+)/.exec(tag)?.[1]);
  return tag.startsWith('0.') || (major > 0 && major <= 16);
}

/** Python 2 package name differs across Debian releases; `python` is python2 on everything up to buster. */
function pythonFor(image: string): string[] {
  const major = Number(/^node:(\d+)/.exec(image)?.[1]);
  return major >= 16 ? ['python3', 'make', 'g++'] : ['python', 'make', 'g++'];
}

/**
 * Failures every dead Node project seems to hit, and their fixes. Checked in order before the model is asked,
 * and free, so most revivals never spend a token.
 */
export const KNOWN_FIXES: KnownFix[] = [
  {
    id: 'debian-archive',
    description: 'The base image’s Debian release is end-of-life; point apt at archive.debian.org',
    matches: ({ log, recipe }) =>
      !recipe.debianArchive &&
      oldDebian(recipe.nodeImage) &&
      /(Failed to fetch https?:\/\/\S*debian\S*\s+404|does not have a Release file|no longer has a Release file|E: Unable to locate package)/i.test(log),
    ops: () => [{ op: 'useDebianArchive' }],
  },
  {
    id: 'node-sass',
    description: 'node-sass has no binary for this platform and its source build fails; swap in sass (Dart Sass), which has the same API',
    matches: ({ log, dependencies }) =>
      'node-sass' in dependencies && /(node-sass|Node Sass|sass\/vendor|binding\.node|libsass)/i.test(log) && /(ERR!|error|Error)/.test(log),
    ops: ({ devOnly }) => [
      { op: 'removeDependency', name: 'node-sass' },
      { op: 'setDependency', name: 'sass', version: '^1.32.0', dev: devOnly.has('node-sass') },
    ],
  },
  {
    id: 'node-gyp-python',
    description: 'A native module needs node-gyp, which needs Python and a C++ toolchain',
    matches: ({ log, recipe }) =>
      !recipe.aptPackages.includes('g++') &&
      /(gyp ERR!.*(find Python|Can't find Python|python2?:? not found|not found: make|make: not found|g\+\+: not found|No such file or directory.*python)|gyp ERR! stack Error: not found: (make|python)|node-pre-gyp.*(Falling back to source compile|Pre-built binaries not (installable|found)))/i.test(log),
    ops: ({ recipe }) => [{ op: 'aptInstall', packages: pythonFor(recipe.nodeImage) }],
  },
  {
    id: 'fibers-node16',
    description: 'fibers does not build on Node 16 or later; use the Node 14 image',
    matches: ({ log, recipe, dependencies }) => 'fibers' in dependencies && /fibers/i.test(log) && Number(/^node:(\d+)/.exec(recipe.nodeImage)?.[1]) >= 16,
    ops: () => [{ op: 'setNodeImage', tag: '14' }],
  },
  {
    id: 'phantomjs-cdn',
    description: 'phantomjs downloads from Bitbucket, which removed the files; use the GitHub mirror',
    matches: ({ log, recipe }) => /phantomjs/i.test(log) && /(bitbucket|404|Error making request|download|ECONNRESET)/i.test(log) && !recipe.env.PHANTOMJS_CDNURL,
    ops: () => [{ op: 'setEnv', name: 'PHANTOMJS_CDNURL', value: 'https://github.com/Medium/phantomjs/releases/download/v2.1.1' }],
  },
  {
    id: 'git-missing',
    description: 'A dependency is installed from git, and the image has no git',
    matches: ({ log, recipe }) => !recipe.aptPackages.includes('git') && /(spawn git ENOENT|not found: git|git: not found|Error: not found: git)/i.test(log),
    ops: () => [{ op: 'aptInstall', packages: ['git'] }],
  },
  {
    id: 'git-ssh-to-https',
    description: 'A dependency points at git over SSH, and the sandbox has no SSH key; fetch it over HTTPS',
    matches: ({ log, recipe }) =>
      /(Permission denied \(publickey\)|Host key verification failed|ssh: not found)/i.test(log) && !recipe.beforeInstall.some((c) => c.includes('insteadOf')),
    ops: () => [
      { op: 'aptInstall', packages: ['git'] },
      { op: 'runBeforeInstall', command: 'git config --global url."https://github.com/".insteadOf ssh://git@github.com/ && git config --global --add url."https://github.com/".insteadOf git@github.com:' },
    ],
  },
  {
    id: 'husky',
    description: 'husky tries to install git hooks, and there is no .git in the build context',
    matches: ({ log, recipe }) => /husky/i.test(log) && /(\.git|git hooks|can't be found|not a git repository)/i.test(log) && !recipe.env.HUSKY,
    ops: () => [
      { op: 'setEnv', name: 'HUSKY', value: '0' },
      { op: 'setEnv', name: 'HUSKY_SKIP_INSTALL', value: '1' },
    ],
  },
  {
    id: 'peer-deps',
    description: 'npm 7+ refuses conflicting peer dependencies that older npm only warned about',
    matches: ({ log, recipe }) => /(ERESOLVE|could not resolve dependency|conflicting peer dependency)/i.test(log) && !recipe.installFlags.includes('--legacy-peer-deps'),
    ops: () => [{ op: 'addInstallFlags', flags: ['--legacy-peer-deps'] }],
  },
  {
    id: 'yarn-engines',
    description: 'yarn refuses packages whose engines field excludes this Node version',
    matches: ({ log, recipe }) =>
      recipe.packageManager === 'yarn' && /The engine "node" is incompatible/i.test(log) && !recipe.installFlags.includes('--ignore-engines'),
    ops: () => [{ op: 'addInstallFlags', flags: ['--ignore-engines'] }],
  },
  {
    id: 'yarn-missing',
    description: 'This old node image predates bundled yarn',
    matches: ({ log, recipe }) => recipe.packageManager === 'yarn' && /yarn: (not found|command not found)/i.test(log) && !recipe.globalInstalls.some((g) => g.startsWith('yarn')),
    ops: () => [{ op: 'globalInstall', spec: 'yarn@1' }],
  },
  {
    id: 'lockfile-integrity',
    description: 'The lockfile’s integrity hashes or resolved URLs no longer match the registry; let the package manager re-resolve',
    matches: ({ log, recipe }) => !recipe.dropLockfile && /(EINTEGRITY|integrity checksum failed|Your lockfile needs to be updated|lockfile.*(out of date|needs to be updated)|ERR_PNPM_OUTDATED_LOCKFILE)/i.test(log),
    ops: () => [{ op: 'dropLockfile' }],
  },
  {
    id: 'unpublished-version',
    description: 'A locked version was unpublished from the registry; let the package manager re-resolve',
    matches: ({ log, recipe }) => !recipe.dropLockfile && /(No matching version found for|ETARGET|404 Not Found.*registry\.npmjs\.org|is not in (the npm|this) registry)/i.test(log),
    ops: () => [{ op: 'dropLockfile' }],
  },
  {
    id: 'openssl-legacy',
    description: 'Webpack 4 uses an MD4 hash that OpenSSL 3 (Node 17+) disables',
    matches: ({ log, recipe }) => /(ERR_OSSL_EVP_UNSUPPORTED|digital envelope routines::unsupported)/.test(log) && !recipe.env.NODE_OPTIONS?.includes('openssl-legacy-provider'),
    ops: () => [{ op: 'setEnv', name: 'NODE_OPTIONS', value: '--openssl-legacy-provider' }],
  },
  {
    id: 'bower-root',
    description: 'An install script runs bower, which is missing or refuses to run as root',
    matches: ({ log }) => /(bower: not found|bower.*(allow-root|ESUDO))/i.test(log),
    ops: () => [
      { op: 'globalInstall', spec: 'bower@1' },
      { op: 'setEnv', name: 'bower_allow_root', value: 'true' },
    ],
  },
];

export function findKnownFix(ctx: FailureContext): KnownFix | null {
  return KNOWN_FIXES.find((f) => f.matches(ctx) && changesRecipe(ctx.recipe, f.ops(ctx))) ?? null;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function cleanLog(log: string): string {
  return log.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
}

/** The last `lines` lines, which is where install and build tools put the error that matters. */
export function tail(log: string, lines = 80): string {
  return cleanLog(log).split('\n').filter((l) => l.trim()).slice(-lines).join('\n');
}

/**
 * A stable fingerprint of an error: the error-looking lines of the tail, with paths, numbers, hashes and
 * versions blanked, so the same failure in two repos (or two attempts) hashes the same.
 */
export function errorSignature(phase: ResurrectPhase, log: string): string {
  const lines = tail(log, 60)
    .split('\n')
    .filter((l) => /(ERR!|error|Error|fatal|E:|not found|failed|Cannot|cannot)/.test(l))
    .map((l) =>
      l
        .replace(/\/[\w./@+-]+/g, '<path>')
        .replace(/\b[0-9a-f]{12,}\b/gi, '<hash>')
        .replace(/\d+(\.\d+)*/g, '<n>')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((l, i, all) => l && all.indexOf(l) === i)
    .slice(0, 6);
  return createHash('sha1').update(`${phase}\n${lines.join('\n')}`).digest('hex').slice(0, 16);
}

/**
 * Fixes the model came up with that made progress, keyed by error signature, so the next repo that hits the
 * same failure gets the fix for free.
 */
export class FixCache {
  private entries: Record<string, { description: string; ops: RecipeOp[]; hits: number }> | null = null;

  constructor(readonly file: string | null) {}

  private async load() {
    if (this.entries) return this.entries;
    try {
      this.entries = this.file ? (JSON.parse(await readFile(this.file, 'utf8')) as typeof this.entries) : {};
    } catch {
      this.entries = {};
    }
    return this.entries!;
  }

  async get(signature: string): Promise<{ description: string; ops: RecipeOp[] } | null> {
    return (await this.load())[signature] ?? null;
  }

  async remember(signature: string, fix: { description: string; ops: RecipeOp[] }): Promise<void> {
    const entries = await this.load();
    entries[signature] = { ...fix, hits: (entries[signature]?.hits ?? 0) + 1 };
    if (!this.file) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(entries, null, 2));
  }
}
