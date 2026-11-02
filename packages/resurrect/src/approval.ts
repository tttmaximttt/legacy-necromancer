import type { BuildRecipe, FixRisk, RecipeOp } from '@necromancer/core';

/** Install flags that change what gets installed or skip its safety checks. Others (--legacy-peer-deps, --ignore-engines) only relax resolution. */
const RISKY_FLAGS: Record<string, string> = {
  '--ignore-scripts': 'skips install scripts, so native modules are not built',
  '--force': 'overrides npm’s conflict and integrity checks',
  '-f': 'overrides npm’s conflict and integrity checks',
  '--registry': 'installs from a different registry',
  '--unsafe-perm': 'runs install scripts as root',
};

/** Variables that change where or how packages are installed, or how Node runs everything. */
const RISKY_ENV = /^npm_config_|^yarn_|^NODE_TLS_REJECT_UNAUTHORIZED$|^NODE_OPTIONS$/i;

function envRisk(name: string): string {
  if (/^NODE_TLS_REJECT_UNAUTHORIZED$/i.test(name)) return 'turns off TLS certificate checks';
  if (/^NODE_OPTIONS$/i.test(name)) return 'changes how Node runs every script';
  return 'changes how npm installs';
}

const major = (image: string): string | null => /^(?:node:)?(\d+)/.exec(image)?.[1] ?? null;

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
        const from = major(recipe.nodeImage);
        const to = major(op.tag);
        if (from !== to) add(op, `moves Node from ${from ?? recipe.nodeImage} to ${to ?? op.tag} (node:${op.tag})`);
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
      case 'setEnv':
        if (RISKY_ENV.test(op.name)) add(op, `${envRisk(op.name)}: ${op.name}=${op.value}`);
        break;
      case 'setPort':
      case 'useDebianArchive':
        break;
    }
  }
  return risks;
}
