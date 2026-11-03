import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BuildRecipe, GraveyardReport, RecipeOp, ResurrectReport, SandboxSettings } from '@necromancer/core';
import { nodeLine } from '@necromancer/core';
import { ScriptedModel, type StructuredModel } from '@necromancer/llm';
import {
  checkResumable,
  resumeSettings,
  DEFAULT_LIMITS,
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_HEALTH_TIMEOUT_SEC,
  errorSignature,
  FixCache,
  fixRisks,
  KNOWN_FIXES,
  ResumeError,
  NO_MORE_QUESTIONS,
  opsKey,
  prepareResume,
  resurrect,
  type ApprovalRequest,
  type FixProposal,
  type OwnerQuestion,
  type ResumeOverrides,
} from '@necromancer/resurrect';
import { deadApp, expressMongoApp, FakeSandbox, NODE_GYP_LOG } from './helpers.js';

const UNKNOWN = "Error: Cannot find module './config/local.json'\n    at Function.Module._resolveFilename (module.js:470:15)";
const PRIVATE = 'npm ERR! 404 Not Found: @acme/core@1.2.0';

const fix = (ops: FixProposal['ops'], diagnosis = 'config file is gitignored'): FixProposal => ({ diagnosis, decision: 'fix', ops, blockedReason: null, question: null, choices: [] });
const question = (q = 'Is there a public replacement for @acme/core?'): FixProposal => ({
  diagnosis: '@acme/core is not on the public registry',
  decision: 'ask',
  ops: [],
  blockedReason: null,
  question: q,
  choices: ['stub it', 'drop the feature'],
});

const recipe = { nodeImage: 'node:6' } as BuildRecipe;

/** A risky fix the cache holds for the UNKNOWN boot failure: known fixes never wait for the owner, cached ones do. */
const CONFIG_FIX = { description: 'add the config package', ops: [{ op: 'setDependency', name: 'config', version: '^1.0.0' }] as RecipeOp[] };
const CACHE_ID = `cache:${errorSignature('boot', UNKNOWN)}`;
async function riskyCache(): Promise<FixCache> {
  const cache = new FixCache(null);
  await cache.remember(errorSignature('boot', UNKNOWN), CONFIG_FIX);
  return cache;
}

/** The checked resume of `from` with the owner's answer, for a resumed run handed `model`. */
const resumeOf = (from: ResurrectReport, decision: { approve?: boolean; answer?: string }, model: StructuredModel | null = null, overrides?: ResumeOverrides) =>
  prepareResume(from, { model, overrides, ...decision });

