import type { BuildRecipe, RecipeOp } from '@necromancer/core';
import { z } from 'zod';

/**
 * Fixes never edit the Dockerfile as text: they are ops on a recipe, validated here, and the Dockerfile is
 * rendered from the recipe. That keeps a model's proposals inside a vocabulary we can check (no arbitrary base
 * images, no mounts, no secrets) and makes every attempt reproducible from its ops.
 */

const NODE_TAG = /^\d+(\.\d+){0,2}(-(alpine|slim|stretch|buster|bullseye|bookworm|jessie|wheezy|stretch-slim|buster-slim|bullseye-slim|bookworm-slim))?$/;
const APT_PACKAGE = /^[a-z0-9][a-z0-9+.-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NPM_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const NPM_SPEC = /^[\w.@/:#^~<>=|*+ -]+$/;
const FLAG = /^--[a-z][a-z0-9-]*(=[\w.@/:-]+)?$/;
/** Names whose values must never be baked into an image. */
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)/i;

export const RecipeOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('setNodeImage'), tag: z.string().describe('Tag of the official node image, e.g. "8" or "10.24-stretch"') }),
  z.object({ op: z.literal('aptInstall'), packages: z.array(z.string()) }),
  z.object({ op: z.literal('useDebianArchive').describe('Point apt at archive.debian.org, for images whose Debian release is end-of-life') }),
  z.object({ op: z.literal('setEnv'), name: z.string(), value: z.string() }),
  z.object({ op: z.literal('setDependency'), name: z.string(), version: z.string(), dev: z.boolean().optional() }),
  z.object({ op: z.literal('removeDependency'), name: z.string() }),
  z.object({ op: z.literal('addInstallFlags'), flags: z.array(z.string()).describe('e.g. --legacy-peer-deps, --ignore-engines') }),
  z.object({ op: z.literal('dropLockfile') }),
  z.object({ op: z.literal('globalInstall'), spec: z.string().describe('An npm package spec installed globally, e.g. bower@1') }),
  z.object({ op: z.literal('runBeforeInstall'), command: z.string().describe('A shell command run in the image before installing dependencies') }),
  z.object({ op: z.literal('setBuildCommand'), command: z.string().nullable() }),
  z.object({ op: z.literal('setStartCommand'), command: z.string().nullable() }),
  z.object({ op: z.literal('setPort'), port: z.number().nullable() }),
]);

/** Throws on an op that would leave the sandbox's vocabulary. */
export function validateOp(op: RecipeOp): void {
  const bad = (why: string) => {
    throw new Error(`rejected ${op.op}: ${why}`);
  };
  switch (op.op) {
    case 'setNodeImage':
      if (!NODE_TAG.test(op.tag)) bad(`"${op.tag}" is not an official node image tag`);
      break;
    case 'aptInstall':
      if (!op.packages.length || op.packages.some((p) => !APT_PACKAGE.test(p))) bad('invalid apt package name');
      break;
    case 'setEnv':
      if (!ENV_NAME.test(op.name)) bad(`invalid variable name "${op.name}"`);
      if (SECRET_ENV.test(op.name)) bad(`"${op.name}" looks like a credential; none go into the sandbox`);
      if (/[\n\r]/.test(op.value)) bad('multi-line value');
      break;
    case 'setDependency':
      if (!NPM_NAME.test(op.name)) bad(`invalid package name "${op.name}"`);
      if (!NPM_SPEC.test(op.version)) bad(`invalid version "${op.version}"`);
      break;
    case 'removeDependency':
      if (!NPM_NAME.test(op.name)) bad(`invalid package name "${op.name}"`);
      break;
    case 'addInstallFlags':
      if (op.flags.some((f) => !FLAG.test(f))) bad('flags must look like --name or --name=value');
      break;
    case 'globalInstall':
      if (!/^(@[\w.-]+\/)?[\w.-]+(@[\w.^~<>=*-]+)?$/.test(op.spec)) bad(`invalid package spec "${op.spec}"`);
      break;
    case 'runBeforeInstall':
    case 'setBuildCommand':
    case 'setStartCommand': {
      const command = op.op === 'runBeforeInstall' ? op.command : op.command;
      if (command !== null && (/[\n\r]/.test(command) || command.length > 400)) bad('commands must be one line, under 400 characters');
      break;
    }
    case 'setPort':
      if (op.port !== null && (!Number.isInteger(op.port) || op.port < 1 || op.port > 65535)) bad('invalid port');
      break;
    case 'useDebianArchive':
    case 'dropLockfile':
      break;
  }
}

/** Returns a new recipe; the input is not modified. Ops are validated first, all or nothing. */
export function applyOps(recipe: BuildRecipe, ops: RecipeOp[]): BuildRecipe {
  ops.forEach(validateOp);
  const r: BuildRecipe = structuredClone(recipe);
  const addAll = (list: string[], items: string[]) => {
    for (const i of items) if (!list.includes(i)) list.push(i);
  };
  for (const op of ops) {
    switch (op.op) {
      case 'setNodeImage':
        r.nodeImage = `node:${op.tag}`;
        break;
      case 'aptInstall':
        addAll(r.aptPackages, op.packages);
        break;
      case 'useDebianArchive':
        r.debianArchive = true;
        break;
      case 'setEnv':
        r.env[op.name] = op.value;
        break;
      case 'setDependency':
        r.dependencyPatches[op.name] = { version: op.version, dev: op.dev ?? false };
        break;
      case 'removeDependency':
        r.dependencyPatches[op.name] = { version: null, dev: false };
        break;
      case 'addInstallFlags':
        addAll(r.installFlags, op.flags);
        break;
      case 'dropLockfile':
        r.dropLockfile = true;
        break;
      case 'globalInstall':
        addAll(r.globalInstalls, [op.spec]);
        break;
      case 'runBeforeInstall':
        addAll(r.beforeInstall, [op.command]);
        break;
      case 'setBuildCommand':
        r.buildCommand = op.command;
        break;
      case 'setStartCommand':
        r.startCommand = op.command;
        break;
      case 'setPort':
        r.port = op.port;
        break;
    }
  }
  return r;
}

