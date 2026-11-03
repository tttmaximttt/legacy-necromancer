import type { BuildRecipe, FixRisk, RecipeOp } from '@necromancer/core';
import { nodeLine } from '@necromancer/core';

/** Install flags that change what gets installed or skip its safety checks. Others (--legacy-peer-deps, --ignore-engines) only relax resolution. */
const RISKY_FLAGS: Record<string, string> = {
  '--ignore-scripts': 'skips install scripts, so native modules are not built',
  '--force': 'overrides npm’s conflict and integrity checks',
  '-f': 'overrides npm’s conflict and integrity checks',
  '--registry': 'installs from a different registry',
  '--unsafe-perm': 'runs install scripts as root',
};

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

/** Why setting a variable needs the owner's OK, or null when it only tunes the sandbox. Also flags any npm_config_*, yarn_* or NODE_* variable. */
function envRisk(name: string): string | null {
  const upper = name.toUpperCase();
  if (Object.hasOwn(RISKY_ENV, upper)) return RISKY_ENV[upper]!;
  if (upper.startsWith('NPM_CONFIG_')) return 'changes how npm installs';
  if (upper.startsWith('YARN_')) return 'changes how yarn installs';
  if (upper.startsWith('NODE_')) return 'changes how Node runs';
  return null;
}

/** Whether moving between two image tags changes the Node release line. A tag with no version counts as a change unless it is the same tag. */
export function changesNodeLine(from: string, to: string): boolean {
  const a = nodeLine(from);
  const b = nodeLine(to);
  if (a === null || b === null) return from.replace(/^node:/, '') !== to.replace(/^node:/, '');
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
          const from = nodeLine(recipe.nodeImage) ?? recipe.nodeImage.replace(/^node:/, '');
          add(op, `moves Node from ${from} to ${nodeLine(op.tag) ?? op.tag} (node:${op.tag})`);
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
        const risky = op.flags.filter((f) => f.split('=')[0]! in RISKY_FLAGS);
        if (risky.length) add(op, `installs with ${risky.map((f) => `${f}, which ${RISKY_FLAGS[f.split('=')[0]!]}`).join('; ')}`);
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
        const reason = envRisk(op.name);
        if (reason) add(op, `${reason}: ${op.name}=${op.value}`);
        break;
      }
      case 'setPort':
      case 'useDebianArchive':
        break;
    }
  }
  return risks;
}