describe('fixRisks', () => {
  it('flags changes to dependencies, Node majors, system packages and what runs', () => {
    expect(
      fixRisks(recipe, [
        { op: 'setNodeImage', tag: '14' },
        { op: 'aptInstall', packages: ['python', 'g++'] },
        { op: 'setDependency', name: 'sass', version: '^1.32.0', dev: true },
        { op: 'removeDependency', name: 'node-sass' },
        { op: 'dropLockfile' },
        { op: 'addInstallFlags', flags: ['--legacy-peer-deps', '--ignore-scripts'] },
        { op: 'globalInstall', spec: 'bower@1' },
        { op: 'runBeforeInstall', command: 'echo {} > config.json' },
        { op: 'setBuildCommand', command: null },
        { op: 'setStartCommand', command: 'node app.js' },
      ]),
    ).toEqual([
      { op: 'setNodeImage', reason: 'moves Node from 6 to 14 (node:14)' },
      { op: 'aptInstall', reason: 'installs Debian packages: python, g++' },
      { op: 'setDependency', reason: 'changes package.json: sets sass to ^1.32.0 (dev)' },
      { op: 'removeDependency', reason: 'changes package.json: removes node-sass' },
      { op: 'dropLockfile', reason: 'drops the lockfile, so dependency versions are resolved again' },
      { op: 'addInstallFlags', reason: 'installs with --ignore-scripts, which skips install scripts, so native modules are not built' },
      { op: 'globalInstall', reason: 'installs bower@1 globally in the image' },
      { op: 'runBeforeInstall', reason: 'runs a command before install: echo {} > config.json' },
      { op: 'setBuildCommand', reason: 'skips the build step' },
      { op: 'setStartCommand', reason: 'changes the start command to: node app.js' },
    ]);
  });

  it('lets sandbox tuning through', () => {
    expect(
      fixRisks(recipe, [
        { op: 'setEnv', name: 'HUSKY', value: '0' },
        { op: 'setEnv', name: 'HUSKY_SKIP_INSTALL', value: '1' },
        { op: 'setEnv', name: 'bower_allow_root', value: 'true' },
        { op: 'setEnv', name: 'NPM_CONFIG_LOGLEVEL', value: 'warn' },
        { op: 'setEnv', name: 'npm_config_fund', value: 'false' },
        { op: 'setEnv', name: 'PORT', value: '3000' },
        { op: 'setEnv', name: 'TZ', value: 'UTC' },
        { op: 'setEnv', name: 'DISABLE_OPENCOLLECTIVE', value: '1' },
        { op: 'setPort', port: 8080 },
        { op: 'useDebianArchive' },
        {
          op: 'addInstallFlags',
          flags: ['--legacy-peer-deps', '--ignore-engines', '--no-audit', '--no-fund', '--no-progress', '--loglevel=error', '--network-timeout=600000', '--prefer-offline'],
        },
        { op: 'setNodeImage', tag: '6.17' },
      ]),
    ).toEqual([]);
    expect(fixRisks(recipe, [{ op: 'addInstallFlags', flags: ['--force'] }])[0]!.reason).toMatch(/^installs with --force/);
  });

  it('flags the known fixes that change the project, and only those (they are applied without asking all the same)', () => {
    const ctx = { phase: 'install' as const, log: '', recipe: { nodeImage: 'node:16' } as BuildRecipe, dependencies: {}, devOnly: new Set<string>() };
    const gated = KNOWN_FIXES.filter((k) => fixRisks(ctx.recipe, k.ops(ctx)).length).map((k) => k.id);
    expect(KNOWN_FIXES.map((k) => k.id).filter((id) => !gated.includes(id))).toEqual(['debian-archive', 'husky', 'peer-deps', 'yarn-engines']);
    expect(gated).toContain('phantomjs-cdn');
  });

  it('asks about every install flag and variable that is not on its allow-list', () => {
    const reasons = (ops: Parameters<typeof fixRisks>[1]) => fixRisks(recipe, ops).map((r) => r.reason);
    expect(reasons([{ op: 'addInstallFlags', flags: ['--no-audit', '--build-from-source', '--strict-ssl=false', '--https-proxy=http://evil.example', '--skip-integrity-check'] }])).toEqual([
      'installs with --build-from-source, which changes how packages are installed: --build-from-source; ' +
        '--strict-ssl=false, which changes how TLS certificates are checked; ' +
        "--https-proxy=http://evil.example, which changes the proxy the install step's network traffic goes through; " +
        '--skip-integrity-check, which skips or rewrites integrity checks',
    ]);
    expect(
      reasons([
        { op: 'setEnv', name: 'PHANTOMJS_CDNURL', value: 'https://evil.example' },
        { op: 'setEnv', name: 'CONFIG', value: 'local' },
        { op: 'setEnv', name: 'husky', value: '0' },
        { op: 'setEnv', name: 'LD_AUDIT', value: '/tmp/x.so' },
      ]),
    ).toEqual([
      'sets PHANTOMJS_CDNURL for install, build and run: PHANTOMJS_CDNURL=https://evil.example',
      'sets CONFIG for install, build and run: CONFIG=local',
      'sets husky for install, build and run: husky=0',
      'changes how every process loads libraries: LD_AUDIT=/tmp/x.so',
    ]);
  });

  it('flags variables and flags that change where packages come from', () => {
    expect(
      fixRisks(recipe, [
        { op: 'setEnv', name: 'npm_config_registry', value: 'https://evil.example' },
        { op: 'setEnv', name: 'YARN_IGNORE_ENGINES', value: '1' },
        { op: 'setEnv', name: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' },
        { op: 'setEnv', name: 'NODE_OPTIONS', value: '--require ./x.js' },
      ]),
    ).toEqual([
      { op: 'setEnv', reason: 'changes how npm installs: npm_config_registry=https://evil.example' },
      { op: 'setEnv', reason: 'changes how yarn installs: YARN_IGNORE_ENGINES=1' },
      { op: 'setEnv', reason: 'turns off TLS certificate checks: NODE_TLS_REJECT_UNAUTHORIZED=0' },
      { op: 'setEnv', reason: 'changes how Node runs every script: NODE_OPTIONS=--require ./x.js' },
    ]);
    expect(
      fixRisks(recipe, [
        { op: 'setEnv', name: 'NODE_ENV', value: 'production' },
        { op: 'setEnv', name: 'PATH', value: '/tmp/bin:/usr/bin' },
        { op: 'setEnv', name: 'LD_PRELOAD', value: '/tmp/x.so' },
        { op: 'setEnv', name: 'LD_LIBRARY_PATH', value: '/tmp/lib' },
        { op: 'setEnv', name: 'NODE_PATH', value: '/tmp/mods' },
        { op: 'setEnv', name: 'NODE_DEBUG', value: 'http' },
      ]).map((r) => r.reason),
    ).toEqual([
      'changes what gets installed and how the app runs (production skips devDependencies): NODE_ENV=production',
      'changes which programs every command runs: PATH=/tmp/bin:/usr/bin',
      'loads a library into every process: LD_PRELOAD=/tmp/x.so',
      'changes which shared libraries every process loads: LD_LIBRARY_PATH=/tmp/lib',
      'changes where Node looks for modules: NODE_PATH=/tmp/mods',
      'changes how Node runs: NODE_DEBUG=http',
    ]);
    for (const flags of [['--force'], ['--registry=https://evil.example'], ['--unsafe-perm']]) {
      expect(fixRisks(recipe, [{ op: 'addInstallFlags', flags }]), flags.join(' ')).toHaveLength(1);
    }
  });

  it('flags install flags that skip dependencies or change how the lockfile is used', () => {
    const reasons = (flags: string[]) => fixRisks(recipe, [{ op: 'addInstallFlags', flags }]).map((r) => r.reason);
    expect(reasons(['--production', '--omit=dev', '--omit=optional', '--omit=peer', '--only=prod', '--only=production', '--no-optional'])).toEqual([
      'installs with --production, which skips devDependencies; --omit=dev, which skips devDependencies; --omit=optional, which skips optionalDependencies; ' +
        '--omit=peer, which skips peerDependencies; --only=prod, which skips devDependencies; --only=production, which skips devDependencies; ' +
        '--no-optional, which skips optionalDependencies',
    ]);
    expect(reasons(['--no-package-lock', '--no-lockfile', '--no-frozen-lockfile', '--pure-lockfile'])).toEqual([
      'installs with --no-package-lock, which ignores or rewrites the lockfile; --no-lockfile, which ignores or rewrites the lockfile; ' +
        '--no-frozen-lockfile, which ignores or rewrites the lockfile; --pure-lockfile, which ignores or rewrites the lockfile',
    ]);
    expect(reasons(['--registry=https://evil.example'])).toEqual(['installs with --registry=https://evil.example, which installs from a different registry']);
    expect(reasons(['--omit=whatever'])).toEqual(['installs with --omit=whatever, which skips some of the dependencies']);
    expect(reasons(['--legacy-peer-deps', '--ignore-engines', '--prefer-offline'])).toEqual([]);
  });

  it('flags proxy variables in any case', () => {
    expect(
      fixRisks(recipe, [
        { op: 'setEnv', name: 'HTTP_PROXY', value: 'http://evil.example:3128' },
        { op: 'setEnv', name: 'https_proxy', value: 'http://evil.example:3128' },
        { op: 'setEnv', name: 'All_Proxy', value: 'socks5://evil.example' },
        { op: 'setEnv', name: 'no_proxy', value: 'registry.npmjs.org' },
      ]).map((r) => r.reason),
    ).toEqual([
      "sends the install step's network traffic through http://evil.example:3128: HTTP_PROXY=http://evil.example:3128",
      "sends the install step's network traffic through http://evil.example:3128: https_proxy=http://evil.example:3128",
      "sends the install step's network traffic through socks5://evil.example: All_Proxy=socks5://evil.example",
      'changes which hosts bypass the proxy: no_proxy=registry.npmjs.org',
    ]);
  });
});

describe('Node release lines', () => {
  it('treats each 0.x minor as its own line', () => {
    expect(['0.10', 'node:0.10-slim', '0.12.18', 'node:0.12.18-wheezy', '6', '6.17-stretch', 'node:14.21.3', 'lts', 'argon', '0'].map(nodeLine)).toEqual([
      '0.10',
      '0.10',
      '0.12',
      '0.12',
      '6',
      '6',
      '14',
      null,
      null,
      null,
    ]);
  });

  it('asks before moving between 0.x lines or to a tag with no version', () => {
    const old = { nodeImage: 'node:0.10' } as BuildRecipe;
    expect(fixRisks(old, [{ op: 'setNodeImage', tag: '0.12' }])).toEqual([{ op: 'setNodeImage', reason: 'moves Node from 0.10 to 0.12 (node:0.12)' }]);
    expect(fixRisks(old, [{ op: 'setNodeImage', tag: '0.12.18' }])).toHaveLength(1);
    expect(fixRisks(old, [{ op: 'setNodeImage', tag: '0.10-slim' }])).toEqual([{ op: 'setNodeImage', reason: "changes the base image's OS: node:0.10 → node:0.10-slim" }]);
    expect(fixRisks(old, [{ op: 'setNodeImage', tag: '0.10.48' }])).toEqual([]);
    expect(fixRisks(old, [{ op: 'setNodeImage', tag: 'argon' }])).toEqual([{ op: 'setNodeImage', reason: 'moves Node from 0.10 to argon (node:argon)' }]);
    expect(fixRisks({ nodeImage: 'node:lts' } as BuildRecipe, [{ op: 'setNodeImage', tag: '18' }])).toEqual([
      { op: 'setNodeImage', reason: 'moves Node from lts to 18 (node:18)' },
    ]);
    expect(fixRisks({ nodeImage: 'node:lts' } as BuildRecipe, [{ op: 'setNodeImage', tag: 'lts' }])).toEqual([]);
  });

  it('asks before changing the base image’s OS on the same Node line, not before a version-only change', () => {
    const risks = (from: string, tag: string) => fixRisks({ nodeImage: from } as BuildRecipe, [{ op: 'setNodeImage', tag }]).map((r) => r.reason);
    expect(risks('node:16', '16-alpine')).toEqual(["changes the base image's OS: node:16 → node:16-alpine"]);
    expect(risks('node:10.24-stretch', '10.24-buster')).toEqual(["changes the base image's OS: node:10.24-stretch → node:10.24-buster"]);
    expect(risks('node:10-stretch', '10.24-stretch')).toEqual([]);
    expect(risks('node:16.20', '16')).toEqual([]);
  });
});

describe('declined fix keys', () => {
  it('match the same ops whatever the key order, apt package order or flag order', () => {
    const a = opsKey([
      { op: 'aptInstall', packages: ['python', 'g++'] },
      { op: 'addInstallFlags', flags: ['--ignore-scripts', '--force'] },
      { op: 'setDependency', name: 'sass', version: '^1.32.0', dev: true },
    ]);
    const b = opsKey(
      JSON.parse(
        '[{"packages":["g++","python"],"op":"aptInstall"},{"flags":["--force","--ignore-scripts"],"op":"addInstallFlags"},{"dev":true,"version":"^1.32.0","name":"sass","op":"setDependency"}]',
      ),
    );
    expect(b).toBe(a);
    expect(opsKey([{ op: 'setEnv', name: 'A', value: '1' }])).not.toBe(opsKey([{ op: 'setEnv', name: 'A', value: '2' }]));
  });

  it('match fixes with the same effect: defaults filled in, ops in any order, apt packages merged or split, duplicates once', () => {
    // The README's node-sass case: the declined known fix, and the model's reordered copy with dev left out.
    expect(opsKey([{ op: 'setDependency', name: 'sass', version: '^1.32.0' }, { op: 'removeDependency', name: 'node-sass' }])).toBe(
      opsKey([
        { op: 'removeDependency', name: 'node-sass' },
        { op: 'setDependency', name: 'sass', version: '^1.32.0', dev: false },
      ]),
    );
    expect(opsKey([{ op: 'aptInstall', packages: ['python', 'make', 'g++'] }])).toBe(
      opsKey([
        { op: 'aptInstall', packages: ['g++'] },
        { op: 'aptInstall', packages: ['python', 'make'] },
      ]),
    );
    expect(opsKey([{ op: 'aptInstall', packages: ['git'] }, { op: 'addInstallFlags', flags: ['--force'] }])).toBe(
      opsKey([
        { op: 'addInstallFlags', flags: ['--force', '--force'] },
        { op: 'aptInstall', packages: ['git', 'git'] },
        { op: 'aptInstall', packages: ['git'] },
        { op: 'addInstallFlags', flags: ['--force'] },
      ]),
    );
    expect(opsKey([{ op: 'dropLockfile' }, { op: 'globalInstall', spec: 'bower@1' }])).toBe(
      opsKey([{ op: 'globalInstall', spec: 'bower@1' }, { op: 'dropLockfile' }, { op: 'dropLockfile' }, { op: 'globalInstall', spec: 'bower@1' }]),
    );
    // Of the ops that set one thing, the last counts, as applyOps has it.
    expect(opsKey([{ op: 'setDependency', name: 'sass', version: '1' }, { op: 'removeDependency', name: 'sass' }])).toBe(
      opsKey([{ op: 'removeDependency', name: 'sass' }]),
    );
    expect(opsKey([{ op: 'setNodeImage', tag: '8' }, { op: 'setNodeImage', tag: '10' }])).not.toBe(opsKey([{ op: 'setNodeImage', tag: '10' }, { op: 'setNodeImage', tag: '8' }]));
    // Commands run before install are a sequence.
    const a: RecipeOp = { op: 'runBeforeInstall', command: 'echo a' };
    const b: RecipeOp = { op: 'runBeforeInstall', command: 'echo b' };
    expect(opsKey([a, { op: 'dropLockfile' }, b])).toBe(opsKey([{ op: 'dropLockfile' }, a, b, a]));
    expect(opsKey([a, b])).not.toBe(opsKey([b, a]));
  });

  it('passes over a known fix with the same effect as a model fix the owner declined', async () => {
    const manifest = { name: 'dead-styles', main: 'server.js', scripts: { start: 'node server.js' }, dependencies: { express: '^4.15.0', 'node-sass': '^4.5.0' } };
    const root = await deadApp({ ...expressMongoApp, 'package.json': JSON.stringify(manifest) });
    const swap = fix(
      [
        { op: 'setDependency', name: 'sass', version: '^1.32.0' },
        { op: 'removeDependency', name: 'node-sass' },
      ],
      'swap node-sass for sass',
    );
    const model = new ScriptedModel(swap, fix([{ op: 'setEnv', name: 'CI', value: 'true' }]), fix([{ op: 'setEnv', name: 'TZ', value: 'UTC' }]));
    const verdicts: string[] = [];
    const sandbox = new FakeSandbox({
      // The swap is declined at boot; when node-sass then fails to install, the known fix would make the same change.
      boot: [{ ok: false, log: UNKNOWN }],
      install: [{ ok: true }, { ok: false, log: 'npm ERR! node-sass@4.5.0 postinstall: `node scripts/build.js`\nError: Node Sass does not yet support your current environment' }],
    });
    const report = await resurrect(root, { sandbox, model, approve: async (r) => (verdicts.push(r.fix.description), 'reject') });
    expect(verdicts).toEqual(['swap node-sass for sass']);
    expect(report.outcome).toBe('resurrected');
    expect(report.attempts.map((a) => a.fix?.source ?? null)).toEqual(['llm', 'llm', null]);
    expect(sandbox.manifests.at(-1)!.dependencies).toHaveProperty('node-sass');
  });

  it('refuses a declined model fix that comes back reordered', async () => {
    const first = fix([{ op: 'aptInstall', packages: ['python', 'g++'] }], 'install python and g++');
    const reordered = fix(JSON.parse('[{"packages":["g++","python"],"op":"aptInstall"}]'), 'install them again');
    const model = new ScriptedModel(first, reordered, fix([{ op: 'setEnv', name: 'CI', value: 'true' }]));
    const verdicts: string[] = [];
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model,
      approve: async (r) => (verdicts.push(r.fix.description), 'reject'),
    });
    expect(report.outcome).toBe('resurrected');
    expect(verdicts).toEqual(['install python and g++']);
    expect(report.warnings).toEqual(['attempt 1: rejected a proposed fix (the owner already declined that fix)']);
  });
});

