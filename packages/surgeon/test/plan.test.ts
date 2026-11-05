import { describe, expect, it } from 'vitest';
import type { BuildRecipe, GraveyardReport, ResurrectReport, Tombstone } from '@necromancer/core';
import { TARGET_NODE } from '@necromancer/plan';
import { validateOp } from '@necromancer/resurrect';
import { planSteps } from '@necromancer/surgeon';

function tomb(name: string, over: Partial<Tombstone> = {}): Tombstone {
  return {
    name,
    declared: '^1.0.0',
    dev: false,
    resolved: '1.0.0',
    resolvedFrom: 'lockfile',
    latest: '2.0.0',
    majorsBehind: 1,
    lastPublished: null,
    repository: null,
    status: 'ailing',
    causes: [],
    advisories: [],
    replacement: null,
    epitaph: '',
    ...over,
  };
}

function graveyardOf(tombstones: Tombstone[], nonRegistry: GraveyardReport['nonRegistry'] = []): GraveyardReport {
  return {
    repo: { source: '/code/old-app', commit: null },
    era: { born: null, died: null, dependencyFloor: null, node: null, estimate: null, confidence: 'none', summary: '' },
    summary: { total: tombstones.length, dead: 0, dying: 0, ailing: 0, alive: 0, unknown: 0, vulnerable: 0 },
    tombstones,
    sources: { registry: 'ok', advisories: 'ok', advisoryProvider: 'osv', github: 'ok' },
    nonRegistry,
    warnings: [],
  };
}

function resurrectOf(recipe: Partial<BuildRecipe> = {}): ResurrectReport {
  return { recipe: { nodeImage: 'node:8-stretch', dependencyPatches: {}, ...recipe } } as unknown as ResurrectReport;
}

