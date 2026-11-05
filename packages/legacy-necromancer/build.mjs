// Bundles the workspace packages into one CLI file for npm. Third-party dependencies stay external and are
// installed from this package's own dependencies, so their native and .wasm files resolve as usual; the
// tree-sitter grammar .wasm files are the exception and are copied into dist/grammars.
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
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

// Every runtime dependency of the bundled packages must be declared here with the same range, or the
// installed package would miss it or resolve a different version than the one the workspace was tested with.
const KINDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
// Only their .wasm grammars are used, and those ship in dist/grammars, so users don't install these packages
// (their node-gyp install scripts fail on machines without a toolchain). They stay devDependencies here.
const GRAMMARS = {
  'tree-sitter-javascript': ['tree-sitter-javascript.wasm'],
  'tree-sitter-typescript': ['tree-sitter-typescript.wasm', 'tree-sitter-tsx.wasm'],
};
const TYPES_ONLY = new Set(['graphology-types']);
const declared = (m) => Object.assign({}, ...KINDS.map((kind) => m[kind] ?? {}));
const runtime = declared(manifest);

const used = new Map(); // name -> Map(range -> [workspace packages declaring it])
for (const pkg of ['cli', 'core', 'excavate', 'graveyard', 'interview', 'llm', 'mcp', 'plan', 'resurrect', 'surgeon', 'witness']) {
  const deps = declared(JSON.parse(await readFile(path.join(root, 'packages', pkg, 'package.json'), 'utf8')));
  for (const [name, range] of Object.entries(deps)) {
    if (name.startsWith('@necromancer/') || TYPES_ONLY.has(name)) continue;
    if (!used.has(name)) used.set(name, new Map());
    const ranges = used.get(name);
    ranges.set(range, [...(ranges.get(range) ?? []), pkg]);
  }
}
const problems = [];
for (const [name, ranges] of used) {
  if (ranges.size > 1) {
    const where = [...ranges].map(([range, pkgs]) => `${range} in ${pkgs.join(', ')}`).join('; ');
    problems.push(`${name}: workspace packages disagree (${where})`);
    continue;
  }
  const [range] = ranges.keys();
  const grammar = name in GRAMMARS;
  const field = grammar ? 'devDependencies' : 'dependencies';
  const ours = grammar ? manifest.devDependencies?.[name] : runtime[name];
  if (grammar && name in runtime) problems.push(`${name}: move to devDependencies (its grammars ship in dist/grammars)`);
  else if (ours === undefined) problems.push(`${name}: add "${name}": "${range}" to ${field}`);
  else if (ours !== range) problems.push(`${name}: ${field} has ${ours}, the workspace declares ${range}`);
}
if (problems.length) throw new Error(`package.json is out of sync with the workspace:\n  ${problems.join('\n  ')}`);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const result = await build({
  entryPoints: { cli: entry },
  outdir: dist,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: Object.keys(runtime).flatMap((name) => [name, `${name}/*`]),
  metafile: true,
  logLevel: 'warning',
});

// Whatever the bundle still imports from outside must be a declared dependency. Requires made through
// createRequire are invisible to esbuild; `pnpm smoke` installs the packed tarball to catch those.
const undeclared = new Set();
for (const output of Object.values(result.metafile.outputs)) {
  for (const { path: spec, external } of output.imports) {
    if (!external || isBuiltin(spec) || spec.startsWith('.') || spec.startsWith('/')) continue;
    const name = spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
    if (!(name in runtime)) undeclared.add(spec);
  }
}
if (undeclared.size) throw new Error(`the bundle imports packages missing from dependencies: ${[...undeclared].join(', ')}`);

// Resolve the grammars from the package that uses them, as the parser does in the workspace.
const excavate = createRequire(path.join(root, 'packages/excavate/package.json'));
await mkdir(path.join(dist, 'grammars'));
for (const [pkg, files] of Object.entries(GRAMMARS)) {
  for (const file of files) await cp(excavate.resolve(`${pkg}/${file}`), path.join(dist, 'grammars', file));
}
await cp(ui, path.join(dist, 'ui'), { recursive: true });
console.log(`built ${path.relative(root, dist)}`);