describe('owner approval', () => {
  it('applies a risky known fix without asking, and records that it did', async () => {
    let asked = 0;
    const progress: string[] = [];
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: NODE_GYP_LOG }] }),
      approve: async () => (asked++, 'pause'),
      onProgress: (m) => progress.push(m),
    });
    expect(report.outcome).toBe('resurrected');
    expect(asked).toBe(0);
    expect(report.attempts[0]!.fix).toMatchObject({ source: 'known', id: 'node-gyp-python' });
    expect(progress).toContain('attempt 1: applying known fix node-gyp-python without asking, though it installs Debian packages: python, make, g++');
    expect(report.decisions).toEqual([
      {
        attempt: 1,
        kind: 'approval',
        by: 'auto',
        subject: 'node-gyp-python',
        answer: 'approved',
        description: 'A native module needs node-gyp, which needs Python and a C++ toolchain',
        risks: [{ op: 'aptInstall', reason: 'installs Debian packages: python, make, g++' }],
        at: expect.any(String),
      },
    ]);
    expect(report.pending).toBeNull();
  });

  it('asks before a risky cached fix and applies it when approved', async () => {
    const requests: ApprovalRequest[] = [];
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      fixCache: await riskyCache(),
      approve: async (r) => (requests.push(r), 'approve'),
    });
    expect(report.outcome).toBe('resurrected');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      attempt: 1,
      phase: 'boot',
      fix: { source: 'cache', id: CACHE_ID },
      risks: [{ op: 'setDependency', reason: 'changes package.json: sets config to ^1.0.0' }],
    });
    expect(requests[0]!.errorExcerpt).toContain('Cannot find module');
    expect(report.decisions).toEqual([
      {
        attempt: 1,
        kind: 'approval',
        by: 'owner',
        subject: CACHE_ID,
        answer: 'approved',
        description: 'add the config package',
        risks: [{ op: 'setDependency', reason: 'changes package.json: sets config to ^1.0.0' }],
        at: expect.any(String),
      },
    ]);
    expect(report.pending).toBeNull();
    expect(report.resume).toBeNull();
  });

  it('records a blanket approval as automatic, and never shows the model an automatic decision as the owner’s', async () => {
    const model = new ScriptedModel(
      fix([{ op: 'setDependency', name: 'config', version: '^1.0.0' }], 'add the config package'),
      fix([{ op: 'setEnv', name: 'CI', value: 'true' }]),
    );
    const cache = new FixCache(null);
    const report = await resurrect(await deadApp(expressMongoApp), {
      // A known fix, then a model fix approved by --yes, then a failure the model is asked about again.
      sandbox: new FakeSandbox({ install: [{ ok: false, log: NODE_GYP_LOG }], boot: [{ ok: false, log: UNKNOWN }, { ok: false, log: `${UNKNOWN}\nError: variant` }] }),
      model,
      fixCache: cache,
      approve: async () => 'auto-approve',
    });
    expect(report.outcome).toBe('resurrected');
    expect(report.decisions).toMatchObject([
      { attempt: 1, by: 'auto', subject: 'node-gyp-python', answer: 'approved' },
      { attempt: 2, by: 'auto', subject: expect.stringMatching(/^llm:/), answer: 'approved', description: 'add the config package' },
    ]);
    for (const request of model.requests) expect(request.prompt).not.toContain('owner');
    expect(model.requests[1]!.prompt).toContain('applied llm:');
    // Nobody answered a question, so the model fix that got past its error is cached.
    expect(await cache.get(report.attempts[1]!.signature!)).toMatchObject({ description: 'add the config package' });
  });

  it('does not ask about safe fixes', async () => {
    let asked = 0;
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: 'npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE could not resolve dependency' }] }),
      approve: async () => (asked++, 'approve'),
    });
    expect(report.outcome).toBe('resurrected');
    expect(report.attempts[0]!.fix).toMatchObject({ id: 'peer-deps' });
    expect(asked).toBe(0);
    expect(report.decisions).toEqual([]);
  });

  it('blocks when the owner declines a cached fix and nothing else fits', async () => {
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      fixCache: await riskyCache(),
      model: null,
      approve: async () => 'reject',
    });
    expect(report.outcome).toBe('blocked');
    expect(report.blockedReason).toBe(`the owner declined ${CACHE_ID} and there is no other fix for: Error: Cannot find module './config/local.json'`);
    expect(report.decisions).toMatchObject([{ kind: 'approval', by: 'owner', subject: CACHE_ID, answer: 'rejected' }]);
    expect(report.attempts[0]!.fix).toBeNull();
  });

  it('asks the model for something else when the owner declines a cached fix', async () => {
    const model = new ScriptedModel(fix([{ op: 'setEnv', name: 'CI', value: 'true' }], 'skip the source build'));
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      fixCache: await riskyCache(),
      model,
      approve: async () => 'reject',
    });
    expect(report.outcome).toBe('resurrected');
    expect(report.attempts[0]!.fix).toMatchObject({ source: 'llm' });
    const prompt = model.requests[0]!.prompt;
    expect(prompt).toContain('Your previous proposal was rejected: the owner declined it: add the config package');
    expect(prompt).toContain(`The owner's decisions so far:\n- attempt 1: the owner rejected fix ${CACHE_ID}`);
  });

  it('re-asks the model when the owner declines its fix, and refuses the same fix twice', async () => {
    const risky = fix([{ op: 'setDependency', name: 'config', version: '^1.0.0' }], 'add the config package');
    const model = new ScriptedModel(risky, risky, fix([{ op: 'setEnv', name: 'CI', value: 'true' }]));
    const verdicts: string[] = [];
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model,
      approve: async (r) => (verdicts.push(r.fix.description), 'reject'),
    });
    expect(report.outcome).toBe('resurrected');
    expect(verdicts).toEqual(['add the config package']);
    expect(model.requests[1]!.prompt).toContain('the owner declined it: add the config package');
    expect(report.warnings).toEqual(['attempt 1: rejected a proposed fix (the owner already declined that fix)']);
    expect(report.attempts[0]!.fix).toMatchObject({ ops: [{ op: 'setEnv', name: 'CI' }] });
  });

  it('names a declined model fix by what it does', async () => {
    const model = new ScriptedModel(
      fix([{ op: 'setDependency', name: 'config', version: '^1.0.0' }], 'add the config package'),
      fix([{ op: 'setEnv', name: 'CI', value: 'true' }]),
    );
    await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model,
      approve: async () => 'reject',
    });
    expect(model.requests[1]!.prompt).toContain('- attempt 1: the owner rejected fix "add the config package"');
  });

  it('pauses as needs-you with the pending fix and the state to resume from', async () => {
    const progress: string[] = [];
    const sandbox = new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] });
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox,
      fixCache: await riskyCache(),
      approve: async () => 'pause',
      onProgress: (m) => progress.push(m),
    });
    expect(report.outcome).toBe('needs-you');
    expect(report.blockedReason).toBeNull();
    expect(report.pending).toMatchObject({ kind: 'approval', fix: { source: 'cache', id: CACHE_ID }, risks: [{ op: 'setDependency' }] });
    expect(report.resume).toMatchObject({
      nextAttempt: 2,
      failure: { attempt: 1, phase: 'boot', signature: report.attempts[0]!.signature },
      seen: { [report.attempts[0]!.signature!]: 1 },
      tokens: 0,
      calls: 0,
    });
    expect(report.resume!.failure.log).toContain('Cannot find module');
    expect(report.attempts[0]!.fix).toBeNull();
    expect(report.decisions).toEqual([]);
    expect(sandbox.cleaned).toBe(1);
    expect(progress.at(-1)).toBe('NEEDS YOU: approve add the config package');
  });
});