describe('planSteps', () => {
  it('puts Node first, then dead, dying and ailing; prod before dev, fewer majors first (null last), then name', () => {
    const tombstones = [
      tomb('z-ailing', { status: 'ailing', majorsBehind: 1 }),
      tomb('a-ailing-dev', { status: 'ailing', dev: true, majorsBehind: 0 }),
      tomb('b-ailing-null', { status: 'ailing', majorsBehind: null }),
      tomb('a-ailing-far', { status: 'ailing', majorsBehind: 3 }),
      tomb('b-ailing', { status: 'ailing', majorsBehind: 1 }),
      tomb('dying', { status: 'dying' }),
      tomb('dead-dev', { status: 'dead', dev: true }),
      tomb('dead', { status: 'dead' }),
    ];
    const steps = planSteps({ graveyard: graveyardOf(tombstones), resurrect: resurrectOf() });
    expect(steps.map((s) => s.id)).toEqual([
      `node:${TARGET_NODE}`,
      'dep:dead',
      'dep:dead-dev',
      'dep:dying',
      'dep:b-ailing',
      'dep:z-ailing',
      'dep:a-ailing-far',
      'dep:b-ailing-null',
      'dep:a-ailing-dev',
    ]);
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const s of steps.filter((s) => s.skip === null)) expect(() => validateOp(s.op)).not.toThrow();
  });

  it('builds the Node step on the plain target major', () => {
    const [step] = planSteps({ graveyard: graveyardOf([]), resurrect: resurrectOf() });
    expect(step).toEqual({
      n: 1,
      id: `node:${TARGET_NODE}`,
      kind: 'upgrade-node',
      title: `Move to Node ${TARGET_NODE}`,
      op: { op: 'setNodeImage', tag: TARGET_NODE },
      change: { name: 'node', from: '8', to: TARGET_NODE },
      status: null,
      dev: false,
      why: [expect.stringContaining('node:8-stretch')],
      skip: null,
    });
  });

  it('builds a dependency step with an exact version and the causes and advisories as why', () => {
    const t = tomb('lodash', {
      resolved: '4.17.4',
      latest: '4.18.1',
      dev: true,
      causes: [{ kind: 'vulnerable', detail: '10 advisories' }],
      advisories: [{ id: 'GHSA-1', title: 'x', severity: 'high', url: null, vulnerableVersions: null }],
    });
    const [step] = planSteps({ graveyard: graveyardOf([t]), resurrect: resurrectOf({ nodeImage: `node:${TARGET_NODE}` }) });
    expect(step).toMatchObject({
      id: 'dep:lodash',
      kind: 'upgrade-dependency',
      title: 'Upgrade lodash from 4.17.4 to 4.18.1',
      op: { op: 'setDependency', name: 'lodash', version: '4.18.1', dev: true },
      change: { name: 'lodash', from: '4.17.4', to: '4.18.1' },
      status: 'ailing',
      dev: true,
      why: ['10 advisories', 'Advisories: GHSA-1'],
      skip: null,
    });
  });

  it('adds no Node step when the recipe is already on the target or newer', () => {
    for (const nodeImage of [`node:${TARGET_NODE}`, `node:${TARGET_NODE}-bookworm`, `node:${Number(TARGET_NODE) + 2}`]) {
      expect(planSteps({ graveyard: graveyardOf([]), resurrect: resurrectOf({ nodeImage }) })).toEqual([]);
    }
  });

  it('adds a Node step for a 0.x line and for an image with no version', () => {
    const fromOld = planSteps({ graveyard: graveyardOf([]), resurrect: resurrectOf({ nodeImage: 'node:0.10' }) });
    expect(fromOld.map((s) => s.change.from)).toEqual(['0.10']);
    const fromLts = planSteps({ graveyard: graveyardOf([]), resurrect: resurrectOf({ nodeImage: 'node:lts' }) });
    expect(fromLts.map((s) => [s.id, s.change.from])).toEqual([[`node:${TARGET_NODE}`, null]]);
  });

  it('honours targetNode', () => {
    const steps = planSteps({ graveyard: graveyardOf([]), resurrect: resurrectOf({ nodeImage: 'node:20' }) }, { targetNode: '22' });
    expect(steps.map((s) => s.op)).toEqual([{ op: 'setNodeImage', tag: '22' }]);
    expect(planSteps({ graveyard: graveyardOf([]), resurrect: resurrectOf({ nodeImage: 'node:20' }) }, { targetNode: '18' })).toEqual([]);
  });

  describe('skip rules', () => {
    const skipOf = (t: Tombstone, recipe: Partial<BuildRecipe> = {}) =>
      planSteps({ graveyard: graveyardOf([t]), resurrect: resurrectOf({ nodeImage: `node:${TARGET_NODE}`, ...recipe }) })[0]!;

    it('skips a dependency resurrect pinned or removed to boot', () => {
      const pinned = skipOf(tomb('express', { resolved: '3.3.8', latest: '5.1.0' }), { dependencyPatches: { express: { version: '3.21.2', dev: false } } });
      expect(pinned.skip).toBe('resurrect pinned it to 3.21.2 to boot');
      expect(pinned.op).toEqual({ op: 'setDependency', name: 'express', version: '5.1.0', dev: false });
      const removed = skipOf(tomb('fsevents'), { dependencyPatches: { fsevents: { version: null, dev: true } } });
      expect(removed.skip).toBe('resurrect removed it to boot');
    });

    it('skips a dependency with no release on the registry', () => {
      const step = skipOf(tomb('ghost', { status: 'dead', latest: null, resolved: null, declared: '^0.3.0' }));
      expect(step.skip).toBe('no release found on the registry');
      expect(step.op.op === 'setDependency' && step.op.version).toBe('^0.3.0');
      expect(step.title).toBe('Keep ghost at ^0.3.0');
    });

    it('skips a dependency already on its newest release', () => {
      const plain = skipOf(tomb('hat', { status: 'dying', resolved: '0.0.3', latest: '0.0.3' }));
      expect(plain.skip).toBe('already on the newest release and no replacement is known');
      expect(plain.title).toBe('Keep hat at 0.0.3');
      const replaced = skipOf(
        tomb('request', {
          status: 'dead',
          resolved: '2.88.2',
          latest: '2.88.2',
          replacement: { name: 'node-fetch', reason: 'request is deprecated', source: 'known' },
        }),
      );
      expect(replaced.skip).toBe('needs a code change: replace with node-fetch');
    });

    it('skips a dependency whose latest version the recipe would reject', () => {
      const step = skipOf(tomb('odd', { latest: '1.0.0;rm -rf /' }));
      expect(step.skip).toMatch(/^invalid version: rejected setDependency: invalid version/);
    });
  });

  it.each([
    ['a scoped package', tomb('@scope/pkg', { resolved: '1.2.0', latest: '2.0.0' }), 'Upgrade @scope/pkg from 1.2.0 to 2.0.0'],
    ['a git URL with no resolved version', tomb('forked', { declared: 'git+https://example.com/a/forked.git', resolved: null, latest: '2.0.0' }), 'Upgrade forked from git+https://example.com/a/forked.git to 2.0.0'],
    ['a prerelease latest', tomb('beta', { resolved: '2.9.0', latest: '3.0.0-beta.1' }), 'Upgrade beta from 2.9.0 to 3.0.0-beta.1'],
  ])('plans a runnable step for %s', (_, t, title) => {
    const [step] = planSteps({ graveyard: graveyardOf([t]), resurrect: resurrectOf({ nodeImage: `node:${TARGET_NODE}` }) });
    expect(step).toMatchObject({ id: `dep:${t.name}`, title, skip: null, op: { op: 'setDependency', name: t.name, version: t.latest } });
    expect(() => validateOp(step!.op)).not.toThrow();
  });

  it.each([
    ['node:24@sha256:abc', false],
    ['registry.x/node:24.1.0-slim', false],
    ['node:10.24-stretch', true],
  ])('Node image %s needs a Node step: %s', (nodeImage, expected) => {
    const steps = planSteps({ graveyard: graveyardOf([]), resurrect: resurrectOf({ nodeImage }) }, { targetNode: '24' });
    expect(steps.map((s) => s.id)).toEqual(expected ? ['node:24'] : []);
  });

  it('ignores alive, unknown and non-registry dependencies', () => {
    const graveyard = graveyardOf([tomb('fine', { status: 'alive' }), tomb('mystery', { status: 'unknown' })], [{ name: 'forked', spec: 'git+https://example.com/forked.git' }]);
    expect(planSteps({ graveyard, resurrect: resurrectOf({ nodeImage: `node:${TARGET_NODE}` }) })).toEqual([]);
  });

  it('is deterministic: shuffled tombstones give the same plan', () => {
    const tombstones = [
      tomb('a', { status: 'dead' }),
      tomb('b', { status: 'dying', dev: true }),
      tomb('c', { status: 'ailing', majorsBehind: null }),
      tomb('d', { status: 'ailing', majorsBehind: 2 }),
      tomb('e', { status: 'ailing', majorsBehind: 2 }),
      tomb('f', { status: 'dying', latest: null }),
      tomb('g', { status: 'alive' }),
    ];
    const plan = (list: Tombstone[]) => planSteps({ graveyard: graveyardOf(list), resurrect: resurrectOf() });
    const expected = plan(tombstones);
    expect(plan([...tombstones].reverse())).toEqual(expected);
    expect(plan([tombstones[3]!, tombstones[6]!, tombstones[0]!, tombstones[5]!, tombstones[2]!, tombstones[4]!, tombstones[1]!])).toEqual(expected);
  });
});