/** Whether applying `ops` would change anything; a fix that changes nothing would loop forever. */
export function changesRecipe(recipe: BuildRecipe, ops: RecipeOp[]): boolean {
  try {
    return JSON.stringify(applyOps(recipe, ops)) !== JSON.stringify(recipe);
  } catch {
    return false;
  }
}

const LOCKFILES: Record<BuildRecipe['packageManager'], string> = {
  npm: 'package-lock.json',
  yarn: 'yarn.lock',
  pnpm: 'pnpm-lock.yaml',
};

export function installCommand(r: BuildRecipe): string {
  const flags = r.installFlags.length ? ` ${r.installFlags.join(' ')}` : '';
  // A patched manifest no longer matches its lockfile, so the lockfile can only guide the install.
  const frozen = !r.dropLockfile && !Object.keys(r.dependencyPatches).length ? ' --frozen-lockfile' : '';
  switch (r.packageManager) {
    case 'yarn':
      return `yarn install${frozen}${flags}`;
    case 'pnpm':
      return `pnpm install${frozen}${flags}`;
    default:
      // `npm ci` needs npm 5.7+, and a lockfile that matches; plain install works on every era.
      return `npm install${flags}`;
  }
}

/**
 * The Dockerfile only installs dependencies: that is the one step with network access. The build script and the
 * app itself run later in containers with no network.
 */
export function renderDockerfile(r: BuildRecipe, options: { caFile?: string } = {}): string {
  const lines = [`# Generated by necromancer resurrect. Base image pinned to the project's era.`];
  const patches = Object.entries(r.dependencyPatches);
  if (patches.length) {
    lines.push(
      '# Built from a package.json with these changes (the repo itself was not edited):',
      ...patches.map(([name, p]) => `#   ${p.version === null ? `remove ${name}` : `${name}@${p.version}${p.dev ? ' (dev)' : ''}`}`),
    );
  }
  lines.push(`FROM ${r.nodeImage}`, '');
  if (options.caFile) {
    lines.push(
      '# Extra CA for a TLS-intercepting proxy at build time (not a credential).',
      'COPY .necromancer/ca.crt /usr/local/share/ca-certificates/necromancer-ca.crt',
      'ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/necromancer-ca.crt npm_config_cafile=/usr/local/share/ca-certificates/necromancer-ca.crt',
      '',
    );
  }
  if (r.debianArchive) {
    lines.push(
      '# This Debian release is end-of-life; its packages moved to archive.debian.org.',
      "RUN sed -i -e 's|deb.debian.org|archive.debian.org|g' -e 's|security.debian.org|archive.debian.org|g' -e '/-updates/d' /etc/apt/sources.list \\",
      "    && echo 'Acquire::Check-Valid-Until \"false\";' > /etc/apt/apt.conf.d/99archive",
      '',
    );
  }
  if (r.aptPackages.length) {
    lines.push(`RUN apt-get update && apt-get install -y --no-install-recommends ${r.aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*`, '');
  }
  const env = Object.entries(r.env);
  if (env.length) lines.push(`ENV ${env.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' \\\n    ')}`, '');
  const globals = r.bower && !r.globalInstalls.some((g) => g.startsWith('bower')) ? [...r.globalInstalls, 'bower@1'] : r.globalInstalls;
  if (globals.length) lines.push(`RUN npm install -g ${globals.join(' ')}`, '');
  lines.push('WORKDIR /app', '');
  // Manifests first, so dependency layers are cached across source-only retries.
  const lockfile = r.dropLockfile ? '' : ` ${LOCKFILES[r.packageManager]}*`;
  lines.push(`COPY package.json${lockfile} ./`);
  for (const cmd of r.beforeInstall) lines.push(`RUN ${cmd}`);
  lines.push(`RUN ${installCommand(r)}`);
  if (r.bower) lines.push('COPY bower.json .bowerrc* ./', 'RUN bower install --allow-root');
  lines.push('', 'COPY . .', '');
  if (r.port) lines.push(`EXPOSE ${r.port}`);
  lines.push(`CMD ${JSON.stringify(['sh', '-c', r.startCommand ?? 'node .'])}`, '');
  return lines.join('\n');
}

/** package.json as the build context should see it, with the recipe's dependency patches applied. */
export function patchManifest(manifest: Record<string, unknown>, r: BuildRecipe): Record<string, unknown> {
  const out = structuredClone(manifest);
  const deps = (out.dependencies ??= {}) as Record<string, string>;
  const dev = (out.devDependencies ??= {}) as Record<string, string>;
  for (const [name, patch] of Object.entries(r.dependencyPatches)) {
    if (patch.version === null) {
      delete deps[name];
      delete dev[name];
      continue;
    }
    const target = patch.dev || (name in dev && !(name in deps)) ? dev : deps;
    delete deps[name];
    delete dev[name];
    target[name] = patch.version;
  }
  return out;
}