describe('questions', () => {
  it('passes the owner’s answer into the next request', async () => {
    const model = new ScriptedModel(question(), fix([{ op: 'setEnv', name: 'LANG', value: 'C.UTF-8' }]));
    const asked: OwnerQuestion[] = [];
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }),
      model,
      ask: async (q) => (asked.push(q), 'stub it'),
    });
    expect(report.outcome).toBe('resurrected');
    expect(asked).toEqual([
      {
        kind: 'question',
        attempt: 1,
        question: 'Is there a public replacement for @acme/core?',
        context: `@acme/core is not on the public registry Failing line: ${PRIVATE}`,
        choices: ['stub it', 'drop the feature'],
      },
    ]);
    const prompt = model.requests[1]!.prompt;
    expect(prompt).toContain('The owner answered your question: stub it');
    expect(prompt).toContain('- attempt 1: asked "Is there a public replacement for @acme/core?"; the owner answered: stub it');
    expect(report.decisions).toMatchObject([{ attempt: 1, kind: 'question', subject: 'Is there a public replacement for @acme/core?', answer: 'stub it' }]);
  });

  it('keeps the owner’s answer when they decline the fix built on it', async () => {
    const model = new ScriptedModel(
      question(),
      fix([{ op: 'setDependency', name: '@acme/core', version: 'file:./stub' }], 'stub @acme/core'),
      fix([{ op: 'setEnv', name: 'LANG', value: 'C.UTF-8' }]),
    );
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }),
      model,
      ask: async () => 'stub it',
      approve: async () => 'reject',
    });
    expect(report.outcome).toBe('resurrected');
    expect(model.requests[2]!.prompt).toContain('The owner answered your question: stub it');
    expect(model.requests[2]!.prompt).toContain('the owner declined it: stub @acme/core');
  });

  it('tells the model after three answers that it can no longer ask, and offers it no "ask"', async () => {
    const model = new ScriptedModel(question('one?'), question('two?'), question('three?'), { ...fix([]), decision: 'blocked', blockedReason: 'nothing left to try' });
    const asked: string[] = [];
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }),
      model,
      ask: async (q) => (asked.push(q.question), 'no idea'),
    });
    expect(report.outcome).toBe('blocked');
    expect(report.blockedReason).toBe('nothing left to try');
    expect(asked).toEqual(['one?', 'two?', 'three?']);
    expect(report.llm.calls).toBe(4);
    expect(model.requests[2]!.prompt).not.toContain(NO_MORE_QUESTIONS);
    expect(model.requests[2]!.schema.safeParse(question()).success).toBe(true);
    expect(model.requests[3]!.prompt).toContain('you can no longer ask: propose a fix, or answer "blocked"');
    expect(model.requests[3]!.schema.safeParse(question('four?')).success).toBe(false);
  });

  it('gives up on a fourth question from a model that ignores the schema', async () => {
    const answers = [question('one?'), question('two?'), question('three?'), question('four?')];
    const model: StructuredModel = {
      name: 'unchecked',
      generate: async <T,>() => ({ output: answers.shift() as T, model: 'unchecked', fellBack: false, usage: { inputTokens: 0, outputTokens: 0 } }),
    };
    const asked: string[] = [];
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }),
      model,
      ask: async (q) => (asked.push(q.question), 'no idea'),
    });
    expect(report.blockedReason).toBe(`asked the owner 3 questions about this failure and still no fix: ${PRIVATE}`);
    expect(asked).toEqual(['one?', 'two?', 'three?']);
  });

  it('still shows the owner a risky fix built on three answers', async () => {
    const risky = fix([{ op: 'setDependency', name: '@acme/core', version: 'file:./stub' }], 'stub @acme/core');
    const model = new ScriptedModel(question('one?'), question('two?'), question('three?'), risky);
    const shown: string[] = [];
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }),
      model,
      ask: async () => 'stub it',
      approve: async (r) => (shown.push(r.fix.description), 'approve'),
    });
    expect(shown).toEqual(['stub @acme/core']);
    expect(report.outcome).toBe('resurrected');
    expect(report.attempts[0]!.fix).toMatchObject({ description: 'stub @acme/core' });
  });

  it('asks about a fix after three answers and pauses on it, then carries on', async () => {
    const root = await deadApp(expressMongoApp);
    const risky = fix([{ op: 'setDependency', name: '@acme/core', version: 'file:./stub' }], 'stub @acme/core');
    const from = await resurrect(root, {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }),
      model: new ScriptedModel(question('one?'), question('two?'), question('three?'), risky),
      ask: async () => 'stub it',
      approve: async () => 'pause',
    });
    expect(from.outcome).toBe('needs-you');
    expect(from.pending).toMatchObject({ kind: 'approval', fix: { description: 'stub @acme/core' } });
    expect(from.resume).toMatchObject({ questions: 3, declines: 0 });
    const report = await resurrect(root, { sandbox: new FakeSandbox({}), resume: resumeOf(from, { approve: true }, null, { model: null }) });
    expect(report.outcome).toBe('resurrected');
  });

  it('gives up once the owner has declined three fixes for one failure', async () => {
    const model = new ScriptedModel(
      fix([{ op: 'setDependency', name: 'a', version: '1' }], 'add a'),
      fix([{ op: 'setDependency', name: 'b', version: '1' }], 'add b'),
      fix([{ op: 'setDependency', name: 'c', version: '1' }], 'add c'),
      fix([{ op: 'setDependency', name: 'd', version: '1' }], 'add d'),
    );
    const shown: string[] = [];
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model,
      approve: async (r) => (shown.push(r.fix.description), 'reject'),
    });
    expect(shown).toEqual(['add a', 'add b', 'add c']);
    expect(report.outcome).toBe('blocked');
    expect(report.blockedReason).toBe(
      `the owner declined 3 fixes for this failure ("add a", "add b", "add c"): Error: Cannot find module './config/local.json'`,
    );
    expect(report.llm.calls).toBe(3);
  });

  it('counts answers and declines separately', async () => {
    const model = new ScriptedModel(
      question('one?'),
      fix([{ op: 'setDependency', name: 'a', version: '1' }], 'add a'),
      question('two?'),
      fix([{ op: 'setDependency', name: 'b', version: '1' }], 'add b'),
      question('three?'),
      fix([{ op: 'setEnv', name: 'CI', value: 'true' }], 'set CI'),
    );
    const verdicts: Array<'reject' | 'approve'> = ['reject', 'reject'];
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model,
      ask: async () => 'sure',
      approve: async () => verdicts.shift()!,
    });
    expect(report.outcome).toBe('resurrected');
    expect(report.attempts[0]!.fix).toMatchObject({ description: 'set CI' });
  });

  it('keeps a fix built on the owner’s answer out of the shared cache', async () => {
    const cache = new FixCache(null);
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }),
      model: new ScriptedModel(question(), fix([{ op: 'setEnv', name: 'LANG', value: 'C.UTF-8' }])),
      ask: async () => 'stub it',
      fixCache: cache,
    });
    expect(report.outcome).toBe('resurrected');
    expect(await cache.get(report.attempts[0]!.signature!)).toBeNull();
  });

  it('pauses when there is nobody to ask, or no answer', async () => {
    for (const ask of [undefined, async () => null]) {
      const progress: string[] = [];
      const report = await resurrect(await deadApp(expressMongoApp), {
        sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }),
        model: new ScriptedModel(question()),
        ask,
        onProgress: (m) => progress.push(m),
      });
      expect(report.outcome).toBe('needs-you');
      expect(report.pending).toMatchObject({ kind: 'question', question: 'Is there a public replacement for @acme/core?' });
      expect(report.resume).toMatchObject({ nextAttempt: 2, calls: 1 });
      expect(progress.at(-1)).toBe('NEEDS YOU: Is there a public replacement for @acme/core?');
    }
  });
});

