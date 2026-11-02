import { DirectedGraph, UndirectedGraph } from 'graphology';
import { createRequire } from 'node:module';
import path from 'node:path';
import { seededRandom, type FileChurn, type LoadBearingFile, type ModuleCluster, type SourceFile } from '@necromancer/core';

// These two are CommonJS-only and their typings declare an ES default export,
// which NodeNext can't line up with `module.exports`; require them directly.
const require = createRequire(import.meta.url);
const louvain: typeof import('graphology-communities-louvain').default = require('graphology-communities-louvain');
const betweennessCentrality: typeof import('graphology-metrics/centrality/betweenness.js').default = require(
  'graphology-metrics/centrality/betweenness.js',
);

export type ImportGraph = DirectedGraph<{ loc: number; isTest: boolean }>;

/** Directed graph: an edge A → B means file A imports file B. */
export function buildImportGraph(files: SourceFile[]): ImportGraph {
  const graph: ImportGraph = new DirectedGraph({ multi: false, allowSelfLoops: false });
  for (const f of files) graph.addNode(f.path, { loc: f.loc, isTest: f.isTest });
  for (const f of files) {
    for (const imp of f.imports) {
      if (imp.type !== 'internal' || imp.target === f.path || !graph.hasNode(imp.target)) continue;
      graph.mergeEdge(f.path, imp.target);
    }
  }
  return graph;
}

export interface GraphAnalysis {
  clusters: ModuleCluster[];
  loadBearing: LoadBearingFile[];
  /** Every analysed file with its score components, best first; `loadBearing` is the top of this. */
  ranked: LoadBearingFile[];
  orphans: string[];
}

export interface AnalyzeOptions {
  churn?: Record<string, FileChurn>;
  /** How many load-bearing files to return. */
  top?: number;
  seed?: number;
  /** Treat test files as architecture (clusters, ranking, orphans). Off by default: a spec helper isn't architecture. */
  includeTests?: boolean;
}

/**
 * Weights for the load-bearing score. Blast radius dominates because it is
 * what "load-bearing" means; betweenness catches the files that hold the
 * architecture together; churn says where the past pain was.
 */
export const SCORE_WEIGHTS = { blastRadius: 0.5, betweenness: 0.3, churn: 0.2 } as const;

export function analyzeGraph(fullGraph: ImportGraph, options: AnalyzeOptions = {}): GraphAnalysis {
  const { churn = {}, top = 5, seed = 42, includeTests = false } = options;

  const graph = fullGraph.copy();
  if (!includeTests) for (const node of graph.filterNodes((_n, attrs) => attrs.isTest)) graph.dropNode(node);

  const orphans = graph.filterNodes((node) => graph.degree(node) === 0).sort();
  const clusters = clusterGraph(graph, new Set(orphans), seed);

  const clusterOf = new Map<string, number>();
  for (const c of clusters) for (const f of c.files) clusterOf.set(f, c.id);

  const betweenness = graph.size > 0 ? betweennessCentrality(graph, { normalized: true }) : {};
  const nodes = graph.nodes();
  const max = (values: number[]) => Math.max(1e-9, ...values);
  const maxBetweenness = max(nodes.map((n) => betweenness[n] ?? 0));
  const blast = new Map(nodes.map((n) => [n, blastRadius(graph, n)]));
  const maxBlast = max([...blast.values()]);
  const maxChurn = max(nodes.map((n) => Math.log1p(churn[n]?.commits ?? 0)));

  const ranked = nodes
    .map((node): LoadBearingFile => {
      const b = betweenness[node] ?? 0;
      const fanIn = graph.inDegree(node);
      const radius = blast.get(node) ?? 0;
      const commits = churn[node]?.commits ?? 0;
      const score =
        SCORE_WEIGHTS.blastRadius * (radius / maxBlast) +
        SCORE_WEIGHTS.betweenness * (b / maxBetweenness) +
        SCORE_WEIGHTS.churn * (Math.log1p(commits) / maxChurn);
      return {
        path: node,
        score: round(score),
        betweenness: round(b),
        blastRadius: radius,
        fanIn,
        fanOut: graph.outDegree(node),
        churn: commits,
        cluster: clusterOf.get(node) ?? -1,
      };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const loadBearing = ranked.filter((f) => f.fanIn + f.fanOut > 0).slice(0, top);

  return { clusters, loadBearing, ranked, orphans };
}

/** Number of files that reach `node` by following imports backwards. */
function blastRadius(graph: ImportGraph, node: string): number {
  const seen = new Set([node]);
  const queue = [node];
  while (queue.length) {
    graph.forEachInNeighbor(queue.pop()!, (dependant) => {
      if (!seen.has(dependant)) {
        seen.add(dependant);
        queue.push(dependant);
      }
    });
  }
  return seen.size - 1;
}

/**
 * Louvain on the undirected projection: for architecture, "A imports B" and
 * "B imports A" both mean A and B belong together. Seeded so output is stable.
 */
function clusterGraph(graph: ImportGraph, skip: Set<string>, seed: number): ModuleCluster[] {
  const undirected = new UndirectedGraph({ multi: false, allowSelfLoops: false });
  graph.forEachNode((node) => {
    if (!skip.has(node)) undirected.addNode(node);
  });
  graph.forEachEdge((_edge, _attrs, source, target) => {
    undirected.mergeEdge(source, target);
  });
  if (undirected.order === 0) return [];

  const communities = louvain(undirected, { rng: seededRandom(seed) });

  const groups = new Map<number, string[]>();
  for (const [node, community] of Object.entries(communities)) {
    let members = groups.get(community);
    if (!members) groups.set(community, (members = []));
    members.push(node);
  }

  const sorted = [...groups.values()]
    .map((files) => files.sort())
    .sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));

  const labels = new Map<string, number>();
  return sorted.map((files, id) => {
    const members = new Set(files);
    let internal = 0;
    let boundary = 0;
    for (const f of files) {
      undirected.forEachNeighbor(f, (n) => {
        if (members.has(n)) internal++;
        else boundary++;
      });
    }
    // Each internal edge is seen from both ends.
    internal /= 2;

    let label = dominantDirectory(files);
    const seen = labels.get(label) ?? 0;
    labels.set(label, seen + 1);
    if (seen > 0) label = `${label} #${seen + 1}`;

    return {
      id,
      label,
      size: files.length,
      files,
      cohesion: internal + boundary === 0 ? 1 : round(internal / (internal + boundary)),
    };
  });
}

function dominantDirectory(files: string[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const dir = path.posix.dirname(f);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? '.';
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
