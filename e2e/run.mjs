// End-to-end test: runs the built CLI against real Docker on the fixture app in e2e/fixtures, with no model, and
// checks what each stage saved. Opt-in (`pnpm e2e`): it needs Docker and the network (npm registry, advisories,
// GitHub), and takes minutes. Run `pnpm build` first. GITHUB_TOKEN, if set, is passed on for graveyard's rate limit.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const bin = path.join(root, 'packages/cli/dist/bin.js');
const FIXTURE = 'express-era-app';
/** Generous: the first resurrect pulls the era's Node image, and surgeon builds and boots every step twice. */
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
/** The fixture's history: one commit, so graveyard dates it to 2018-06 and resurrect picks Node 8. */
const COMMIT_DATE = '2018-06-15T12:00:00Z';
const KEY_VARIABLES = ['NECROMANCER_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];

let passed = 0;
function check(ok, message) {
  if (!ok) throw new Error(message);
  passed++;
  console.log(`ok   ${message}`);
}

if (!existsSync(bin)) throw new Error('packages/cli/dist/bin.js is missing; run `pnpm build` first');

const started = Date.now();
const tmp = await mkdtemp(path.join(os.tmpdir(), 'necromancer-e2e-'));
const app = path.join(tmp, FIXTURE);
const home = path.join(tmp, 'home');
const reports = path.join(tmp, 'reports');
// An empty home and no key variables, so nothing can reach the Anthropic API; reports and the fix cache stay in tmp.
const env = { ...process.env, HOME: home, USERPROFILE: home, NECROMANCER_REPORTS: reports };
for (const name of KEY_VARIABLES) delete env[name];

/** Runs the CLI, streaming its stderr (progress) through, and returns the exit code and output. */
function necromancer(...args) {
  console.log(`\n$ necromancer ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), COMMAND_TIMEOUT_MS);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? `killed by ${signal} (timeout ${COMMAND_TIMEOUT_MS / 60000} min?)` : code, stdout, stderr });
    });
  });
}

const report = async (kind) => JSON.parse(await readFile(path.join(reports, FIXTURE, `${kind}.json`), 'utf8'));

let dockerFailure = null;
try {
  // The fixture gets its own repo, outside this one, so its git history (and so its era) is fixed.
  await cp(path.join(here, 'fixtures', FIXTURE), app, { recursive: true });
  await mkdir(home);
  const gitEnv = {
    ...env,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
    GIT_AUTHOR_DATE: COMMIT_DATE,
    GIT_COMMITTER_DATE: COMMIT_DATE,
  };
  const git = (...args) => exec('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd: app, env: gitEnv });
  await git('init', '-q');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'Initial commit');
  console.log(`fixture committed at ${app}`);

  // 1. exhume
  let r = await necromancer('exhume', app, '--save', '-q');
  check(r.code === 0, `exhume exits 0 (got ${r.code})`);
  const ex = await report('exhume');
  const routes = (ex.routes ?? []).map((x) => `${x.method} ${x.path}`).sort();
  check(JSON.stringify(routes) === JSON.stringify(['GET /', 'GET /api/pad']), `exhume finds GET / and GET /api/pad (got ${routes.join(', ') || 'none'})`);
  check(ex.history.lastCommit?.startsWith('2018-06'), `exhume reads the fixture's own history (last commit ${ex.history.lastCommit})`);

  // 2. graveyard
  r = await necromancer('graveyard', app, '--save', '-q');
  check(r.code === 0, `graveyard exits 0 (got ${r.code})`);
  const gy = await report('graveyard');
  check(gy.sources.registry === 'ok', `graveyard reached the npm registry (${gy.sources.registry})`);
  check(gy.era.estimate === '2018-06', `graveyard dates the project to 2018-06 (got ${gy.era.estimate})`);
  const status = Object.fromEntries(gy.tombstones.map((t) => [t.name, t.status]));
  check(status['left-pad'] === 'dead', `graveyard marks left-pad dead (got ${status['left-pad']})`);
  check(['dead', 'dying', 'ailing'].includes(status.express), `graveyard flags express 4.16.3 (got ${status.express})`);

  // 3. resurrect
  r = await necromancer('resurrect', app, '--no-llm');
  if (r.code !== 0 && /Docker is not reachable/.test(r.stderr)) {
    dockerFailure = r.stderr.trim().split('\n').at(-1).replace(/^necromancer: /, '');
    throw new Error(`Docker not available: ${dockerFailure}`);
  }
  check(r.code === 0, `resurrect exits 0 (got ${r.code})`);
  const rs = await report('resurrect');
  check(rs.outcome === 'resurrected', `resurrect ends resurrected (got ${rs.outcome}${rs.blockedReason ? `: ${rs.blockedReason}` : ''})`);
  check(rs.recipe.nodeImage === 'node:8', `resurrect boots on the era's Node, node:8 (got ${rs.recipe.nodeImage})`);
  check(rs.recipe.port === 3000 && rs.recipe.startCommand === 'npm start', `resurrect detects port 3000 and \`npm start\` (got ${rs.recipe.port}, ${rs.recipe.startCommand})`);
  check(rs.llm.model === null && rs.llm.tokens === 0, 'resurrect asked no model');

  // 4. witness
  r = await necromancer('witness', app, '--no-llm');
  check(r.code === 0, `witness exits 0 (got ${r.code})`);
  const wi = await report('witness');
  check(wi.routes.found === 2 && wi.routes.exercised === 2, `witness exercises both routes (${wi.routes.exercised}/${wi.routes.found})`);
  const byPath = Object.fromEntries(wi.snapshots.map((s) => [s.case.path, s.response]));
  check(
    wi.snapshots.length === 2 && wi.snapshots.every((s) => s.response.status === 200 && !s.response.error),
    `witness records a 200 snapshot per route (${wi.snapshots.map((s) => `${s.case.path} ${s.response.status ?? s.response.error}`).join(', ')})`,
  );
  check(
    JSON.stringify(byPath['/api/pad']?.body) === JSON.stringify({ padded: '007', spaced: '   abc' }),
    `the /api/pad snapshot holds the app's answer (${JSON.stringify(byPath['/api/pad']?.body)})`,
  );

  // 5. witness --check
  r = await necromancer('witness', app, '--check', '--no-llm');
  check(r.code === 0, `witness --check exits 0 (got ${r.code})`);
  check(/No behaviour changes across 2 request/.test(r.stderr), 'witness --check finds no behaviour changes');

  // 6. surgeon
  r = await necromancer('surgeon', app, '--no-llm');
  const su = await report('surgeon');
  check(su.status === 'complete' || su.status === 'blocked', `surgeon ends COMPLETE or BLOCKED (got ${su.status}${su.blockedReason ? `: ${su.blockedReason}` : ''})`);
  const expected = su.status === 'complete' ? 0 : 2;
  check(r.code === expected, `surgeon exits ${expected} for ${su.status} (got ${r.code})`);
  check(su.baseline.ok, `surgeon's baseline matches the golden snapshots${su.baseline.reason ? ` (${su.baseline.reason})` : ''}`);
  check(su.results.length > 0, `surgeon recorded ${su.results.length} step result(s)`);
  for (const res of su.results) {
    const ok = res.status === 'kept' || ((res.status === 'rolled_back' || res.status === 'skipped') && !!res.reason);
    check(ok, `step ${res.step.n} (${res.step.title}) is ${res.status}${res.reason ? `: ${res.reason}` : ''}`);
  }
  if (su.status === 'complete') check(su.remaining.length === 0, 'a complete surgeon run leaves no step unreached');
  const leftPad = su.results.find((x) => x.step.id === 'dep:left-pad');
  check(leftPad?.status === 'kept', `surgeon keeps the left-pad 1.2.0 → 1.3.0 upgrade (got ${leftPad?.status ?? 'no such step'})`);
  check(su.used.model === null && su.used.tokens === 0, 'surgeon asked no model');

  console.log(`\ne2e passed: ${passed} checks in ${Math.round((Date.now() - started) / 1000)}s`);
} catch (err) {
  console.error(`\nFAIL ${err.stderr || err.message}`);
  console.error(`e2e failed after ${passed} passing check(s) in ${Math.round((Date.now() - started) / 1000)}s`);
  process.exitCode = 1;
} finally {
  if (!dockerFailure) await removeDockerLeftovers();
  await rm(tmp, { recursive: true, force: true });
}

/** Containers and images of this fixture that a failed or killed run may have left; the CLI removes them itself otherwise. */
async function removeDockerLeftovers() {
  const docker = (...args) => exec('docker', args).then((r) => r.stdout.trim(), () => '');
  const repo = `necromancer/${FIXTURE}`;
  const containers = (await docker('ps', '-a', '--filter', 'label=necromancer.sandbox=1', '--format', '{{.ID}} {{.Image}}'))
    .split('\n')
    .filter((line) => line.split(' ')[1]?.startsWith(repo))
    .map((line) => line.split(' ')[0]);
  if (containers.length) await docker('rm', '-f', ...containers);
  const images = (await docker('images', '--filter', `reference=${repo}`, '-q')).split('\n').filter(Boolean);
  if (images.length) await docker('rmi', '-f', ...new Set(images));
  if (containers.length || images.length) console.log(`removed ${containers.length} container(s) and ${new Set(images).size} image(s) left behind`);
}
