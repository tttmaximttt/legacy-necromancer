import type { WitnessReport } from '@necromancer/core';
import { blank, differingPaths } from './normalize.js';

export interface WitnessDifference {
  case: string;
  what: 'missing' | 'new' | 'status' | 'headers' | 'body' | 'error' | 'tests';
  detail: string;
}

/**
 * Compares a new run against the golden snapshots. Everything the golden run marked volatile is already
 * blanked on both sides, so any difference left is a change in behaviour.
 */
export function compareWitness(golden: WitnessReport, current: WitnessReport): WitnessDifference[] {
  const key = (s: WitnessReport['snapshots'][number]) => `${s.case.method} ${s.case.path} (${s.case.name})`;
  const now = new Map(current.snapshots.map((s) => [key(s), s]));
  const out: WitnessDifference[] = [];
  for (const g of golden.snapshots) {
    const k = key(g);
    const c = now.get(k);
    now.delete(k);
    if (!c) {
      out.push({ case: k, what: 'missing', detail: 'not sent in this run' });
      continue;
    }
    if (g.response.error !== c.response.error) out.push({ case: k, what: 'error', detail: `${g.response.error ?? 'none'} → ${c.response.error ?? 'none'}` });
    if (g.response.status !== c.response.status) out.push({ case: k, what: 'status', detail: `${g.response.status} → ${c.response.status}` });
    const headers = differingPaths(g.response.headers, c.response.headers);
    if (headers.length) out.push({ case: k, what: 'headers', detail: `changed: ${headers.map((p) => p.slice(1)).join(', ')}` });
    const body = differingPaths(g.response.body, blank(c.response.body, g.volatile));
    if (body.length) out.push({ case: k, what: 'body', detail: `changed at ${body.slice(0, 5).join(', ')}${body.length > 5 ? ` and ${body.length - 5} more` : ''}` });
  }
  for (const k of now.keys()) out.push({ case: k, what: 'new', detail: 'not in the golden snapshots' });
  if (golden.tests && current.tests && golden.tests.ok !== current.tests.ok) {
    out.push({ case: golden.tests.command, what: 'tests', detail: `${golden.tests.ok ? 'passed' : 'failed'} → ${current.tests.ok ? 'passed' : 'failed'} (${current.tests.summary ?? 'no summary'})` });
  }
  return out;
}
