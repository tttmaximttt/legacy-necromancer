import { describe, expect, it } from 'vitest';
import { analyzeGraph, buildImportGraph } from '@necromancer/excavate';
import type { SourceFile } from '@necromancer/core';

function file(path: string, imports: string[], isTest = false): SourceFile {
  return {
    path,
    language: 'javascript',
    loc: 10,
    parseErrors: 0,
    isTest,
    imports: imports.map((target) => ({ type: 'internal', target, raw: { specifier: target, kind: 'import', line: 1 } })),
  };
}

/**
 * Two tight triangles (auth/*, billing/*) that both lean on core/bridge.js,
 * as does ui/view.js. Plus one file nothing touches.
 */
const files = [
  file('auth/a.js', ['auth/b.js', 'auth/c.js']),
  file('auth/b.js', ['auth/c.js']),
  file('auth/c.js', ['core/bridge.js']),
  file('core/bridge.js', []),
  file('billing/x.js', ['billing/y.js', 'billing/z.js']),
  file('billing/y.js', ['billing/z.js']),
  file('billing/z.js', ['core/bridge.js']),
  file('ui/view.js', ['core/bridge.js']),
  file('scripts/once.js', []),
  file('test/bridge.test.js', ['core/bridge.js', 'auth/a.js', 'billing/x.js'], true),
];

describe('buildImportGraph', () => {
  it('adds one deduplicated edge per internal import and ignores self/unknown targets', () => {
    const graph = buildImportGraph([...files, file('dup.js', ['auth/a.js', 'auth/a.js', 'dup.js', 'missing.js'])]);
    expect(graph.order).toBe(11);
    expect(graph.size).toBe(13);
    expect(graph.hasDirectedEdge('auth/c.js', 'core/bridge.js')).toBe(true);
  });
});

describe('analyzeGraph', () => {
  const analysis = analyzeGraph(buildImportGraph(files), { top: 3 });

  it('separates the two communities', () => {
    const clusterOf = (f: string) => analysis.clusters.find((c) => c.files.includes(f))!.id;
    expect(clusterOf('auth/a.js')).toBe(clusterOf('auth/c.js'));
    expect(clusterOf('billing/x.js')).toBe(clusterOf('billing/z.js'));
    expect(clusterOf('auth/a.js')).not.toBe(clusterOf('billing/x.js'));
    expect(analysis.clusters.map((c) => c.label)).toEqual(expect.arrayContaining(['auth', 'billing']));
  });

  it('ranks the shared core as the most load-bearing file', () => {
    expect(analysis.loadBearing).toHaveLength(3);
    expect(analysis.loadBearing[0]).toMatchObject({ path: 'core/bridge.js', fanIn: 3, fanOut: 0, blastRadius: 7 });
  });

  it('computes betweenness for pass-through files', () => {
    const c = analyzeGraph(buildImportGraph(files), { top: 20 }).loadBearing.find((f) => f.path === 'auth/c.js');
    expect(c).toMatchObject({ blastRadius: 2, fanIn: 2, fanOut: 1 });
    expect(c!.betweenness).toBeGreaterThan(0);
  });

  it('reports orphans and leaves tests out by default', () => {
    expect(analysis.orphans).toEqual(['scripts/once.js']);
    const all = analysis.clusters.flatMap((c) => c.files);
    expect(all).not.toContain('test/bridge.test.js');
  });

  it('can include tests', () => {
    const withTests = analyzeGraph(buildImportGraph(files), { includeTests: true, top: 20 });
    expect(withTests.clusters.flatMap((c) => c.files)).toContain('test/bridge.test.js');
  });

  it('lets churn move a file up the ranking', () => {
    const quiet = analyzeGraph(buildImportGraph(files), { top: 20 });
    const hot = analyzeGraph(buildImportGraph(files), {
      top: 20,
      churn: { 'billing/y.js': { commits: 500, authors: 9, lastTouched: '2015-01-01' } },
    });
    const rank = (a: typeof quiet, p: string) => a.loadBearing.findIndex((f) => f.path === p);
    expect(rank(hot, 'billing/y.js')).toBeLessThan(rank(quiet, 'billing/y.js'));
  });

  it('is deterministic for a given seed', () => {
    const again = analyzeGraph(buildImportGraph(files), { top: 3 });
    expect(again).toEqual(analysis);
  });

  it('copes with an empty graph', () => {
    expect(analyzeGraph(buildImportGraph([]))).toEqual({ clusters: [], loadBearing: [], ranked: [], orphans: [] });
  });
});
