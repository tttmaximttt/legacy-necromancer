import { describe, expect, it } from 'vitest';
import type { ExhumeReport, GraveyardReport, InterviewReport, ResurrectReport, Tombstone, WitnessReport } from '@necromancer/core';
import { buildPlan, renderPlanMarkdown, TARGET_NODE, type PlanInputs } from '@necromancer/plan';

const SOURCE = 'https://github.com/dresende/node-orm2';
const NOW = new Date('2026-11-02T00:00:00Z');

function tomb(name: string, over: Partial<Tombstone> = {}): Tombstone {
  return {
    name,
    declared: '^1.0.0',
    dev: false,
    resolved: '1.0.0',
    resolvedFrom: 'lockfile',
    latest: '1.0.0',
    majorsBehind: 0,
    lastPublished: null,
    repository: null,
    status: 'alive',
    causes: [],
    advisories: [],
    replacement: null,
    epitaph: '',
    ...over,
  };
}

const advisory = (id: string) => ({ id, title: 'Prototype pollution', severity: 'high' as const, url: null, vulnerableVersions: '<4.17.21' });

// Shapes taken from the node-orm2 sample reports, trimmed to the cases the planner distinguishes.
const tombstones: Tombstone[] = [
  tomb('path-is-absolute', {
    status: 'dead',
    resolved: '1.0.1',
    latest: '2.0.0',
    majorsBehind: 1,
    causes: [{ kind: 'deprecated', detail: 'Deprecated: use path.isAbsolute' }],
    replacement: { name: 'path.isAbsolute', reason: 'built in since Node 0.12', source: 'known' },
  }),
  tomb('mysql', {
    status: 'dying',
    resolved: '2.13.0',
    latest: '2.18.1',
    causes: [{ kind: 'abandoned', detail: 'No release since 2020' }],
    advisories: [advisory('GHSA-mysql')],
    replacement: { name: 'mysql2', reason: 'mysql has had no release since 2020; mysql2 is API-compatible', source: 'known' },
  }),
  tomb('colors', {
    status: 'dying',
    resolved: '0.6.2',
    latest: '1.4.0',
    majorsBehind: 1,
    causes: [{ kind: 'abandoned', detail: 'No release since 2022' }],
    replacement: { name: 'picocolors', reason: 'colors was sabotaged by its author in 2022', source: 'known' },
  }),
  tomb('hat', { status: 'dying', resolved: '0.0.3', latest: '0.0.3', causes: [{ kind: 'abandoned', detail: 'No release since 2013' }] }),
  tomb('left-pad', { status: 'dead', causes: [{ kind: 'deprecated', detail: 'Deprecated' }] }),
  tomb('jshint', { status: 'dead', causes: [{ kind: 'deprecated', detail: 'Deprecated' }] }),
  tomb('ghost', { status: 'dead', causes: [{ kind: 'deprecated', detail: 'Deprecated' }] }),
  tomb('lodash', { status: 'ailing', resolved: '4.17.4', latest: '4.18.1', causes: [{ kind: 'vulnerable', detail: '10 advisories' }], advisories: [advisory('GHSA-lodash')] }),
  tomb('express', { status: 'ailing', resolved: '3.3.8', latest: '5.3.0', majorsBehind: 2, causes: [{ kind: 'outdated', detail: '2 majors behind' }] }),
  tomb('async', { status: 'ailing', resolved: '2.5.0', latest: '3.2.6', majorsBehind: 1, causes: [{ kind: 'outdated', detail: '1 major behind' }] }),
  tomb('mocha', { status: 'ailing', dev: true, resolved: '3.4.2', latest: '12.0.3', majorsBehind: 9, causes: [{ kind: 'outdated', detail: '9 majors behind' }] }),
  tomb('enforce', { status: 'alive' }),
  tomb('mystery', { status: 'unknown' }),
];

const graveyard: GraveyardReport = {
  repo: { source: SOURCE, commit: 'abc' },
  era: { born: null, died: null, dependencyFloor: null, node: null, estimate: '2017-09', confidence: 'high', summary: '' },
  summary: { total: tombstones.length, dead: 2, dying: 3, ailing: 4, alive: 1, unknown: 1, vulnerable: 2 },
  tombstones,
  sources: { registry: 'ok', advisories: 'ok', advisoryProvider: 'osv', github: 'ok' },
  nonRegistry: [{ name: 'forked-thing', spec: 'git+https://example.com/forked-thing.git' }],
  warnings: [],
};

