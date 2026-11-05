// The Claude Code plugin installs from main and runs `npx legacy-necromancer@<pin>`, so the pin must always
// name a version that is already on npm (or, before the first publish, the version about to be published).
//
//   node .github/scripts/plugin-version.mjs check        fail if the pin isn't published
//   node .github/scripts/plugin-version.mjs set 0.2.0    point the plugin at 0.2.0
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const PACKAGE = 'legacy-necromancer';
const manifestPath = 'plugin/.claude-plugin/plugin.json';
const mcpPath = 'plugin/.mcp.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
const args = mcp.mcpServers.necromancer.args;
const at = args.findIndex((a) => a.startsWith(`${PACKAGE}@`));
if (at < 0) throw new Error(`${mcpPath} must run ${PACKAGE}@<version>`);
const pinned = args[at].slice(PACKAGE.length + 1);

function published() {
  try {
    return JSON.parse(execFileSync('npm', ['view', PACKAGE, 'versions', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (err) {
    if (/E404/.test(String(err.stderr ?? err))) return null;
    throw err;
  }
}

const [command, version] = process.argv.slice(2);
if (command === 'check') {
  if (manifest.version !== pinned) throw new Error(`${manifestPath} says ${manifest.version} but ${mcpPath} runs ${pinned}`);
  const versions = published();
  if (versions === null) {
    console.log(`${PACKAGE} isn't on npm yet; the first release publishes ${pinned}`);
  } else if (![versions].flat().includes(pinned)) {
    throw new Error(`the plugin runs ${PACKAGE}@${pinned}, which isn't on npm; release it first`);
  } else {
    console.log(`plugin runs ${PACKAGE}@${pinned}, which is published`);
  }
} else if (command === 'set' && version) {
  args[at] = `${PACKAGE}@${version}`;
  manifest.version = version;
  writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`plugin now runs ${PACKAGE}@${version}`);
} else {
  throw new Error('usage: plugin-version.mjs check | set <version>');
}
