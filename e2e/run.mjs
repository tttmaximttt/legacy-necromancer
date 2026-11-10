// End-to-end test: runs the built CLI against real Docker on the fixture app in e2e/fixtures, with no model, and
// checks what each stage saved. Opt-in (`pnpm e2e`): it needs Docker and the network (npm registry, advisories,
// GitHub), and takes minutes. Run `pnpm build` first. GITHUB_TOKEN, if set, is passed on for graveyard's rate limit.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
/** The fixture's copy is named uniquely, so its report slug and image repository (necromancer/<NAME>) are this run's alone. */
const NAME = `${FIXTURE}-e2e-${randomBytes(4).toString('hex')}`;
const MINUTE = 60 * 1000;
/**
 * Per-command limits, in total well under the workflow's timeout-minutes, leaving room for install and build. The first
 * resurrect pulls the era's Node image, and surgeon builds and boots every step twice.
 */
const TIMEOUT_MS = { exhume: 3 * MINUTE, graveyard: 5 * MINUTE, resurrect: 15 * MINUTE, witness: 5 * MINUTE, surgeon: 15 * MINUTE };
/** How long a timed-out or interrupted child gets after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 10 * 1000;
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
const app = path.join(tmp, NAME);
const home = path.join(tmp, 'home');
const reports = path.join(tmp, 'reports');
// An empty home and no key variables, so nothing can reach the Anthropic API; reports and the fix cache stay in tmp.
const env = { ...process.env, HOME: home, USERPROFILE: home, NECROMANCER_REPORTS: reports };
for (const name of KEY_VARIABLES) delete env[name];
// The empty home hides Docker Desktop's per-user socket from docker-modem, which looks for ~/.docker/run/docker.sock
// when DOCKER_HOST is unset. Point DOCKER_HOST at the real one; an existing DOCKER_HOST is passed through as is.
const userSocket = path.join(os.homedir(), '.docker', 'run', 'docker.sock');
if (!process.env.DOCKER_HOST && existsSync(userSocket)) env.DOCKER_HOST = `unix://${userSocket}`;
/** The docker CLI used for cleanup talks to the same daemon as the CLI under test. */
const dockerEnv = env.DOCKER_HOST ? { ...process.env, DOCKER_HOST: env.DOCKER_HOST } : process.env;

/** The child running now, so a signal to this script can stop it. */
let current = null;

/** SIGTERM, then SIGKILL if it hasn't exited after the grace period. */
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  child.once('close', () => clearTimeout(timer));
}

/** Runs the CLI, streaming its stderr (progress) through, and returns the exit code and output; rejects on a timeout. */
function necromancer(...args) {
  const command = `necromancer ${args.join(' ')}`;
  const limit = TIMEOUT_MS[args[0]];
  console.log(`\n$ ${command}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
    current = child;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\n\`${command}\` hung: no exit after ${limit / MINUTE} min; stopping it`);
      stop(child);
    }, limit);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      current = null;
      if (timedOut) reject(new Error(`\`${command}\` timed out after ${limit / MINUTE} min`));
      else resolve({ code: signal ? `killed by ${signal}` : code, stdout, stderr });
    });
  });
}

const report = async (kind) => JSON.parse(await readFile(path.join(reports, NAME, `${kind}.json`), 'utf8'));

let dockerFailure = null;
let cleaning = null;
/** Removes what this run left behind, once, whether the run ends, fails or is interrupted. */
function cleanup() {
  cleaning ??= (async () => {
    if (!dockerFailure) await removeDockerLeftovers().catch((err) => console.error(`docker cleanup failed: ${err.message}`));
    await rm(tmp, { recursive: true, force: true });
  })();
  return cleaning;
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, async () => {
    console.error(`\n${signal}: stopping and cleaning up`);
    if (current) {
      const child = current;
      const closed = new Promise((resolve) => child.once('close', resolve));
      stop(child);
      await closed;
    }
    await cleanup();
    process.exit(code);
  });
}
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
  check([0, 2, 3].includes(r.code), `surgeon exits 0, 2 or 3 (got ${r.code})`);
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
  await cleanup();
}

/**
 * Containers and images of this run that a failed or killed run may have left; the CLI removes them itself otherwise.
 * Images: exactly the repository necromancer/<NAME>. Containers: those labelled necromancer.sandbox=1 (DockerSandbox
 * labels every container it creates; it sets no name or compose project) that were created from that repository or
 * one of its image IDs, plus the labelled containers sharing a network namespace with them, which is how database
 * sidecars are linked to the app. Config.Image keeps the name the container was created from even after its tag
 * moves, so containers of a re-tagged (dangling) image are still caught.
 */
async function removeDockerLeftovers() {
  const docker = (...args) => exec('docker', args, { env: dockerEnv }).then((r) => r.stdout.trim(), () => '');
  const repo = `necromancer/${NAME}`;
  const rows = (await docker('images', '--no-trunc', '--format', '{{.Repository}} {{.Tag}} {{.ID}}'))
    .split('\n')
    .map((line) => line.split(' '))
    .filter(([repository, tag]) => repository === repo && tag !== '<none>');
  // Removed by tag, never by ID, so an image that also carries a tag outside this repository only loses this run's tags.
  const tags = new Set(rows.map(([, tag]) => `${repo}:${tag}`));
  const images = new Set(rows.map(([, , id]) => id));
  const ids = (await docker('ps', '-aq', '--no-trunc', '--filter', 'label=necromancer.sandbox=1')).split('\n').filter(Boolean);
  const labelled = ids.length ? JSON.parse((await docker('inspect', ...ids)) || '[]') : [];
  const ofRepo = (image) => image === repo || image?.startsWith(`${repo}:`);
  const ours = new Set(labelled.filter((c) => ofRepo(c.Config?.Image) || images.has(c.Image)).map((c) => c.Id));
  const joined = (c) => /^container:(.+)$/.exec(c.HostConfig?.NetworkMode ?? '')?.[1];
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of labelled) {
      if (ours.has(c.Id)) continue;
      const linked = ours.has(joined(c)) || labelled.some((o) => ours.has(o.Id) && joined(o) === c.Id);
      if (linked) {
        ours.add(c.Id);
        grew = true;
      }
    }
  }
  if (ours.size) await docker('rm', '-f', ...ours);
  if (tags.size) await docker('rmi', '-f', ...tags);
  if (ours.size || tags.size) console.log(`removed ${ours.size} container(s) and ${tags.size} image tag(s) left behind`);
}