const exhume = {
  repo: { source: SOURCE, commit: 'abcdef1234567890', packageManager: 'npm' },
  stats: { testFiles: 70 },
  externalPackages: [
    { name: 'lodash', importedBy: 32, importers: ['lib/b.js', 'lib/a.js'] },
    { name: 'express', importedBy: 2 },
    { name: 'async', importedBy: 19 },
    { name: 'colors', importedBy: 1 },
    { name: 'mysql', importedBy: 3 },
    { name: 'path-is-absolute', importedBy: 1 },
    { name: 'hat', importedBy: 1 },
    { name: 'mocha', importedBy: 1 },
  ],
  caseMismatches: [{ from: 'lib/ErrorCodes.js', specifier: './error', line: 2, target: 'lib/Error.js' }],
  manifests: [
    {
      manifest: 'package.json',
      name: 'orm',
      engines: {},
      dependencies: { 'left-pad': '^1.0.0', jshint: '^1.0.0', lodash: '^4.17.4' },
      devDependencies: {},
      scripts: { lint: 'jshint lib', test: 'mocha test/left-padding.js' },
    },
  ],
} as unknown as ExhumeReport;

const resurrect = {
  outcome: 'resurrected',
  era: { date: '2017-09', node: '8', why: '' },
  recipe: { nodeImage: 'node:8-stretch', dependencyPatches: { express: { version: '3.21.2', dev: false } } },
  attempts: [],
} as unknown as ResurrectReport;

const witness = { snapshots: [{}], tests: null } as unknown as WitnessReport;

const interview = {
  intent: 'An ORM for Node.js over MySQL, Postgres and SQLite.',
  goals: [
    { text: 'Clear the security advisories', origin: 'user' },
    { text: 'Run on a current Node LTS', origin: 'suggested' },
    { text: 'Keep express routes working', origin: 'user' },
  ],
} as unknown as InterviewReport;

const all: PlanInputs = { exhume, graveyard, interview, resurrect, witness };
const ids = (plan: ReturnType<typeof buildPlan>) => plan.steps.map((s) => s.id);
const step = (plan: ReturnType<typeof buildPlan>, id: string) => plan.steps.find((s) => s.id === id)!;

