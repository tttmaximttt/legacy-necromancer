import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GraveyardReport, Tombstone, WitnessCase } from '@necromancer/core';
import { nodeLine, ReportStore } from '@necromancer/core';
import { exhume } from '@necromancer/excavate';
import type { StructuredModel } from '@necromancer/llm';
import { resurrect, type FixProposal, type StepResult } from '@necromancer/resurrect';
import { witness } from '@necromancer/witness';
import { deadApp, FakeSandbox } from '../../resurrect/test/helpers.js';
import { answering } from '../../witness/test/helpers.js';

export type Deps = Record<string, string>;
/** How the app answers a request, given the dependencies in the package.json it was installed from. */
export type Respond = (c: WitnessCase, deps: Deps) => { status: number; body: unknown };
/** The result of an install, given its Dockerfile and dependencies; null for the FakeSandbox default (ok). */
export type Decide = (dockerfile: string, deps: Deps) => StepResult | null;

export const ok: Respond = () => ({ status: 200, body: { items: ['a', 'b'] } });

export const fail = (log: string): StepResult => ({ ok: false, log, durationMs: 1 });

export const fixed = () => new Date('2026-01-01T00:00:00.000Z');

export const fix = (ops: FixProposal['ops'], diagnosis = 'a missing system library'): FixProposal => ({
  diagnosis,
  decision: 'fix',
  ops,
  blockedReason: null,
  question: null,
  choices: [],
});

export const giveUp: FixProposal = { diagnosis: 'nothing else to try', decision: 'blocked', ops: [], blockedReason: 'nothing else to try', question: null, choices: [] };

const dependenciesOf = (manifest: Record<string, unknown> | undefined): Deps => (manifest?.dependencies ?? {}) as Deps;

/**
 * A FakeSandbox whose installs fail or pass by what they install (`decide`), and whose app answers by the
 * dependencies of the latest install (`respond`), so a test says "fails while a is 2.0.0" instead of counting calls.
 */
export function stepSandbox(decide: Decide = () => null, respond: Respond = ok): FakeSandbox {
  const sandbox: FakeSandbox = new FakeSandbox({ exec: answering((c) => respond(c, dependenciesOf(sandbox.manifests.at(-1)))) });
  const install = sandbox.install.bind(sandbox);
  sandbox.install = async (contextDir, tag, limits) => {
    const result = await install(contextDir, tag, limits);
    return decide(sandbox.dockerfiles.at(-1)!, dependenciesOf(sandbox.manifests.at(-1))) ?? result;
  };
  return sandbox;
}

/** A model that reports `perCall` tokens per answer, since ScriptedModel reports none. */
export function tokenModel(inner: StructuredModel, perCall: number): StructuredModel {
  return {
    name: inner.name,
    generate: async (request) => ({ ...(await inner.generate(request)), usage: { inputTokens: perCall, outputTokens: 0 } }),
  };
}

export function tomb(name: string, over: Partial<Tombstone> = {}): Tombstone {
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
    status: 'dead',
    causes: [],
    advisories: [],
    replacement: null,
    epitaph: '',
    ...over,
  };
}

export interface Seeded {
  root: string;
  store: ReportStore;
  /** The resurrected recipe's Node line, as the target so no Node step is planned. */
  node: string;
}

/**
 * A dead express app whose package.json lists `tombstones` at ^1.0.0, with saved reports as the real stages make
 * them: exhume, resurrect and a golden witness (both against FakeSandboxes, answering with `respond`), and a
 * hand-built graveyard.
 */
export async function seed(tombstones: Tombstone[], respond: Respond = ok): Promise<Seeded> {
  const dependencies = Object.fromEntries([['express', '^4.15.0'], ...tombstones.map((t) => [t.name, t.declared])]);
  const root = await deadApp({
    'package.json': JSON.stringify({ name: 'dead-shop', main: 'server.js', scripts: { start: 'node server.js' }, dependencies }),
    'server.js': [
      "var express = require('express');",
      'var app = express();',
      "app.get('/items', function (req, res) { res.json({ items: ['a', 'b'] }); });",
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
  });
  const store = new ReportStore(await mkdtemp(path.join(os.tmpdir(), 'necro-surgeon-')));
  const { root: _root, ...excavated } = await exhume(root);
  const revived = await resurrect(root, { sandbox: new FakeSandbox({}), model: null });
  const golden = await witness(root, { sandbox: new FakeSandbox({ exec: answering((c) => respond(c, dependencies)) }), resurrect: revived, exhume: excavated });
  const graveyard: GraveyardReport = {
    repo: { source: root, commit: null },
    era: { born: null, died: null, dependencyFloor: null, node: null, estimate: null, confidence: 'none', summary: '' },
    summary: { total: tombstones.length, dead: 0, dying: 0, ailing: 0, alive: 0, unknown: 0, vulnerable: 0 },
    tombstones,
    sources: { registry: 'ok', advisories: 'ok', advisoryProvider: 'osv', github: 'ok' },
    nonRegistry: [],
    warnings: [],
  };
  await store.save('exhume', excavated);
  await store.save('resurrect', revived);
  await store.save('witness', golden);
  await store.save('graveyard', graveyard);
  return { root, store, node: nodeLine(revived.recipe.nodeImage)! };
}
