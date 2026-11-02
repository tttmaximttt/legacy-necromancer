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
    expect(plan.target.node).toBe(TARGET_NODE);
  });

  it('keeps packages that a script names, and does not remove packages exhume never saw', () => {
    const plan = buildPlan(all, { now: NOW });
    expect(ids(plan)).not.toContain('remove:jshint');
    expect(plan.leftAlone.find((l) => l.name === 'jshint')!.reason).toMatch(/^Used by the lint script\. /);
    expect(ids(plan)).not.toContain('remove:ghost');
    expect(plan.leftAlone.map((l) => l.name)).toContain('ghost');
  });

  it('says which Node Resurrect tried when it did not boot the app', () => {
    const paused = { ...resurrect, outcome: 'needs-you', recipe: { ...resurrect.recipe, nodeImage: 'registry/v2/node:8' } } as ResurrectReport;
    const node = step(buildPlan({ ...all, resurrect: paused }, { now: NOW }), `upgrade-node:${TARGET_NODE}`);
    expect(node.change).toEqual([{ name: 'node', from: '8', to: TARGET_NODE }]);
    expect(node.why.join(' ')).toContain('Resurrect tried Node 8 (registry/v2/node:8) but has not booted the app yet');
    expect(node.why.join(' ')).not.toContain('booted the app on');
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
    expect(renderPlanMarkdown(plan)).toContain('and 5 more');
  });
});
