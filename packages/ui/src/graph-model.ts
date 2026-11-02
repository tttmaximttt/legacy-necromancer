import Graph from 'graphology';
import type { ExhumeReport, GraphNode } from '@necromancer/core';
import { clusterColor, type Mode } from './palette';

export interface NodeAttrs {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
  cluster: number;
  /** Rank among load-bearing files (0 = most), or -1. */
  loadBearingRank: number;
  data: GraphNode;
}

export interface BuildOptions {
  showTests: boolean;
  mode: Mode;
}

/**
 * Turns an exhume report into a graphology graph sigma can draw. Positions
 * start on a ring of cluster centres so the force layout begins from the
 * clustering instead of noise, and the same report always starts the same.
 */
export function buildDisplayGraph(report: ExhumeReport, { showTests, mode }: BuildOptions): Graph<NodeAttrs> {
  const graph = new Graph<NodeAttrs>({ type: 'directed', multi: false, allowSelfLoops: false });
  const nodes = report.graph.nodes.filter((n) => showTests || !n.isTest);
  const rank = new Map(report.loadBearing.map((f, i) => [f.path, i]));

  const groups = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    const list = groups.get(n.cluster) ?? [];
    list.push(n);
    groups.set(n.cluster, list);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === -1 ? 1 : b === -1 ? -1 : a - b));
  const ring = Math.max(1, keys.length);
  const random = seeded(nodes.length);

  keys.forEach((cluster, i) => {
    const members = groups.get(cluster)!;
    const angle = (2 * Math.PI * i) / ring;
    const radius = ring === 1 ? 0 : 100;
    const spread = 10 + Math.sqrt(members.length) * 6;
    for (const n of members) {
      graph.addNode(n.id, {
        x: radius * Math.cos(angle) + (random() - 0.5) * spread,
        y: radius * Math.sin(angle) + (random() - 0.5) * spread,
        size: nodeSize(n),
        color: clusterColor(n.cluster, mode),
        label: basename(n.id),
        cluster: n.cluster,
        loadBearingRank: rank.get(n.id) ?? -1,
        data: n,
      });
    }
  });

  for (const [source, target] of report.graph.edges) {
    if (graph.hasNode(source) && graph.hasNode(target)) graph.mergeEdge(source, target);
  }
  return graph;
}

/** 3px for leaves, up to ~16px for the most load-bearing file. */
export function nodeSize(n: GraphNode): number {
  return 3 + 13 * Math.sqrt(n.score ?? 0);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** Files directly connected to `node`, in either direction. */
export function neighbourhood(graph: Graph, node: string): Set<string> {
  const out = new Set([node]);
  graph.forEachNeighbor(node, (n) => out.add(n));
  return out;
}

function seeded(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