describe('resume', () => {
  async function paused() {
    const root = await deadApp(expressMongoApp);
    const report = await resurrect(root, { sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }), fixCache: await riskyCache(), approve: async () => 'pause' });
    expect(report.outcome).toBe('needs-you');
    return { root, report };
  }

  it('applies the approved fix and carries on with the next attempt', async () => {
    const { root, report: from } = await paused();
    const sandbox = new FakeSandbox({});
    const report = await resurrect(root, { sandbox, resume: resumeOf(from, { approve: true }) });
    expect(report.outcome).toBe('resurrected');
    expect(report.attempts.map((a) => [a.n, a.ok])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(report.attempts[0]!.fix).toMatchObject({ source: 'cache', id: CACHE_ID });
    expect(sandbox.manifests[0]!.dependencies).toMatchObject({ config: '^1.0.0' });
    expect(sandbox.calls[0]!.image).toMatch(/:attempt-2$/);
    expect(report.decisions).toMatchObject([{ attempt: 1, kind: 'approval', by: 'owner', subject: CACHE_ID, answer: 'approved', risks: [{ op: 'setDependency' }] }]);
    expect(report.pending).toBeNull();
    expect(report.resume).toBeNull();
  });

  it('reads decisions saved before `by` existed as the owner’s', async () => {
    const { root, report: paused1 } = await paused();
    const from = { ...paused1, decisions: [{ attempt: 1, kind: 'question', subject: 'Stub it?', answer: 'yes', at: '2026-01-01T00:00:00Z' }] } as ResurrectReport;
    const report = await resurrect(root, { sandbox: new FakeSandbox({}), resume: resumeOf(from, { approve: true }) });
    expect(report.decisions).toMatchObject([{ kind: 'question', by: 'owner' }, { kind: 'approval', by: 'owner' }]);
  });

  it('asks the model again when the owner declines on resume', async () => {
    const { root, report: from } = await paused();
    const model = new ScriptedModel(fix([{ op: 'setEnv', name: 'CI', value: 'true' }]));
    const report = await resurrect(root, { sandbox: new FakeSandbox({}), model, resume: resumeOf(from, { approve: false }, model, { model: 'scripted' }) });
    expect(report.outcome).toBe('resurrected');
    expect(model.requests[0]!.prompt).toContain('the owner declined it: add the config package');
    expect(report.attempts[0]!.fix).toMatchObject({ source: 'llm' });
    expect(report.decisions).toMatchObject([{ subject: CACHE_ID, answer: 'rejected' }]);
  });

  it('remembers model fixes the owner declined before the pause', async () => {
    const root = await deadApp(expressMongoApp);
    const a = fix([{ op: 'setDependency', name: 'config', version: '^1.0.0' }], 'add the config package');
    const b = fix([{ op: 'removeDependency', name: 'config' }], 'drop config');
    const verdicts: Array<'reject' | 'pause'> = ['reject', 'pause'];
    const from = await resurrect(root, {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model: new ScriptedModel(a, b),
      approve: async () => verdicts.shift()!,
    });
    expect(from.outcome).toBe('needs-you');
    expect(from.resume).toMatchObject({ declined: ['"add the config package"'], questions: 0, declines: 1, answer: null });
    const model = new ScriptedModel(a, fix([{ op: 'setEnv', name: 'CI', value: 'true' }]));
    const report = await resurrect(root, { sandbox: new FakeSandbox({}), model, approve: async () => 'reject', resume: resumeOf(from, { approve: false }, model) });
    expect(report.outcome).toBe('resurrected');
    expect(report.warnings).toContain('attempt 1: rejected a proposed fix (the owner already declined that fix)');
    expect(report.attempts[0]!.fix).toMatchObject({ ops: [{ op: 'setEnv', name: 'CI' }] });
  });

  it('warns when the repo moved on since the pause', async () => {
    const { root, report: paused1 } = await paused();
    const from = { ...paused1, repo: { ...paused1.repo, commit: 'a'.repeat(40) } };
    const report = await resurrect(root, { sandbox: new FakeSandbox({}), resume: resumeOf(from, { approve: true }) });
    expect(report.outcome).toBe('resurrected');
    expect(report.warnings).toContain(
      `the repo changed since the run paused (aaaaaaa → ${report.repo.commit!.slice(0, 7)}); the saved recipe was diagnosed against the old commit`,
    );
  });

  it('passes the answer to the model on resume', async () => {
    const root = await deadApp(expressMongoApp);
    const from = await resurrect(root, { sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }), model: new ScriptedModel(question()) });
    expect(from.outcome).toBe('needs-you');
    const model = new ScriptedModel(fix([{ op: 'setEnv', name: 'LANG', value: 'C.UTF-8' }]));
    const report = await resurrect(root, { sandbox: new FakeSandbox({}), model, resume: resumeOf(from, { answer: 'stub it' }, model) });
    expect(report.outcome).toBe('resurrected');
    expect(model.requests[0]!.prompt).toContain('The owner answered your question: stub it');
    expect(report.llm.calls).toBe(2);
    expect(report.attempts.map((a) => a.n)).toEqual([1, 2]);
  });

  it('counts attempts before the pause toward the limit', async () => {
    const { root, report: from } = await paused();
    const report = await resurrect(root, {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model: null,
      resume: resumeOf(from, { approve: true }, null, { maxIterations: 2 }),
    });
    expect(report.blockedReason).toMatch(/^still failing after 2 attempts/);
  });

  it('keeps the paused run’s attempt limit and token budget', async () => {
    const root = await deadApp(expressMongoApp);
    const failures = Array.from({ length: 12 }, () => ({ ok: false, log: UNKNOWN }));
    // Eleven safe fixes, then a risky one after attempt 12.
    const safe = Array.from({ length: 11 }, (_, i) => fix([{ op: 'setEnv', name: 'TZ', value: `try-${i}` }], `try ${i}`));
    const risky = fix([{ op: 'setDependency', name: 'config', version: '^1.0.0' }], 'add the config package');
    // Each error differs, so loop detection stays out of it.
    const sandbox = new FakeSandbox({ boot: failures.map((f, i) => ({ ...f, log: `${f.log}\nError: variant ${'x'.repeat(i + 1)}` })) });
    const from = await resurrect(root, {
      sandbox,
      model: new ScriptedModel(...safe, risky),
      maxIterations: 20,
      tokenBudget: 500_000,
      approve: async (r) => (r.risks.length ? 'pause' : 'approve'),
    });
    expect(from.outcome).toBe('needs-you');
    expect(from.resume).toMatchObject({ nextAttempt: 13, settings: { maxIterations: 20, tokenBudget: 500_000, model: 'scripted' } });
    const report = await resurrect(root, { sandbox: new FakeSandbox({}), model: null, resume: resumeOf(from, { approve: true }, null, { model: null }) });
    expect(report.outcome).toBe('resurrected');
    expect(report.attempts.at(-1)).toMatchObject({ n: 13, ok: true });
    expect(report.llm.budget).toBe(500_000);
  });

  it('always tries the fix a resume settles on, even past a lower limit', async () => {
    const { root, report: from } = await paused();
    const report = await resurrect(root, { sandbox: new FakeSandbox({}), maxIterations: 1, resume: resumeOf(from, { approve: true }, null, { maxIterations: 1 }) });
    expect(report.outcome).toBe('resurrected');
    expect(report.attempts.map((a) => a.n)).toEqual([1, 2]);
  });

  it('refuses a report that is not waiting, or a resume without the answer it needs', async () => {
    const root = await deadApp(expressMongoApp);
    const done = await resurrect(root, { sandbox: new FakeSandbox({}) });
    expect(() => prepareResume(done, { approve: true })).toThrow(/needs-you.*ended resurrected/);

    const { report: approval } = await paused();
    expect(() => prepareResume(approval)).toThrow(`approve or reject ${CACHE_ID}`);
    expect(() => prepareResume(approval, { answer: 'yes' })).toThrow(`the run is waiting on a fix approval, not a question; pass approve true or false for ${CACHE_ID}`);
    // resurrect checks the answer too, for a run checked without one.
    await expect(resurrect(root, { sandbox: new FakeSandbox({}), resume: { run: checkResumable(approval) } })).rejects.toThrow(`approve or reject ${CACHE_ID}`);
    const asking = await resurrect(root, { sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }), model: new ScriptedModel(question()) });
    expect(() => prepareResume(asking, { model: new ScriptedModel(), answer: ' ' })).toThrow(/needs an answer to the pending question: Is there a public replacement/);
    expect(() => prepareResume(asking, { model: new ScriptedModel(), approve: true })).toThrow(/^the run is waiting on an answer to a question, not a fix approval/);
    for (const options of [{ model: null, overrides: {} }, { model: new ScriptedModel(), overrides: { tokenBudget: 0 } }]) {
      expect(() => prepareResume(asking, { ...options, answer: 'stub it' })).toThrow(/answering the pending question needs a model/);
    }
  });
});

