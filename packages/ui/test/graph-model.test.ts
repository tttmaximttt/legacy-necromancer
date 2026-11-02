import { describe, expect, it } from 'vitest';
import type { ExhumeReport, GraphNode } from '@necromancer/core';
import { basename, buildDisplayGraph, neighbourhood, nodeSize } from '../src/graph-model';
import { CATEGORICAL, clusterColor, OTHER } from '../src/palette';

const node = (id: string, cluster: number, score: number | null, isTest = false): GraphNode => ({
  id, cluster, score, isTest, loc: 10, fanIn: 0, fanOut: 0, blastRadius: score === null ? null : 1, churn: 0,
});

const report = {
  loadBearing: [{ path: 'lib/core.js' }, { path: 'lib/util.js' }],
  graph: {
    nodes: [node('lib/core.js', 0, 1), node('lib/util.js', 0, 0.5), node('app/a.js', 1, 0.1), node('app/b.js', 9, 0), node('test/a.test.js', -1, null, true)],
    edges: [
      ['app/a.js', 'lib/core.js'],
      ['lib/core.js', 'lib/util.js'],
      ['test/a.test.js', 'lib/core.js'],
    ],
  },
} as unknown as ExhumeReport;

describe('buildDisplayGraph', () => {
  it('hides tests unless asked, and drops their edges with them', () => {
    const g = buildDisplayGraph(report, { showTests: false, mode: 'light' });
    expect(g.order).toBe(4);
    expect(g.size).toBe(2);
    expect(buildDisplayGraph(report, { showTests: true, mode: 'light' }).size).toBe(3);
  });

  it('colours by cluster, folds clusters past the palette into "other", and ranks load-bearing files', () => {
    const g = buildDisplayGraph(report, { showTests: false, mode: 'dark' });
    expect(g.getNodeAttribute('lib/core.js', 'color')).toBe(CATEGORICAL.dark[0]);
    expect(g.getNodeAttribute('app/a.js', 'color')).toBe(CATEGORICAL.dark[1]);
    expect(g.getNodeAttribute('app/b.js', 'color')).toBe(OTHER.dark);
    expect(g.getNodeAttribute('lib/util.js', 'loadBearingRank')).toBe(1);
    expect(g.getNodeAttribute('app/a.js', 'loadBearingRank')).toBe(-1);
    expect(g.getNodeAttribute('lib/core.js', 'label')).toBe('core.js');
  });

  it('starts from the same positions every time', () => {
    const a = buildDisplayGraph(report, { showTests: false, mode: 'light' });
    const b = buildDisplayGraph(report, { showTests: false, mode: 'light' });
    expect(a.mapNodes((_n, at) => [at.x, at.y])).toEqual(b.mapNodes((_n, at) => [at.x, at.y]));
  });

  it('finds neighbours in both directions', () => {
    const g = buildDisplayGraph(report, { showTests: false, mode: 'light' });
    expect([...neighbourhood(g, 'lib/core.js')].sort()).toEqual(['app/a.js', 'lib/core.js', 'lib/util.js']);
  });
});

describe('helpers', () => {
  it('sizes nodes by score and labels them by file name', () => {
    expect(nodeSize(node('x', 0, null))).toBe(3);
    expect(nodeSize(node('x', 0, 1))).toBe(16);
    expect(basename('a/b/c.ts')).toBe('c.ts');
    expect(clusterColor(-1, 'light')).toBe(OTHER.light);
  });
});
