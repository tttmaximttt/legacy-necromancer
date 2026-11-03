import type { BuildRecipe, FixRisk, RecipeOp } from '@necromancer/core';
import { imageTag, imageVariant, nodeLine } from '@necromancer/core';

const SKIPS_DEV = 'skips devDependencies';
const LOCKFILE = 'ignores or rewrites the lockfile';
const TLS = 'changes how TLS certificates are checked';
const PROXY = "changes the proxy the install step's network traffic goes through";
const INTEGRITY = 'skips or rewrites integrity checks';

/** Which dependencies `--omit=<type>` or `--only=<type>` leaves out. */
const omitted = (type: string | undefined): string =>
  type === 'dev' ? SKIPS_DEV : type === 'optional' ? 'skips optionalDependencies' : type === 'peer' ? 'skips peerDependencies' : 'skips some of the dependencies';
const only = (type: string | undefined): string =>
  type === 'prod' || type === 'production' ? SKIPS_DEV : type === 'dev' || type === 'development' ? 'installs only devDependencies' : 'skips some of the dependencies';

/**
 * The only install flags applied without asking, in any `--name[=value]` form: each changes only npm's or yarn's
 * output, or how strictly peer dependencies and engines are checked. Every other flag needs the owner's OK.
 */
const SAFE_FLAGS = new Set([
  // Peer and engine strictness: what npm 6 and old yarn did anyway.
  '--legacy-peer-deps',
  '--ignore-engines',
  // Output and network tuning only: no change to what is installed or from where.
  '--no-audit',
  '--no-fund',
  '--no-progress',
  '--no-color',
  '--loglevel',
  '--network-timeout',
  '--prefer-offline',
  '--no-update-notifier',
  // yarn: never prompt, which a sandbox can't answer anyway.
  '--non-interactive',
]);

/** Why a flag needs the owner's OK, by name, where it is known; the reason may depend on the flag's value. */
const FLAG_RISKS: Record<string, string | ((value: string | undefined) => string)> = {
  '--ignore-scripts': 'skips install scripts, so native modules are not built',
  '--force': 'overrides npm’s conflict and integrity checks',
  '--registry': 'installs from a different registry',
  '--unsafe-perm': 'runs install scripts as root',
  '--script-shell': 'changes the shell that runs install scripts',
  '--production': SKIPS_DEV,
  '--prod': SKIPS_DEV,
  '--omit': omitted,
  '--only': only,
  '--include': 'changes which dependency types are installed',
  '--no-optional': 'skips optionalDependencies',
  '--ignore-optional': 'skips optionalDependencies',
  '--no-package-lock': LOCKFILE,
  '--package-lock': LOCKFILE,
  '--package-lock-only': LOCKFILE,
  '--no-shrinkwrap': LOCKFILE,
  '--no-lockfile': LOCKFILE,
  '--no-frozen-lockfile': LOCKFILE,
  '--pure-lockfile': LOCKFILE,
  '--strict-ssl': TLS,
  '--no-strict-ssl': TLS,
  '--cafile': TLS,
  '--ca': TLS,
  '--proxy': PROXY,
  '--https-proxy': PROXY,
  '--noproxy': PROXY,
  '--skip-integrity-check': INTEGRITY,
  '--update-checksums': INTEGRITY,
};

/**
 * The flags among `flags` that need the owner's OK, each as written with why. `validateOp` only lets single
 * `--name` or `--name=value` entries through, so that is all this parses; anything else is flagged as it is.
 */
function riskyFlags(flags: string[]): string[] {
  const found: string[] = [];
  for (const flag of flags) {
    const m = /^(--[^=]+)(?:=(.*))?$/.exec(flag);
    const name = m?.[1];
    if (name && SAFE_FLAGS.has(name)) continue;
    const reason = name && Object.hasOwn(FLAG_RISKS, name) ? FLAG_RISKS[name]! : null;
    const why = reason === null ? `changes how packages are installed: ${flag}` : typeof reason === 'string' ? reason : reason(m?.[2]);
    found.push(`${flag}, which ${why}`);
  }
  return found;
}

/**
 * The only variables set without asking: each tunes the sandbox (port, host, locale, time zone, CI mode) or turns off
 * a git-hook installer, a postinstall banner or npm's output. None changes what is installed or which commands run;
 * CI can make a build stricter (some treat warnings as errors), which shows up as a failure rather than a silent change.
 */
const SAFE_ENV = new Set([
  'PORT',
  'HOST',
  'CI',
  'TZ',
  'LANG',
  'LC_ALL',
  'HUSKY',
  'ADBLOCK',
  'DISABLE_OPENCOLLECTIVE',
  'OPENCOLLECTIVE_HIDE',
  // Output only: update-notifier's check and terminal colors.
  'NO_UPDATE_NOTIFIER',
  'NO_COLOR',
  'FORCE_COLOR',
  'bower_allow_root',
]);
/** npm settings that only change its output, matched in any case as npm reads them. */
const SAFE_NPM_CONFIG = new Set(['npm_config_loglevel', 'npm_config_progress', 'npm_config_fund', 'npm_config_audit', 'npm_config_update_notifier', 'npm_config_color']);