describe('a resumed run keeps the paused run’s settings', () => {
  const sandboxWith = (settings: SandboxSettings, script: ConstructorParameters<typeof FakeSandbox>[0] = {}) =>
    Object.assign(new FakeSandbox(script), { settings });

  async function pausedWith() {
    const root = await deadApp(expressMongoApp);
    const caFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-ca-')), 'proxy.crt');
    await writeFile(caFile, '-----BEGIN CERTIFICATE-----\n');
    const from = await resurrect(root, {
      sandbox: sandboxWith({ buildProxy: true, healthTimeoutSec: 30 }, { boot: [{ ok: false, log: UNKNOWN }] }),
      fixCache: await riskyCache(),
      limits: { cpus: 1, memoryMb: 512, stepTimeoutSec: 60 },
      caFile,
      approve: async () => 'pause',
    });
    expect(from.outcome).toBe('needs-you');
    return { root, from, caFile };
  }

  it('saves the CA file and sandbox setup, and resumes with the saved limits, CA, services and era', async () => {
    const { root, from, caFile } = await pausedWith();
    expect(from.resume).toMatchObject({ settings: { caFile, sandbox: { buildProxy: true, healthTimeoutSec: 30 } } });
    // What a later report or a changed graveyard would say must not change the resumed run.
    const saved = {
      ...from,
      services: [{ ...from.services[0]!, image: 'mongo:2.6' }],
      era: { ...from.era, date: '2016-01-01', why: 'saved era' },
    };
    const graveyard = { era: { estimate: '2023-06-01', died: null } } as unknown as GraveyardReport;
    const sandbox = sandboxWith({ buildProxy: true, healthTimeoutSec: 30 });
    const report = await resurrect(root, {
      sandbox,
      graveyard,
      limits: { cpus: 4, memoryMb: 8192, stepTimeoutSec: 900 },
      resume: resumeOf(saved, { approve: true }),
    });
    expect(report.outcome).toBe('resurrected');
    const limits = { ...DEFAULT_LIMITS, cpus: 1, memoryMb: 512, stepTimeoutSec: 60 };
    expect(sandbox.calls[0]!.limits).toEqual(limits);
    expect(sandbox.calls.find((c) => c.step === 'boot')!.boot!.limits).toEqual(limits);
    expect(report.limits).toEqual(limits);
    expect(sandbox.dockerfiles[0]).toContain('necromancer-ca.crt');
    expect(sandbox.calls.find((c) => c.step === 'boot')!.boot!.services.map((x) => x.image)).toEqual(['mongo:2.6']);
    expect(report.services.map((x) => x.image)).toEqual(['mongo:2.6']);
    expect(report.era).toMatchObject({ date: '2016-01-01', why: 'saved era' });
    expect(report.warnings).toEqual([]);
  });

  it('changes only the limits the resume names', async () => {
    const { root, from } = await pausedWith();
    const sandbox = sandboxWith({ buildProxy: true, healthTimeoutSec: 30 });
    const report = await resurrect(root, { sandbox, resume: resumeOf(from, { approve: true }, null, { limits: { memoryMb: 1024, cpus: undefined } }) });
    expect(sandbox.calls[0]!.limits).toEqual({ ...DEFAULT_LIMITS, cpus: 1, memoryMb: 1024, stepTimeoutSec: 60 });
    expect(report.limits.memoryMb).toBe(1024);
  });

  it('warns when the sandbox it is handed is set up differently', async () => {
    const { root, from } = await pausedWith();
    const report = await resurrect(root, { sandbox: sandboxWith({ buildProxy: false, healthTimeoutSec: 90 }), resume: resumeOf(from, { approve: true }) });
    expect(report.warnings).toContain(
      "the sandbox is set up differently from the paused run's (without the build proxy, 90s health timeout, was with the build proxy, 30s health timeout)",
    );
  });

  it('tells a front-end everything it needs before it asks the owner', async () => {
    const { from, caFile } = await pausedWith();
    const run = checkResumable(from, { resume: { maxIterations: 4, limits: { pids: 64 } } });
    expect(run.from).toBe(from);
    expect(run.pending).toMatchObject({ kind: 'approval', fix: { id: CACHE_ID } });
    expect(run.state.nextAttempt).toBe(2);
    expect(run.settings).toEqual({
      maxIterations: 4,
      tokenBudget: DEFAULT_TOKEN_BUDGET,
      limits: { cpus: 1, memoryMb: 512, pids: 64, stepTimeoutSec: 60 },
      model: null,
      caFile,
      sandbox: { buildProxy: true, healthTimeoutSec: 30 },
      keepImages: false,
      workdir: null,
    });
    // The same settings without any checks, for a front-end to pick its model and sandbox first.
    expect(resumeSettings(from, { maxIterations: 4, limits: { pids: 64 } })).toEqual(run.settings);
    const done = { ...from, outcome: 'blocked' as const };
    expect(() => checkResumable(done)).toThrow('only a run that is waiting on the owner (needs-you) can be resumed; this one ended blocked');
    expect(() => checkResumable({ ...from, resume: null })).toThrow(/missing the state it needs/);
    const root = await deadApp(expressMongoApp);
    const asking = await resurrect(root, { sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }), model: new ScriptedModel(question()) });
    for (const err of [() => checkResumable(asking), () => checkResumable(asking, { model: new ScriptedModel(), resume: { tokenBudget: 0 } })]) {
      expect(err).toThrow(/^answering the pending question needs a model/);
      expect(err).not.toThrow(/--/);
    }
    expect(checkResumable(asking, { model: new ScriptedModel() }).pending.kind).toBe('question');
  });
});

describe('a resumed run restores the model, image cleanup and workdir', () => {
  /** A FakeSandbox that records the directories the build context was put in. */
  class ContextSandbox extends FakeSandbox {
    readonly contexts: string[] = [];
    override async install(contextDir: string, tag: string, limits: Parameters<FakeSandbox['install']>[2]) {
      this.contexts.push(contextDir);
      return super.install(contextDir, tag, limits);
    }
  }

  async function pausedOn(options: { keepImages?: boolean; workdir?: string } = {}) {
    const root = await deadApp(expressMongoApp);
    const risky = fix([{ op: 'setDependency', name: 'config', version: '^1.0.0' }], 'add the config package');
    const from = await resurrect(root, {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model: new ScriptedModel(risky),
      approve: async () => 'pause',
      ...options,
    });
    expect(from.outcome).toBe('needs-you');
    return { root, from };
  }

  it('saves every setting with the paused run', async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'necro-work-'));
    const { from } = await pausedOn({ keepImages: true, workdir });
    expect(from.resume!.settings).toEqual({
      maxIterations: 10,
      tokenBudget: DEFAULT_TOKEN_BUDGET,
      model: 'scripted',
      caFile: null,
      sandbox: null,
      keepImages: true,
      workdir,
    });
    expect(resumeSettings(from)).toMatchObject({ model: 'scripted', keepImages: true, workdir });
  });

  it('keeps the images and uses the workdir the paused run had, whatever the options say', async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'necro-work-'));
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'necro-elsewhere-'));
    const { root, from } = await pausedOn({ keepImages: true, workdir });
    const sandbox = new ContextSandbox({});
    const model = new ScriptedModel();
    const report = await resurrect(root, {
      sandbox,
      model,
      keepImages: false,
      workdir: elsewhere,
      resume: resumeOf(from, { approve: true }, model),
    });
    expect(report.outcome).toBe('resurrected');
    expect(sandbox.cleaned).toBe(0);
    expect(path.dirname(sandbox.contexts[0]!)).toBe(workdir);
    expect(report.llm.model).toBe('scripted');
  });

  it('changes the image cleanup, workdir and model only when the resume says so', async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'necro-work-'));
    const { root, from } = await pausedOn({ keepImages: true, workdir });
    expect(resumeSettings(from, { model: null, keepImages: false, workdir: null })).toMatchObject({ model: null, keepImages: false, workdir: null });
    expect(resumeSettings(from, { tokenBudget: 0 }).model).toBeNull();
    // A CA file that moved is replaced, made absolute; null drops it.
    expect(resumeSettings(from, { caFile: 'new.pem' }).caFile).toBe(path.resolve('new.pem'));
    expect(resumeSettings(from, { caFile: null }).caFile).toBeNull();
    const sandbox = new ContextSandbox({});
    const report = await resurrect(root, { sandbox, resume: resumeOf(from, { approve: true }, null, { model: null, keepImages: false, workdir: null }) });
    expect(report.outcome).toBe('resurrected');
    expect(sandbox.cleaned).toBe(1);
    expect(path.dirname(sandbox.contexts[0]!)).toBe(os.tmpdir());
    expect(report.llm.model).toBeNull();
  });

  it('refuses a model other than the one the resumed run names', async () => {
    const { root, from } = await pausedOn();
    const other: StructuredModel = Object.assign(new ScriptedModel(), { name: 'other' });
    const check = (model: StructuredModel | null, overrides: ResumeOverrides = {}) => () => prepareResume(from, { model, overrides, approve: true });
    expect(check(other)).toThrow('the resumed run asks scripted for fixes, but was handed the model other');
    expect(check(null)).toThrow('the resumed run asks scripted for fixes, but was handed no model');
    expect(check(new ScriptedModel(), { model: null })).toThrow('the resumed run uses known and cached fixes only, but was handed the model scripted');
    expect(() => checkResumable(from, { model: other })).toThrow(/handed the model other/);
    expect(checkResumable(from, { model: other, resume: { model: 'other' } }).settings.model).toBe('other');
    // resurrect takes the checked run as it is, but must be handed the model it was checked with.
    const run = checkResumable(from, { model: new ScriptedModel() });
    await expect(resurrect(root, { sandbox: new FakeSandbox({}), model: other, resume: { run, approve: true } })).rejects.toThrow(
      'the resumed run asks scripted for fixes, but was handed the model other',
    );
    await expect(resurrect(root, { sandbox: new FakeSandbox({}), resume: { run, approve: true } })).rejects.toThrow(/but was handed no model/);
    const cached = await resurrect(root, { sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }), fixCache: await riskyCache(), approve: async () => 'pause' });
    expect(cached.resume!.settings.model).toBeNull();
    expect(() => prepareResume(cached, { model: new ScriptedModel(), approve: true })).toThrow(/uses known and cached fixes only/);
  });
});

