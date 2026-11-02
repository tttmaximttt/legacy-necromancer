// Bundles the workspace packages into one CLI file for npm. Third-party dependencies stay external and are
// installed from this package's own dependencies, so their native and .wasm files resolve as usual.
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const manifest = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'));
const dist = path.join(here, 'dist');
const ui = path.join(root, 'packages/ui/dist');
const entry = path.join(root, 'packages/cli/dist/bin.js');

for (const needed of [entry, path.join(ui, 'index.html')]) {
  if (!existsSync(needed)) throw new Error(`${path.relative(root, needed)} is missing; run \`pnpm build\` at the repo root first`);
}

// Every runtime dependency of the bundled packages must be listed here, or it would be missing after install.
const require = createRequire(import.meta.url);
const used = new Set();
for (const pkg of ['cli', 'core', 'excavate', 'graveyard', 'interview', 'llm', 'mcp', 'resurrect', 'witness']) {
  const deps = require(path.join(root, 'packages', pkg, 'package.json')).dependencies ?? {};
  for (const name of Object.keys(deps)) if (!name.startsWith('@necromancer/') && name !== 'graphology-types') used.add(name);
}
// The Claude Code plugin runs this exact version through npx, so the three must move together.
const plugin = JSON.parse(await readFile(path.join(root, 'plugin/.claude-plugin/plugin.json'), 'utf8'));
const mcp = JSON.parse(await readFile(path.join(root, 'plugin/.mcp.json'), 'utf8'));
const pinned = mcp.mcpServers.necromancer.args.find((a) => a.startsWith('legacy-necromancer@'));
if (plugin.version !== manifest.version || pinned !== `legacy-necromancer@${manifest.version}`) {
  throw new Error(`version ${manifest.version} must also be in plugin/.claude-plugin/plugin.json and plugin/.mcp.json`);
}

const missing = [...used].filter((name) => !manifest.dependencies[name]);
if (missing.length) throw new Error(`add to dependencies in package.json: ${missing.join(', ')}`);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: { cli: entry },
  outdir: dist,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: Object.keys(manifest.dependencies).flatMap((name) => [name, `${name}/*`]),
  logLevel: 'warning',
});
await cp(ui, path.join(dist, 'ui'), { recursive: true });
console.log(`built ${path.relative(root, dist)}`);