/** Variables that change what gets installed, how Node runs, or which programs and libraries every process loads. */
const RISKY_ENV: Record<string, string> = {
  NODE_ENV: 'changes what gets installed and how the app runs (production skips devDependencies)',
  NODE_OPTIONS: 'changes how Node runs every script',
  NODE_TLS_REJECT_UNAUTHORIZED: 'turns off TLS certificate checks',
  NODE_PATH: 'changes where Node looks for modules',
  NODE_EXTRA_CA_CERTS: 'changes which TLS certificates Node trusts',
  PATH: 'changes which programs every command runs',
  LD_PRELOAD: 'loads a library into every process',
  LD_LIBRARY_PATH: 'changes which shared libraries every process loads',
};

/**
 * Why setting a variable needs the owner's OK, or null when it is on the allow-list. Specific reasons for the
 * variables above, the proxy variables in any case, and any npm_config_*, yarn_*, NODE_* or LD_* variable; for
 * everything else, that it is set for install, build and run.
 */
function envRisk(name: string, value: string): string | null {
  if (SAFE_ENV.has(name) || name.startsWith('HUSKY_') || SAFE_NPM_CONFIG.has(name.toLowerCase())) return null;
  const upper = name.toUpperCase();
  const why = (reason: string) => `${reason}: ${name}=${value}`;
  if (Object.hasOwn(RISKY_ENV, upper)) return why(RISKY_ENV[upper]!);
  if (upper === 'HTTP_PROXY' || upper === 'HTTPS_PROXY' || upper === 'ALL_PROXY') return why(`sends the install step's network traffic through ${value}`);
  if (upper === 'NO_PROXY') return why('changes which hosts bypass the proxy');
  if (upper.startsWith('NPM_CONFIG_')) return why('changes how npm installs');
  if (upper.startsWith('YARN_')) return why('changes how yarn installs');
  if (upper.startsWith('NODE_')) return why('changes how Node runs');
  if (upper.startsWith('LD_')) return why('changes how every process loads libraries');
  return `sets ${name} for install, build and run: ${name}=${value}`;
}

/** Whether moving between two image tags changes the Node release line. A tag with no version counts as a change unless it is the same tag. */
export function changesNodeLine(from: string, to: string): boolean {
  const a = nodeLine(from);
  const b = nodeLine(to);
  if (a === null || b === null) return imageTag(from) !== imageTag(to);
  return a !== b;
}

/**
 * Why a fix should wait for the owner's OK: it changes the project's dependencies or Node major, installs
 * system software, or changes what runs. Empty means it only tunes the sandbox and is safe to apply.
 */
export function fixRisks(recipe: BuildRecipe, ops: RecipeOp[]): FixRisk[] {
  const risks: FixRisk[] = [];
  const add = (op: RecipeOp, reason: string) => risks.push({ op: op.op, reason });
  for (const op of ops) {
    switch (op.op) {
      case 'setNodeImage': {
        if (changesNodeLine(recipe.nodeImage, op.tag)) {
          const from = nodeLine(recipe.nodeImage) ?? imageTag(recipe.nodeImage);
          add(op, `moves Node from ${from} to ${nodeLine(op.tag) ?? op.tag} (node:${op.tag})`);
        } else if (imageVariant(recipe.nodeImage) !== imageVariant(op.tag)) {
          add(op, `changes the base image's OS: ${recipe.nodeImage} → node:${op.tag}`);
        }
        break;
      }
      case 'aptInstall':
        add(op, `installs Debian packages: ${op.packages.join(', ')}`);
        break;
      case 'setDependency':
        add(op, `changes package.json: sets ${op.name} to ${op.version}${op.dev ? ' (dev)' : ''}`);
        break;
      case 'removeDependency':
        add(op, `changes package.json: removes ${op.name}`);
        break;
      case 'dropLockfile':
        add(op, 'drops the lockfile, so dependency versions are resolved again');
        break;
      case 'addInstallFlags': {
        const risky = riskyFlags(op.flags);
        if (risky.length) add(op, `installs with ${risky.join('; ')}`);
        break;
      }
      case 'globalInstall':
        add(op, `installs ${op.spec} globally in the image`);
        break;
      case 'runBeforeInstall':
        add(op, `runs a command before install: ${op.command}`);
        break;
      case 'setBuildCommand':
        add(op, op.command === null ? 'skips the build step' : `changes the build command to: ${op.command}`);
        break;
      case 'setStartCommand':
        add(op, op.command === null ? 'stops booting the app and only loads it as a library' : `changes the start command to: ${op.command}`);
        break;
      case 'setEnv': {
        const reason = envRisk(op.name, op.value);
        if (reason) add(op, reason);
        break;
      }
      case 'setPort':
      // Only points apt at archive.debian.org, the official archive, for a Debian release that is end-of-life.
      case 'useDebianArchive':
        break;
    }
  }
  return risks;
}