describe('a declined fix stays declined for the whole run', () => {
  it('does not offer a declined cached fix again on a later failure', async () => {
    const shown: string[] = [];
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }, { ok: false, log: UNKNOWN }] }),
      fixCache: await riskyCache(),
      model: new ScriptedModel(fix([{ op: 'setEnv', name: 'TZ', value: 'try-a' }], 'try a'), fix([{ op: 'setEnv', name: 'TZ', value: 'try-b' }], 'try b')),
      approve: async (r) => (shown.push(r.fix.id), 'reject'),
    });
    expect(report.outcome).toBe('resurrected');
    expect(shown).toEqual([CACHE_ID]);
    expect(report.attempts.map((a) => a.fix?.id ?? null)).toEqual([expect.stringMatching(/^llm:/), expect.stringMatching(/^llm:/), null]);
  });

  it('matches declined fixes by what they would do now, never by id', async () => {
    const root = await deadApp(expressMongoApp);
    const paused1 = await resurrect(root, { sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }), fixCache: await riskyCache(), approve: async () => 'pause' });
    // Runs from before this rule also saved the ids of declined known and cached fixes.
    const from = { ...paused1, resume: { ...paused1.resume!, declinedFixes: ['node-gyp-python', CACHE_ID] } };
    // The cache has since learned another fix for the boot error, under the same id.
    const cache = new FixCache(null);
    await cache.remember(errorSignature('boot', UNKNOWN), { description: 'set the time zone', ops: [{ op: 'setEnv', name: 'TZ', value: 'UTC' }] });
    const report = await resurrect(root, {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: NODE_GYP_LOG }], boot: [{ ok: false, log: UNKNOWN }] }),
      fixCache: cache,
      resume: resumeOf(from, { approve: true }),
    });
    expect(report.outcome).toBe('resurrected');
    expect(report.attempts.map((a) => a.fix?.id ?? null)).toEqual([CACHE_ID, 'node-gyp-python', CACHE_ID, null]);
    expect(report.attempts[2]!.fix).toMatchObject({ ops: [{ op: 'setEnv', name: 'TZ', value: 'UTC' }] });
  });

  it('keeps fixes declined before a pause declined after it, even with nobody to ask', async () => {
    const root = await deadApp(expressMongoApp);
    const cache = await riskyCache();
    const from = await resurrect(root, { sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }), fixCache: cache, approve: async () => 'pause' });
    const model = new ScriptedModel(fix([{ op: 'setEnv', name: 'TZ', value: 'try-a' }], 'try a'), fix([{ op: 'setEnv', name: 'TZ', value: 'try-b' }], 'try b'));
    // The same failure comes back after the model's fix; with no approve callback the cached fix would just be applied.
    const sandbox = new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] });
    const report = await resurrect(root, { sandbox, fixCache: cache, model, resume: resumeOf(from, { approve: false }, model, { model: 'scripted' }) });
    expect(report.outcome).toBe('resurrected');
    expect(report.attempts.map((a) => a.fix?.source ?? null)).toEqual(['llm', 'llm', null]);
    for (const manifest of sandbox.manifests) expect(manifest.dependencies).not.toHaveProperty('config');
  });

  it('saves the declined fixes with a paused run and blocks on them without a model', async () => {
    const root = await deadApp(expressMongoApp);
    const verdicts: Array<'reject' | 'pause'> = ['reject', 'pause'];
    const from = await resurrect(root, {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }], install: [{ ok: true }, { ok: false, log: PRIVATE }] }),
      fixCache: await riskyCache(),
      model: new ScriptedModel(fix([{ op: 'setEnv', name: 'TZ', value: 'try-a' }], 'try a'), fix([{ op: 'setDependency', name: '@acme/core', version: 'file:./stub' }], 'stub')),
      approve: async () => verdicts.shift()!,
    });
    expect(from.outcome).toBe('needs-you');
    expect(from.resume!.declinedFixes).toEqual([opsKey(CONFIG_FIX.ops)]);
    // Approving the pending fix, the next failure is the boot one again: its cached fix stays declined.
    const report = await resurrect(root, {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      fixCache: await riskyCache(),
      model: null,
      resume: resumeOf(from, { approve: true }, null, { model: null }),
    });
    expect(report.outcome).toBe('blocked');
    expect(report.blockedReason).toBe(`the owner declined ${CACHE_ID} earlier in this run and there is no other fix for: Error: Cannot find module './config/local.json'`);
  });
});

describe('the shared fix cache after an answer', () => {
  it('keeps every later model fix out of it once the owner has answered', async () => {
    const cache = new FixCache(null);
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }], boot: [{ ok: false, log: UNKNOWN }] }),
      model: new ScriptedModel(question(), fix([{ op: 'setEnv', name: 'LANG', value: 'C.UTF-8' }]), fix([{ op: 'setEnv', name: 'CI', value: 'true' }])),
      ask: async () => 'stub it',
      fixCache: cache,
    });
    expect(report.outcome).toBe('resurrected');
    expect(report.attempts[1]!.fix).toMatchObject({ source: 'llm', ops: [{ name: 'CI' }] });
    for (const a of report.attempts.slice(0, 2)) expect(await cache.get(a.signature!)).toBeNull();
  });

  it('remembers an answer given before a pause', async () => {
    const root = await deadApp(expressMongoApp);
    const from = await resurrect(root, { sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }), model: new ScriptedModel(question()) });
    const cache = new FixCache(null);
    const model = new ScriptedModel(fix([{ op: 'setEnv', name: 'LANG', value: 'C.UTF-8' }]), fix([{ op: 'setEnv', name: 'CI', value: 'true' }]));
    const report = await resurrect(root, {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model,
      fixCache: cache,
      resume: resumeOf(from, { answer: 'stub it' }, model),
    });
    expect(report.outcome).toBe('resurrected');
    for (const a of report.attempts.slice(0, 2)) expect(await cache.get(a.signature!)).toBeNull();
  });

  it('still caches a model fix when nobody was asked anything', async () => {
    const cache = new FixCache(null);
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model: new ScriptedModel(fix([{ op: 'setEnv', name: 'CI', value: 'true' }])),
      fixCache: cache,
    });
    expect(report.outcome).toBe('resurrected');
    expect(await cache.get(report.attempts[0]!.signature!)).toMatchObject({ ops: [{ name: 'CI' }] });
  });
});