describe('buildPlan', () => {
  it('needs a graveyard report', () => {
    expect(() => buildPlan({ ...all, graveyard: null })).toThrow(/necromancer graveyard <source>/);
  });

  it('orders low-risk steps first and the Node upgrade last', () => {
    const plan = buildPlan(all, { now: NOW });
    expect(ids(plan)).toEqual([
      'code-fix:import-case',
      'remove:left-pad',
      'upgrade:lodash',
      'replace:colors',
      'replace:path-is-absolute',
      'replace:mysql',
      'upgrade:async',
      'upgrade:express',
      'upgrade:mocha',
      `upgrade-node:${TARGET_NODE}`,
    ]);
    expect(plan.steps.map((s) => s.n)).toEqual(plan.steps.map((_, i) => i + 1));
    expect(step(plan, 'code-fix:import-case').after).toEqual([]);
    expect(step(plan, 'upgrade:lodash').after).toEqual(['code-fix:import-case']);
    expect(step(plan, `upgrade-node:${TARGET_NODE}`).after).toEqual(ids(plan).slice(0, -1));
    expect(plan.generatedAt).toBe(NOW.toISOString());
    expect(buildPlan(all, { now: NOW })).toEqual(plan);
  });

  it('picks kinds and risk from the tombstones', () => {
    const plan = buildPlan(all, { now: NOW });
    expect(step(plan, 'replace:mysql')).toMatchObject({ kind: 'replace-dependency', risk: 'medium' });
    expect(step(plan, 'replace:mysql').change).toEqual([
      { name: 'mysql', from: '2.13.0', to: null },
      { name: 'mysql2', from: null, to: 'latest' },
    ]);
    expect(step(plan, 'replace:colors').risk).toBe('high');
    expect(step(plan, 'replace:path-is-absolute').change).toEqual([{ name: 'path-is-absolute', from: '1.0.1', to: null }]);
    expect(step(plan, 'remove:left-pad')).toMatchObject({ kind: 'remove-dependency', risk: 'medium' });
    expect(step(plan, 'remove:left-pad').why).toContain(
      'Nothing imports it, but it may still be used from config files or the command line; search for its name before removing it.',
    );
    expect(step(plan, 'upgrade:lodash').touches).toEqual(['lib/a.js', 'lib/b.js']);
    expect(step(plan, 'upgrade:lodash')).toMatchObject({ kind: 'upgrade-dependency', risk: 'low', change: [{ name: 'lodash', from: '4.17.4', to: '4.18.1' }] });
    expect(step(plan, 'upgrade:async').risk).toBe('medium');
    expect(step(plan, 'upgrade:express').risk).toBe('high');
    expect(step(plan, 'code-fix:import-case')).toMatchObject({ kind: 'code-fix', risk: 'low', touches: ['lib/ErrorCodes.js'] });
  });

  it('uses Resurrect evidence and states the Node jump', () => {
    const plan = buildPlan(all, { now: NOW });
    expect(step(plan, 'upgrade:express').why).toContain('Resurrect had to pin it to 3.21.2 to boot the app.');
    const node = step(plan, `upgrade-node:${TARGET_NODE}`);
    expect(node.change).toEqual([{ name: 'node', from: '8', to: TARGET_NODE }]);
    expect(node.why.join(' ')).toContain(`jump of ${Number(TARGET_NODE) - 8} majors`);
    expect(node.risk).toBe('high');
    // buildPlan always names a target, and its type says so.
    const target: string = plan.target.node;
    expect(target).toBe(TARGET_NODE);
  });

  it('keeps packages that a script names, and does not remove packages exhume never saw', () => {
    const plan = buildPlan(all, { now: NOW });
    expect(ids(plan)).not.toContain('remove:jshint');
    expect(plan.leftAlone.find((l) => l.name === 'jshint')!.reason).toMatch(/^Used by the lint script\. /);
    expect(ids(plan)).not.toContain('remove:ghost');
    expect(plan.leftAlone.map((l) => l.name)).toContain('ghost');
  });

  it('removes an unused dead package even when it has a replacement, and names the replacement', () => {
    const request = tomb('request', {
      status: 'dead',
      causes: [{ kind: 'deprecated', detail: 'Deprecated' }],
      replacement: { name: 'undici', reason: 'request was deprecated in 2020', source: 'known' },
    });
    const manifest = { ...exhume.manifests[0]!, dependencies: { ...exhume.manifests[0]!.dependencies, request: '^2.88.0' } };
    const plan = buildPlan(
      { ...all, graveyard: { ...graveyard, tombstones: [...tombstones, request] }, exhume: { ...exhume, manifests: [manifest] } },
      { now: NOW },
    );
    expect(ids(plan)).not.toContain('replace:request');
    expect(step(plan, 'remove:request')).toMatchObject({ kind: 'remove-dependency', change: [{ name: 'request', from: '1.0.0', to: null }] });
    expect(step(plan, 'remove:request').why).toContain('If something still needs it, undici replaces it (request was deprecated in 2020).');
  });

  it('says which Node Resurrect tried when it did not boot the app', () => {
    const paused = { ...resurrect, outcome: 'needs-you', recipe: { ...resurrect.recipe, nodeImage: 'registry/v2/node:8' } } as ResurrectReport;
    const node = step(buildPlan({ ...all, resurrect: paused }, { now: NOW }), `upgrade-node:${TARGET_NODE}`);
    expect(node.change).toEqual([{ name: 'node', from: '8', to: TARGET_NODE }]);
    expect(node.why.join(' ')).toContain('Resurrect tried Node 8 (registry/v2/node:8) but has not booted the app yet');
    expect(node.why.join(' ')).not.toContain('booted the app on');
  });

  it('treats a Node 0.x release line as older than 4.x, not as major 0', () => {
    for (const [nodeImage, line] of [['node:0.10', '0.10'], ['node:0.12.18-slim', '0.12']] as const) {
      const old = { ...resurrect, recipe: { ...resurrect.recipe, nodeImage } } as ResurrectReport;
      const node = step(buildPlan({ ...all, resurrect: old }, { now: NOW }), `upgrade-node:${TARGET_NODE}`);
      expect(node.change).toEqual([{ name: 'node', from: line, to: TARGET_NODE }]);
      expect(node.why.join(' ')).toContain(`from Node ${line}, before the 4.x line`);
      expect(node.why.join(' ')).not.toMatch(/jump of/);
      expect(node.risk).toBe('high');
    }
    const era = { ...graveyard, era: { ...graveyard.era, node: { range: '>=0.10', release: '0.10', released: '2013-03' } } };
    const fromEra = step(buildPlan({ ...all, graveyard: era, resurrect: null }, { now: NOW }), `upgrade-node:${TARGET_NODE}`);
    expect(fromEra.change).toEqual([{ name: 'node', from: '0.10', to: TARGET_NODE }]);
    expect(fromEra.why.join(' ')).toContain('The project targets Node 0.10; this starts from Node 0.10, before the 4.x line.');
  });

  it('falls back to the era release when the image tag names no Node line', () => {
    const era = { ...graveyard, era: { ...graveyard.era, node: { range: '>=6', release: '6', released: '2016-04' } } };
    for (const nodeImage of ['node:lts', 'node:0']) {
      const tagged = { ...resurrect, recipe: { ...resurrect.recipe, nodeImage } } as ResurrectReport;
      const node = step(buildPlan({ ...all, graveyard: era, resurrect: tagged }, { now: NOW }), `upgrade-node:${TARGET_NODE}`);
      expect(node.change).toEqual([{ name: 'node', from: '6', to: TARGET_NODE }]);
    }
  });

  it('never plans an upgrade to the version it is already on', () => {
    const cases = [
      tomb('exact', { status: 'ailing', declared: '1.2.3', resolved: null, latest: '1.2.3', causes: [{ kind: 'outdated', detail: 'x' }] }),
      tomb('caret', { status: 'ailing', declared: '^1.2.3', resolved: null, latest: '1.2.3', causes: [{ kind: 'outdated', detail: 'x' }] }),
      tomb('vee', { status: 'ailing', declared: '=v1.2.3', resolved: null, latest: '1.2.3', advisories: [advisory('GHSA-vee')] }),
      tomb('range', { status: 'ailing', declared: '>=1.0.0', resolved: null, latest: '1.2.3', causes: [{ kind: 'outdated', detail: 'x' }] }),
    ];
    const plan = buildPlan({ exhume: null, graveyard: { ...graveyard, tombstones: cases, nonRegistry: [] }, interview: null, resurrect: null, witness: null }, { now: NOW });
    expect(ids(plan)).toEqual(['upgrade:range', `upgrade-node:${TARGET_NODE}`]);
    expect(plan.steps.flatMap((s) => s.change).every((c) => c.from !== c.to)).toBe(true);
    expect(plan.leftAlone.find((l) => l.name === 'exact')!.reason).toBe('Already on the newest release.');
    expect(plan.leftAlone.find((l) => l.name === 'vee')!.reason).toMatch(/no newer release/);
    expect(plan.leftAlone.map((l) => l.name)).toEqual(expect.arrayContaining(['exact', 'caret', 'vee']));
  });

  it('quotes the source in commands', () => {
    for (const source of ['~/my repo', '~/code/app']) {
      const plan = buildPlan({ exhume: null, graveyard, interview: null, resurrect: null, witness: null }, { now: NOW, source });
      expect(plan.baseline.command).toBe(`necromancer resurrect '${source}'`);
    }
  });

  it('lists skipped packages with a reason, but not healthy ones', () => {
    const plan = buildPlan(all, { now: NOW });
    const names = plan.leftAlone.map((l) => l.name);
    expect(names).toEqual(expect.arrayContaining(['hat', 'mystery', 'forked-thing']));
    expect(names).not.toContain('enforce');
    expect(ids(plan)).not.toContain('upgrade:enforce');
  });

  it('checks each step with witness when there are golden snapshots', () => {
    const plan = buildPlan(all, { now: NOW });
    expect(plan.baseline).toEqual({
      kind: 'witness',
      command: `necromancer witness ${SOURCE} --check`,
      passes: 'Every recorded route answers the same as the golden snapshots.',
    });
    expect(plan.steps.every((s) => s.check.kind === 'witness')).toBe(true);
    expect(plan.warnings.join(' ')).not.toMatch(/witness/);
  });

  it('falls back to tests, then to resurrect, and warns without a witness report', () => {
    const tests = buildPlan({ ...all, witness: null }, { now: NOW });
    expect(tests.baseline).toMatchObject({ kind: 'tests', command: 'npm test' });
    expect(tests.warnings).toContain(`No witness report: run \`necromancer witness ${SOURCE}\` first so each step can be checked against recorded behaviour.`);

    const bare = buildPlan({ exhume: null, graveyard, interview: null, resurrect: null, witness: null }, { now: NOW, source: 'my/repo' });
    expect(bare.baseline).toMatchObject({ kind: 'resurrect', command: 'necromancer resurrect my/repo' });
    expect(bare.basedOn).toEqual({ exhume: false, graveyard: true, interview: false, resurrect: false, witness: false });
    // Without exhume nothing is known to be unused, so the dead package is left alone instead of removed.
    expect(ids(bare)).not.toContain('remove:left-pad');
    expect(bare.leftAlone.map((l) => l.name)).toContain('left-pad');
  });

  it('lists an alive package a major behind as left alone, and says so in the Node step', () => {
    const plan = buildPlan({ ...all, graveyard: { ...graveyard, tombstones: [...tombstones, tomb('debug', { resolved: '3.2.7', latest: '4.4.0', majorsBehind: 1 })] } }, { now: NOW });
    expect(ids(plan)).not.toContain('upgrade:debug');
    expect(plan.leftAlone.find((l) => l.name === 'debug')!.reason).toBe('1 major behind; maintained, upgrade when convenient.');
    const why = step(plan, `upgrade-node:${TARGET_NODE}`).why;
    expect(why.join(' ')).not.toMatch(/every package/);
    expect(why).toContain(`debug stays a major behind (see Left alone); check it supports Node ${TARGET_NODE} before this step.`);
    expect(step(buildPlan(all, { now: NOW }), `upgrade-node:${TARGET_NODE}`).why.join(' ')).not.toMatch(/major behind/);
  });

  it('checks with the test script only when there is a real one, run by the project\'s package manager', () => {
    const withTest = (test: string | undefined, packageManager = 'npm') =>
      ({
        ...exhume,
        repo: { ...exhume.repo, packageManager },
        manifests: [{ ...exhume.manifests[0]!, scripts: test === undefined ? { lint: 'jshint lib' } : { test } }],
      }) as ExhumeReport;
    const check = (ex: ExhumeReport, res: ResurrectReport | null = null) => buildPlan({ ...all, exhume: ex, resurrect: res, witness: null }, { now: NOW, source: 'my/repo' }).baseline;

    // exhume saw test files, but there is no test script to run them.
    expect(check(withTest(undefined))).toMatchObject({ kind: 'resurrect', command: 'necromancer resurrect my/repo' });
    expect(check(withTest('echo "Error: no test specified" && exit 1'))).toMatchObject({ kind: 'resurrect' });
    // No witness test run, so nothing says the tests passed before.
    expect(check(withTest('mocha', 'pnpm'))).toEqual({ kind: 'tests', command: 'pnpm test', passes: 'The test script passes.' });
    const yarnRecipe = { ...resurrect, recipe: { ...resurrect.recipe, packageManager: 'yarn' } } as ResurrectReport;
    expect(check(withTest('mocha', 'npm'), yarnRecipe)).toMatchObject({ kind: 'tests', command: 'yarn test' });
    expect(check(withTest('mocha', 'bower'))).toMatchObject({ kind: 'tests', command: 'npm test' });
  });

  it('does not remove an unimported runtime dependency while a script runs a command no dependency is named after', () => {
    const coffee = tomb('coffee-script', { status: 'dead', causes: [{ kind: 'deprecated', detail: 'Deprecated' }] });
    const manifest = {
      ...exhume.manifests[0]!,
      dependencies: { ...exhume.manifests[0]!.dependencies, 'coffee-script': '^1.12.0' },
      scripts: { ...exhume.manifests[0]!.scripts, start: 'NODE_ENV=production coffee server.coffee' },
    };
    const plan = buildPlan({ ...all, graveyard: { ...graveyard, tombstones: [...tombstones, coffee] }, exhume: { ...exhume, manifests: [manifest] } }, { now: NOW });
    expect(ids(plan)).not.toContain('remove:coffee-script');
    expect(ids(plan)).not.toContain('remove:left-pad');
    expect(plan.leftAlone.find((l) => l.name === 'coffee-script')!.reason).toBe(
      'Nothing imports it, but a script runs `coffee`, which may come from it; check before removing it.',
    );

    // Builtins, Node's tools, the repo's own files and commands named after a dependency explain themselves.
    const plain = { ...manifest, scripts: { start: 'cd lib && NODE_ENV=x node server.js', build: './build.sh; rm -rf dist', lint: 'npx jshint lib' } };
    const removed = buildPlan({ ...all, graveyard: { ...graveyard, tombstones: [...tombstones, coffee] }, exhume: { ...exhume, manifests: [plain] } }, { now: NOW });
    expect(ids(removed)).toEqual(expect.arrayContaining(['remove:coffee-script', 'remove:left-pad']));
  });

  it('does not use tests that already failed when witnessed as the check', () => {
    const tests = { command: 'npm test', ok: false, summary: '40 passing, 2 failing', durationMs: 1, logTail: '' };
    const warning = 'The project\'s tests already failed when witnessed ("40 passing, 2 failing"), so they can\'t be used to check steps until they\'re fixed.';

    const noSnapshots = buildPlan({ ...all, witness: { snapshots: [], tests } as unknown as WitnessReport }, { now: NOW, source: 'my/repo' });
    expect(noSnapshots.baseline).toMatchObject({ kind: 'resurrect', command: 'necromancer resurrect my/repo' });
    expect(noSnapshots.warnings).toContain(warning);

    const withSnapshots = buildPlan({ ...all, witness: { snapshots: [{}], tests } as unknown as WitnessReport }, { now: NOW });
    expect(withSnapshots.baseline.kind).toBe('witness');
    expect(withSnapshots.warnings).toContain(warning);

    const passed = buildPlan({ ...all, witness: { snapshots: [], tests: { ...tests, ok: true } } as unknown as WitnessReport }, { now: NOW });
    expect(passed.baseline).toEqual({ kind: 'tests', command: 'npm test', passes: "The project's own tests pass, as they did when witnessed." });
    expect(passed.warnings.join(' ')).not.toMatch(/already failed/);

    const noSummary = buildPlan({ ...all, witness: { snapshots: [], tests: { ...tests, summary: null } } as unknown as WitnessReport }, { now: NOW });
    expect(noSummary.warnings).toContain('The project\'s tests already failed when witnessed (`npm test` failed), so they can\'t be used to check steps until they\'re fixed.');
  });

  it('splits scripts like a shell, so keywords and builtins do not block removals', () => {
    const coffee = tomb('coffee-script', { status: 'dead', causes: [{ kind: 'deprecated', detail: 'Deprecated' }] });
    const planWith = (scripts: Record<string, string>) => {
      const manifest = { ...exhume.manifests[0]!, dependencies: { ...exhume.manifests[0]!.dependencies, 'coffee-script': '^1.12.0' }, scripts };
      return buildPlan({ ...all, graveyard: { ...graveyard, tombstones: [...tombstones, coffee] }, exhume: { ...exhume, manifests: [manifest] } }, { now: NOW });
    };
    const removed = planWith({
      postinstall: 'if [ -d x ]; then cp -r x y; fi',
      build: 'for f in a b; do echo "$f; coffee"; done',
      check: '[[ -f a ]] || { echo missing >&2; exit 1; }',
      start: 'NODE_ENV=production DEBUG=x node server.js 2>&1 | cat &\nwait',
      sub: '(cd lib && node build.js) && test -n "$CI" && : ok',
    });
    expect(ids(removed)).toEqual(expect.arrayContaining(['remove:coffee-script', 'remove:left-pad']));

    for (const [script, cmd] of [
      ['(cd lib && coffee -c .)', 'coffee'],
      ['if [ -d x ]; then grunt build; fi', 'grunt'],
      ['node a.js & gulp watch', 'gulp'],
      ['FOO=1 BAR=2 bower install', 'bower'],
      ['NODE_ENV="production" brunch build', 'brunch'],
      ["MSG='a; b' karma start", 'karma'],
    ]) {
      const kept = planWith({ build: script! });
      expect(ids(kept)).not.toContain('remove:coffee-script');
      expect(kept.leftAlone.find((l) => l.name === 'coffee-script')!.reason).toContain(`a script runs \`${cmd}\``);
    }
  });

  it('counts a script that loads a subpath of a dependency as using it, but not a package sharing its prefix', () => {
    const coffee = tomb('coffee-script', { status: 'dead', causes: [{ kind: 'deprecated', detail: 'Deprecated' }] });
    const planWith = (script: string) => {
      const manifest = { ...exhume.manifests[0]!, dependencies: { ...exhume.manifests[0]!.dependencies, 'coffee-script': '^1.12.0' }, scripts: { start: script } };
      return buildPlan({ ...all, graveyard: { ...graveyard, tombstones: [...tombstones, coffee] }, exhume: { ...exhume, manifests: [manifest] } }, { now: NOW });
    };
    for (const script of ['node -r coffee-script/register server.js', 'node -e "require(\'coffee-script/register\')"']) {
      const kept = planWith(script);
      expect(ids(kept)).not.toContain('remove:coffee-script');
      expect(kept.leftAlone.find((l) => l.name === 'coffee-script')!.reason).toMatch(/^Used by the start script\. /);
    }
    expect(ids(planWith('node -r coffee-script-extra/register server.js'))).toContain('remove:coffee-script');
  });

  it('leaves alone a scoped package whose subpath a script loads, and a package named like a local directory', () => {
    const planWith = (name: string, script: string) => {
      const dead = tomb(name, { status: 'dead', causes: [{ kind: 'deprecated', detail: 'Deprecated' }] });
      const manifest = { ...exhume.manifests[0]!, dependencies: { ...exhume.manifests[0]!.dependencies, [name]: '^1.0.0' }, scripts: { start: script } };
      return buildPlan({ ...all, graveyard: { ...graveyard, tombstones: [...tombstones, dead] }, exhume: { ...exhume, manifests: [manifest] } }, { now: NOW });
    };
    // A scoped name followed by a subpath counts as used; a different package under the same scope does not.
    const scoped = planWith('@scope/pkg', 'node -r @scope/pkg/register server.js');
    expect(ids(scoped)).not.toContain('remove:@scope/pkg');
    expect(scoped.leftAlone.find((l) => l.name === '@scope/pkg')!.reason).toMatch(/^Used by the start script\. /);
    expect(ids(planWith('@scope/pkg', 'node -r @scope/pkg-extra/register server.js'))).toContain('remove:@scope/pkg');
    // Accepted trade-off: a dependency named like a local directory counts as used, so it is kept rather than removed.
    const local = planWith('config', 'node config/setup.js');
    expect(ids(local)).not.toContain('remove:config');
    expect(local.leftAlone.find((l) => l.name === 'config')!.reason).toMatch(/^Used by the start script\. /);
  });

  it('does not remove a package that is loaded by name, and lists those files', () => {
    const jade = tomb('jade', { status: 'dead', causes: [{ kind: 'deprecated', detail: 'Deprecated: renamed to pug' }] });
    const manifest = { ...exhume.manifests[0]!, dependencies: { ...exhume.manifests[0]!.dependencies, jade: '^1.11.0' } };
    const packages = [
      ...exhume.externalPackages,
      { name: 'jade', importedBy: 0, importers: [], referencedBy: ['app.js', 'lib/views.js'], referenceCount: 2 },
    ];
    const plan = buildPlan(
      { ...all, graveyard: { ...graveyard, tombstones: [...tombstones, jade] }, exhume: { ...exhume, manifests: [manifest], externalPackages: packages } },
      { now: NOW },
    );
    expect(ids(plan)).not.toContain('remove:jade');
    expect(plan.leftAlone.find((l) => l.name === 'jade')!.reason).toBe(
      'Nothing imports it, but it is loaded by name in app.js and lib/views.js; check before removing it.',
    );

    // A package that is both imported and named lists both kinds of file in touches.
    const named = packages.map((p) => (p.name === 'lodash' ? { ...p, referencedBy: ['config.js', 'lib/a.js'], referenceCount: 2 } : p));
    const lodash = step(buildPlan({ ...all, exhume: { ...exhume, externalPackages: named } }, { now: NOW }), 'upgrade:lodash');
    expect(lodash.touches).toEqual(['config.js', 'lib/a.js', 'lib/b.js']);
    expect(lodash.why).toContain('Loaded by name (a string literal, not an import) in 2 files.');
  });

  it('counts every touched file, not just the listed ones', () => {
    const importers = Array.from({ length: 20 }, (_, i) => `lib/f${String(i).padStart(2, '0')}.js`);
    const packages = exhume.externalPackages.map((p) => (p.name === 'lodash' ? { name: 'lodash', importedBy: 150, importers } : p));
    const plan = buildPlan({ ...all, exhume: { ...exhume, externalPackages: packages } }, { now: NOW });
    const lodash = step(plan, 'upgrade:lodash');
    expect(lodash).toMatchObject({ touches: importers, touchCount: 150 });
    expect(lodash.why).toContain('Imported by 150 files.');
    const md = renderPlanMarkdown(plan);
    expect(md).toContain(`Touches 150 files; the first 10: ${importers.slice(0, 10).map((f) => `\`${f}\``).join(', ')}.`);
    expect(md).not.toMatch(/and 10 more/);
  });

  it('maps goals to steps by keyword and package name', () => {
    const plan = buildPlan(all, { now: NOW });
    expect(plan.intent).toBe(interview.intent);
    expect(plan.goals).toHaveLength(3);
    expect(step(plan, 'upgrade:lodash').goals).toContain('Clear the security advisories');
    expect(step(plan, 'replace:mysql').goals).toContain('Clear the security advisories');
    expect(step(plan, 'upgrade:async').goals).not.toContain('Clear the security advisories');
    expect(step(plan, `upgrade-node:${TARGET_NODE}`).goals).toEqual(['Run on a current Node LTS']);
    expect(step(plan, 'upgrade:express').goals).toEqual(['Keep express routes working']);
    const showcase = buildPlan({ ...all, interview: { ...interview, goals: [{ text: 'Showcase the API', origin: 'user' }] } as InterviewReport }, { now: NOW });
    expect(step(showcase, 'code-fix:import-case').goals).toEqual([]);
  });
});

describe('renderPlanMarkdown', () => {
  it('prints every step followed by its check', () => {
    const plan = buildPlan(all, { now: NOW });
    const md = renderPlanMarkdown(plan);
    expect(md).toContain(`# Modernization plan for ${SOURCE}`);
    expect(md).toContain(interview.intent);
    expect(md).toContain('- Clear the security advisories');
    const sections = md.split(/^### /m).slice(1);
    expect(sections).toHaveLength(plan.steps.length);
    sections.forEach((section, i) => {
      expect(section.startsWith(`${i + 1}. ${plan.steps[i]!.title}`)).toBe(true);
      expect(section).toContain(`Then check: \`necromancer witness ${SOURCE} --check\`.`);
    });
    expect(md).toContain('## Left alone');
    expect(md).toContain('`lib/ErrorCodes.js`');
  });

  it('caps the touched files', () => {
    const plan = buildPlan(all, { now: NOW });
    plan.steps[0]!.touches = Array.from({ length: 15 }, (_, i) => `f${i}.js`);
    expect(renderPlanMarkdown(plan)).toContain('Touches 15 files; the first 10: `f0.js`,');
    expect(renderPlanMarkdown(plan)).toContain('Touches 32 files; the first 2: `lib/a.js`, `lib/b.js`.');
  });
});
