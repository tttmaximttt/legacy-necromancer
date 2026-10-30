import semver from 'semver';
import type { EraEstimate, RepoHistory } from '@necromancer/core';
import type { Packument } from './registry.js';

/** First release of each Node line that matters for old projects. */
const NODE_RELEASES: Array<[string, string]> = [
  ['0.6.0', '2011-11-04'],
  ['0.8.0', '2012-06-25'],
  ['0.10.0', '2013-03-11'],
  ['0.12.0', '2015-02-06'],
  ['4.0.0', '2015-09-08'],
  ['6.0.0', '2016-04-26'],
  ['8.0.0', '2017-05-30'],
  ['10.0.0', '2018-04-24'],
  ['12.0.0', '2019-04-23'],
  ['14.0.0', '2020-04-21'],
  ['16.0.0', '2021-04-20'],
  ['18.0.0', '2022-04-19'],
  ['20.0.0', '2023-04-18'],
  ['22.0.0', '2024-04-24'],
  ['24.0.0', '2025-05-06'],
];

export function nodeRelease(range: string): EraEstimate['node'] {
  let min: semver.SemVer | null = null;
  try {
    min = semver.minVersion(range);
  } catch {
    return null;
  }
  if (!min) return null;
  const line = [...NODE_RELEASES].reverse().find(([v]) => semver.gte(min!, v));
  return line ? { range, release: line[0].replace(/\.0$/, '').replace(/^(\d+)\.0$/, '$1'), released: line[1] } : null;
}

export interface EraInput {
  history: Omit<RepoHistory, 'files'> | { firstCommit: string | null; lastCommit: string | null };
  dependencies: Record<string, string>;
  packuments: Map<string, Packument | null>;
  nodeRange: string | null;
}

/**
 * Carbon-dates the project. Git history is the best evidence; the
 * dependency floor (the newest of the minimum versions the manifest allows)
 * still works on a tarball or a squashed repo with one commit.
 */
export function dateRemains(input: EraInput): EraEstimate {
  const { firstCommit: born, lastCommit: died } = input.history;

  let floor: EraEstimate['dependencyFloor'] = null;
  for (const [name, range] of Object.entries(input.dependencies)) {
    const pkg = input.packuments.get(name);
    if (!pkg) continue;
    let min: string | null = null;
    try {
      min = semver.minVersion(range)?.version ?? null;
    } catch {
      continue;
    }
    // `*` and `latest` say nothing about when the line was written.
    if (!min || min === '0.0.0') continue;
    const date = pkg.time[min];
    if (date && (!floor || date > floor.date)) floor = { date, package: name, version: min };
  }

  const node = input.nodeRange ? nodeRelease(input.nodeRange) : null;

  let estimate: string | null = null;
  let confidence: EraEstimate['confidence'] = 'none';
  if (died) {
    estimate = died;
    confidence = born && born !== died ? 'high' : 'medium';
  } else if (floor) {
    estimate = floor.date;
    confidence = 'medium';
  } else if (node) {
    estimate = node.released;
    confidence = 'low';
  }

  return { born, died, dependencyFloor: floor, node, estimate: estimate?.slice(0, 7) ?? null, confidence, summary: summarize(born, died, floor, node) };
}

function summarize(born: string | null, died: string | null, floor: EraEstimate['dependencyFloor'], node: EraEstimate['node']): string {
  const y = (d: string) => d.slice(0, 4);
  const parts: string[] = [];
  if (born && died) parts.push(y(born) === y(died) ? `Lived and died in ${y(died)}` : `Lived ${y(born)}–${y(died)}`);
  else if (died) parts.push(`Last touched ${died.slice(0, 7)}`);
  if (floor) parts.push(`manifest written no earlier than ${floor.date.slice(0, 7)} (${floor.package}@${floor.version})`);
  if (node) parts.push(`targets Node ${node.release} (${y(node.released)})`);
  return parts.length ? `${parts.join('; ')}.` : 'No dating evidence found.';
}