describe('resume settings the paused run saves for later', () => {
  const sandboxWith = (settings: SandboxSettings, script: ConstructorParameters<typeof FakeSandbox>[0] = {}) =>
    Object.assign(new FakeSandbox(script), { settings });
  const risky = () => fix([{ op: 'setDependency', name: 'dotenv', version: '^4.0.0' }], 'add dotenv');

  it('takes the sandbox setup a resume names, without warning, and saves it on a later pause', async () => {
    const root = await deadApp(expressMongoApp);
    const from = await resurrect(root, {
      sandbox: sandboxWith({ buildProxy: true, healthTimeoutSec: 30 }, { boot: [{ ok: false, log: UNKNOWN }] }),
      fixCache: await riskyCache(),
      approve: async () => 'pause',
    });
    expect(resumeSettings(from, { sandbox: { healthTimeoutSec: 120, buildProxy: undefined } }).sandbox).toEqual({ buildProxy: true, healthTimeoutSec: 120 });
    expect(resumeSettings(from, { sandbox: {} }).sandbox).toEqual({ buildProxy: true, healthTimeoutSec: 30 });
    const model = new ScriptedModel(risky());
    const report = await resurrect(root, {
      sandbox: sandboxWith({ buildProxy: true, healthTimeoutSec: 120 }, { boot: [{ ok: false, log: PRIVATE }] }),
      model,
      approve: async () => 'pause',
      resume: resumeOf(from, { approve: true }, model, { model: 'scripted', sandbox: { healthTimeoutSec: 120 } }),
    });
    expect(report.outcome).toBe('needs-you');
    expect(report.warnings).toEqual([]);
    expect(report.resume!.settings.sandbox).toEqual({ buildProxy: true, healthTimeoutSec: 120 });
    // A paused run whose sandbox did not say counts as the defaults.
    const unknown = await resurrect(root, { sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }), fixCache: await riskyCache(), approve: async () => 'pause' });
    expect(resumeSettings(unknown, { sandbox: { buildProxy: true } }).sandbox).toEqual({ buildProxy: true, healthTimeoutSec: DEFAULT_HEALTH_TIMEOUT_SEC });
  });

  it('tells the model what the paused run’s interview said, not what the resuming call’s says', async () => {
    const root = await deadApp(expressMongoApp);
    const interview = (intent: string, goal: string) => ({ intent, goals: [{ text: goal, origin: 'user' }] }) as never;
    const from = await resurrect(root, {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }),
      model: new ScriptedModel(question()),
      interview: interview('A notes API', 'Keep the REST API identical'),
    });
    expect(from.resume!.interview).toEqual({ intent: 'A notes API', goals: ['Keep the REST API identical'] });
    const model = new ScriptedModel(fix([{ op: 'setEnv', name: 'CI', value: 'true' }]));
    const report = await resurrect(root, {
      sandbox: new FakeSandbox({}),
      model,
      interview: interview('A chat bot', 'Rewrite it in Rust'),
      resume: resumeOf(from, { answer: 'stub it' }, model),
    });
    expect(report.outcome).toBe('resurrected');
    expect(model.requests[0]!.prompt).toContain("What the project is for: A notes API\nOwner's goals: Keep the REST API identical");
    expect(model.requests[0]!.prompt).not.toContain('Rust');

    const none = await resurrect(root, { sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }), model: new ScriptedModel(question()) });
    expect(none.resume!.interview).toBeNull();
    const later = new ScriptedModel(fix([{ op: 'setEnv', name: 'CI', value: 'true' }]));
    await resurrect(root, { sandbox: new FakeSandbox({}), model: later, interview: interview('A chat bot', 'Rewrite it in Rust'), resume: resumeOf(none, { answer: 'stub it' }, later) });
    expect(later.requests[0]!.prompt).not.toContain('What the project is for');
  });
});

describe('resume errors', () => {
  const code = (run: () => unknown): string | null => {
    try {
      run();
      return null;
    } catch (err) {
      return err instanceof ResumeError ? err.code : `not a ResumeError: ${String(err)}`;
    }
  };
  const asyncCode = (run: Promise<unknown>) => run.then(
    () => null,
    (err: unknown) => (err instanceof ResumeError ? err.code : `not a ResumeError: ${String(err)}`),
  );

  it('say which check refused the resume', async () => {
    const root = await deadApp(expressMongoApp);
    const approval = await resurrect(root, {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model: new ScriptedModel(fix([{ op: 'setDependency', name: 'config', version: '^1.0.0' }])),
      approve: async () => 'pause',
    });
    const asking = await resurrect(root, { sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }), model: new ScriptedModel(question()) });
    const other: StructuredModel = Object.assign(new ScriptedModel(), { name: 'other' });

    expect(code(() => checkResumable({ ...approval, outcome: 'blocked' }))).toBe('not-paused');
    expect(code(() => checkResumable({ ...approval, resume: null }))).toBe('no-state');
    expect(code(() => checkResumable(asking, { model: new ScriptedModel(), resume: { tokenBudget: 0 } }))).toBe('budget-spent');
    expect(code(() => checkResumable(asking, { resume: { model: null } }))).toBe('no-model');
    expect(code(() => checkResumable(asking))).toBe('model-null');
    expect(code(() => checkResumable(approval))).toBe('model-null');
    expect(code(() => checkResumable(approval, { model: other }))).toBe('model-mismatch');
    expect(code(() => checkResumable(approval, { model: new ScriptedModel(), resume: { model: null } }))).toBe('model-mismatch');
    expect(code(() => checkResumable(approval, { model: new ScriptedModel() }))).toBeNull();

    expect(code(() => prepareResume(approval, { model: new ScriptedModel() }))).toBe('needs-approve');
    expect(code(() => prepareResume(approval, { model: new ScriptedModel(), answer: 'yes' }))).toBe('wrong-kind');
    expect(code(() => prepareResume(asking, { model: new ScriptedModel(), approve: true }))).toBe('wrong-kind');
    expect(code(() => prepareResume(asking, { model: new ScriptedModel(), answer: ' ' }))).toBe('needs-answer');

    // resurrect checks only the answer and the model against a run checked before.
    const run = checkResumable(approval, { model: new ScriptedModel() });
    const resume = (r: { approve?: boolean; answer?: string }, model: StructuredModel | null = new ScriptedModel()) =>
      asyncCode(resurrect(root, { sandbox: new FakeSandbox({}), model, resume: { run, ...r } }));
    expect(await resume({})).toBe('needs-approve');
    expect(await resume({ answer: 'yes' })).toBe('wrong-kind');
    expect(await resume({ approve: true }, other)).toBe('model-mismatch');
    expect(await resume({ approve: true }, null)).toBe('model-null');
    // resurrect checks the run it is handed, whatever was checked before.
    const questionRun = checkResumable(asking, { model: new ScriptedModel() });
    const spent = { ...questionRun, settings: { ...questionRun.settings, tokenBudget: questionRun.state.tokens } };
    expect(await asyncCode(resurrect(root, { sandbox: new FakeSandbox({}), model: new ScriptedModel(), resume: { run: spent, answer: 'stub it' } }))).toBe(
      'budget-spent',
    );
  });

  it('build the model from the settings, called only when they name one', async () => {
    const root = await deadApp(expressMongoApp);
    const approval = await resurrect(root, {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model: new ScriptedModel(fix([{ op: 'setDependency', name: 'config', version: '^1.0.0' }])),
      approve: async () => 'pause',
    });
    const named: string[] = [];
    const build = (name: string) => (named.push(name), new ScriptedModel());
    const run = checkResumable(approval, { model: build });
    expect(named).toEqual(['scripted']);
    expect(run.model).toBeInstanceOf(ScriptedModel);
    // Settings that name no model build none.
    expect(checkResumable(approval, { model: build, resume: { model: null } }).model).toBeNull();
    expect(named).toEqual(['scripted']);
    const input = prepareResume(approval, { model: build, approve: true });
    expect((await resurrect(root, { sandbox: new FakeSandbox({}), model: input.run.model, resume: input })).outcome).toBe('resurrected');
  });

  it('refuse a resume that names a model with a token budget of 0', async () => {
    const root = await deadApp(expressMongoApp);
    const from = await resurrect(root, {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model: new ScriptedModel(fix([{ op: 'setDependency', name: 'config', version: '^1.0.0' }])),
      approve: async () => 'pause',
    });
    expect(code(() => checkResumable(from, { model: new ScriptedModel(), resume: { model: 'scripted', tokenBudget: 0 } }))).toBe('model-without-budget');
    // Without naming one, a budget of 0 still just means no model.
    expect(checkResumable(from, { resume: { tokenBudget: 0 } }).settings.model).toBeNull();
    const zero = await resurrect(root, {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      fixCache: await riskyCache(),
      tokenBudget: 0,
      approve: async () => 'pause',
    });
    expect(zero.outcome).toBe('needs-you');
    expect(code(() => checkResumable(zero, { model: new ScriptedModel(), resume: { model: 'scripted' } }))).toBe('model-without-budget');
    expect(code(() => prepareResume(zero, { model: new ScriptedModel(), approve: true, overrides: { model: 'scripted' } }))).toBe('model-without-budget');
  });
});
