// Packs this package, installs the tarball into an empty project the way `npx` would, and runs the installed
// CLI: catches dependencies the bundle needs at runtime but package.json doesn't declare (createRequire calls
// are invisible to the build's checks) and files missing from the tarball. Run `pnpm build` and this
// package's `build` first.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const manifest = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'));
const TOOLS = ['exhume', 'graveyard', 'interview', 'record_interview', 'resurrect', 'witness'];

function check(ok, message) {
  if (!ok) throw new Error(message);
  console.log(`ok   ${message}`);
}

if (!existsSync(path.join(here, 'dist/cli.js'))) throw new Error('dist/cli.js is missing; run `pnpm build` and then this package\'s `build`');

const tmp = await mkdtemp(path.join(os.tmpdir(), 'necromancer-smoke-'));
try {
  const packDir = path.join(tmp, 'pack');
  const project = path.join(tmp, 'project');
  await mkdir(packDir);
  await mkdir(project);

  const { stdout: packed } = await run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: here });
  const tarball = path.join(packDir, JSON.parse(packed)[0].filename);
  console.log(`packed ${path.basename(tarball)}`);

  await writeFile(path.join(project, 'package.json'), `${JSON.stringify({ name: 'smoke', private: true, type: 'module' })}\n`);
  await run('npm', ['install', tarball, '--ignore-scripts=false', '--no-audit', '--no-fund'], { cwd: project, maxBuffer: 64 << 20 });
  const modules = path.join(project, 'node_modules');
  const bin = path.join(modules, '.bin/necromancer');
  check(existsSync(bin), 'installed the necromancer bin');
  check(
    !existsSync(path.join(modules, 'tree-sitter-javascript')) && !existsSync(path.join(modules, 'tree-sitter-typescript')),
    'tree-sitter grammar packages (node-gyp) are not installed',
  );

  const { stdout: version } = await run(bin, ['--version'], { cwd: project });
  check(version.trim() === manifest.version, `necromancer --version prints ${manifest.version} (got ${version.trim()})`);

  const { stdout: report } = await run(bin, ['exhume', root, '-q'], { cwd: project, maxBuffer: 256 << 20 });
  const { stats, clusters } = JSON.parse(report);
  check(stats.files > 0, `exhume parsed ${stats.files} files into ${clusters.length} clusters`);

  // The SDK comes from the temp install, so this also proves the installed copy works.
  const sdk = createRequire(path.join(project, 'package.json'));
  const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'necromancer-smoke', version: manifest.version });
  await client.connect(new StdioClientTransport({ command: bin, args: ['mcp'], cwd: project, stderr: 'inherit' }));
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    check(TOOLS.every((t) => names.includes(t)), `necromancer mcp lists ${names.join(', ')}`);
  } finally {
    await client.close();
  }
  console.log('smoke passed');
} catch (err) {
  console.error(`smoke failed: ${err.stderr || err.message}`);
  process.exitCode = 1;
} finally {
  await rm(tmp, { recursive: true, force: true });
}
