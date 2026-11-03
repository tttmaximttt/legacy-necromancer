import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { ReportStore, slugFor, type ExhumeReport, type GraveyardReport, type Tombstone } from '@necromancer/core';
import { ScriptedModel } from '@necromancer/llm';
import { createServer, summarize, type ServerOptions } from '@necromancer/mcp';
import { resurrect } from '@necromancer/resurrect';
import { fixtureRepo, goodProposal } from '../../interview/test/fixtures.js';
import { deadApp, expressMongoApp, FakeSandbox, NODE_GYP_LOG } from '../../resurrect/test/helpers.js';
import { answering } from '../../witness/test/helpers.js';

// The real resurrect, wrapped so a test can see the options the server passed.
vi.mock('@necromancer/resurrect', async (importOriginal) => {
  const original = await importOriginal<typeof import('@necromancer/resurrect')>();
  return { ...original, resurrect: vi.fn(original.resurrect) };
});

const storeDir = await mkdtemp(path.join(os.tmpdir(), 'necro-store-'));

async function connect(options?: ServerOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ store: new ReportStore(storeDir), ...options }).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as Array<{ type: string; text: string }>)[0]!.text;

describe('necromancer MCP server', () => {
  it('reports the version of the package it ships in', async () => {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const client = await connect();
    expect(client.getServerVersion()).toEqual({ name: 'necromancer', version });
  });

  it('lists the tools and the autopsy prompt', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['exhume', 'graveyard', 'interview', 'record_interview', 'resurrect', 'witness', 'plan']);
    expect(tools.slice(0, 2).every((t) => t.annotations?.readOnlyHint)).toBe(true);
    expect(Object.keys(tools[1]!.inputSchema.properties ?? {})).toEqual(['source', 'advisories', 'github', 'detail', 'save']);
    expect(Object.keys(tools[0]!.inputSchema.properties ?? {})).toEqual(['source', 'top', 'includeTests', 'detail', 'save']);

    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['autopsy']);
    const prompt = await client.getPrompt({ name: 'autopsy', arguments: { source: 'https://example.com/x.git' } });
    expect(JSON.stringify(prompt.messages)).toContain('https://example.com/x.git');
  });

  it('runs the real excavator on a local directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'necro-mcp-'));
    await mkdir(path.join(root, 'lib'));
    await writeFile(path.join(root, 'index.js'), "require('./lib/db');\nrequire('./lib/api');\n");
    await writeFile(path.join(root, 'lib/api.js'), "require('./db');\nrequire('express');\n");
    await writeFile(path.join(root, 'lib/db.js'), "require('mongodb');\n");

    const client = await connect();
    const result = await client.callTool({ name: 'exhume', arguments: { source: root, top: 2 } });
    expect(result.isError).toBeFalsy();
    const report = JSON.parse(text(result));
    expect(report.stats).toMatchObject({ files: 3, internalEdges: 3, externalPackages: 2 });
    expect(report.loadBearing).toHaveLength(2);
    expect(report.loadBearing[0].path).toBe('lib/db.js');
    expect(report.truncated.hint).toContain('full');
    expect(report.savedTo).toBe(path.join(storeDir, path.basename(root), 'exhume.json'));
    expect((await new ReportStore(storeDir).load(path.basename(root)))?.exhume?.graph.nodes).toHaveLength(3);
  });

  it('passes options through and reports progress', async () => {
    const calls: unknown[] = [];
    const client = await connect({
      exhume: async (source, options) => {
        calls.push({ source, top: options.top, includeTests: options.includeTests });
        options.onProgress?.('parsing');
        options.onProgress?.('done');
        return fakeReport(3);
      },
    });
    const progress: string[] = [];
    const result = await client.callTool(
      { name: 'exhume', arguments: { source: 'git@x:y.git', top: 9, includeTests: true, detail: 'full', save: false } },
      undefined,
      { onprogress: (p) => progress.push(String(p.message)) },
    );
    expect(calls).toEqual([{ source: 'git@x:y.git', top: 9, includeTests: true }]);
    expect(progress).toEqual(['parsing', 'done']);
    expect(JSON.parse(text(result))).toEqual(fakeReport(3));
  });

  it('returns failures as tool errors, not protocol errors', async () => {
    const client = await connect({ exhume: async () => Promise.reject(new Error('could not clone nope')) });
    const result = await client.callTool({ name: 'exhume', arguments: { source: 'nope' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('exhume failed: could not clone nope');
  });
});

describe('graveyard tool', () => {
  it('maps options and summarises healthy dependencies to names', async () => {
    const calls: unknown[] = [];
    const client = await connect({
      graveyard: async (source, options) => {
        calls.push({ source, advisories: options.advisories, noGithub: options.noGithub });
        return fakeGraveyard();
      },
    });
    const result = await client.callTool({ name: 'graveyard', arguments: { source: 'x', advisories: 'osv', github: false } });
    expect(calls).toEqual([{ source: 'x', advisories: 'osv', noGithub: true }]);
    const body = JSON.parse(text(result));
    expect(body.alive).toEqual(['express@4.21.0']);
    expect(body.tombstones).toHaveLength(1);
    expect(body.tombstones[0]).toMatchObject({ name: 'lodash', moreAdvisories: 2 });
    expect(body.tombstones[0].advisories).toEqual([
      { id: 'A0', title: 't0', severity: 'high' },
      { id: 'A1', title: 't1', severity: 'high' },
      { id: 'A2', title: 't2', severity: 'high' },
    ]);
  });

  it('returns failures as tool errors', async () => {
    const client = await connect({ graveyard: async () => Promise.reject(new Error('boom')) });
    const result = await client.callTool({ name: 'graveyard', arguments: { source: 'x' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('graveyard failed: boom');
  });
});

describe('summarize', () => {
  it('cuts long lists and says how much it cut', () => {
    const summary = summarize(fakeReport(20));
    expect(summary.clusters[0]!.files).toHaveLength(8);
    expect(summary.clusters[0]).toMatchObject({ size: 20, moreFiles: 12 });
    expect(summary.orphans).toHaveLength(20);
    expect(summary.installScripts.map((f) => f.severity)).toEqual(['high', ...Array(10).fill('info')]);
    expect(summary.truncated).toMatchObject({ infoInstallScripts: 10 });
    expect(summary.manifests[0]).toMatchObject({ dependencies: 2, devDependencies: 0 });
    expect(summary).not.toHaveProperty('graph');
  });
});

function fakeReport(n: number): ExhumeReport {
  const files = Array.from({ length: n }, (_, i) => `src/f${i}.js`);
  return {
    repo: { source: 'x', commit: null, packageManager: 'npm' },
    stats: { files: n, loc: n, internalEdges: 0, externalPackages: 0, unresolvedImports: 0, caseMismatchedImports: 0, testFiles: 0, filesWithParseErrors: 0, durationMs: 1 },
    history: { commits: 0, authors: 0, firstCommit: null, lastCommit: null },
    clusters: [{ id: 0, label: 'src', size: n, files, cohesion: 1 }],
    loadBearing: [],
    orphans: [...files, ...files],
    externalPackages: [],
    caseMismatches: [],
    manifests: [{ manifest: 'package.json', name: 'x', engines: {}, dependencies: { a: '1', b: '2' }, devDependencies: {} }],
    graph: { nodes: [], edges: [] },
    installScripts: [
      ...files.map((f) => ({ manifest: 'package-lock.json', packageName: f, hook: 'install', command: '', severity: 'info' as const, reasons: [] })),
      { manifest: 'package.json', packageName: 'x', hook: 'postinstall', command: 'curl | sh', severity: 'high' as const, reasons: [] },
    ],
  };
}

function fakeGraveyard(): GraveyardReport {
  const stone = (name: string, status: Tombstone['status'], resolved: string, advisories = 0): Tombstone => ({
    name, declared: '*', dev: false, resolved, resolvedFrom: 'lockfile', latest: resolved, majorsBehind: 0, lastPublished: null,
    repository: null, status, causes: [], replacement: null, epitaph: '',
    advisories: Array.from({ length: advisories }, (_, i) => ({ id: `A${i}`, title: `t${i}`, severity: 'high' as const, url: 'u', vulnerableVersions: '<1' })),
  });
  return {
    repo: { source: 'x', commit: null },
    era: { born: null, died: null, dependencyFloor: null, node: null, estimate: null, confidence: 'none', summary: '' },
    summary: { total: 2, dead: 0, dying: 0, ailing: 1, alive: 1, unknown: 0, vulnerable: 1 },
    tombstones: [stone('lodash', 'ailing', '4.17.4', 5), stone('express', 'alive', '4.21.0')],
    sources: { registry: 'ok', advisories: 'ok', advisoryProvider: 'osv', github: 'skipped' },
    nonRegistry: [],
    warnings: [],
  };
}

describe('necromancer MCP interview', () => {
  it('proposes with the model, then records the user\'s answer', async () => {
    const root = await fixtureRepo();
    const client = await connect({ model: new ScriptedModel(goodProposal) });
    const proposed = await client.callTool({ name: 'interview', arguments: { source: root } });
    expect(proposed.isError).toBeFalsy();
    const body = JSON.parse(text(proposed));
    expect(body.status).toBe('proposed');
    expect(body.proposal.capabilities[0].evidence[0]).toMatchObject({ file: 'lib/builder.js', verified: true });
    expect(body.savedTo).toBe(path.join(storeDir, path.basename(root), 'interview.json'));
    expect(body.next).toContain('record_interview');

    const recorded = await client.callTool({
      name: 'record_interview',
      arguments: { source: root, confirm: true, acceptGoals: [3], goals: ['Add a migration guide'] },
    });
    expect(JSON.parse(text(recorded))).toMatchObject({
      status: 'confirmed',
      intent: goodProposal.summary,
      goals: [
        { text: 'Publish ESM types', origin: 'suggested' },
        { text: 'Add a migration guide', origin: 'user' },
      ],
    });
    const saved = await new ReportStore(storeDir).load(path.basename(root));
    expect(saved?.interview?.status).toBe('confirmed');
  });

  it('hands the evidence to the host agent without an API key, and checks the host\'s citations', async () => {
    const root = await fixtureRepo();
    const client = await connect();
    const brief = JSON.parse(text(await client.callTool({ name: 'interview', arguments: { source: root, proposer: 'host' } })));
    expect(brief.proposer).toBe('host');
    expect(brief.evidence).toContain('<file path="lib/builder.js"');
    expect(brief.instructions).toContain('cite');

    const recorded = await client.callTool({
      name: 'record_interview',
      arguments: { source: root, correction: 'A query builder kept for one legacy app', proposal: goodProposal, host: 'claude-code' },
    });
    expect(recorded.isError).toBeFalsy();
    const saved = (await new ReportStore(storeDir).load(path.basename(root)))?.interview;
    expect(saved).toMatchObject({ status: 'corrected', proposedBy: { kind: 'host', name: 'claude-code' } });
    expect(saved?.proposal.constraints[0]!.evidence[1]!.verified).toBe(false);
  });

  it('refuses to record an answer before there is a proposal', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'record_interview', arguments: { source: '/nowhere/at-all', confirm: true } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('call interview first');
  });
});

describe('necromancer MCP resurrect', () => {
  it('runs the build-fix loop and saves the report', async () => {
    const root = await deadApp(expressMongoApp);
    const sandbox = new FakeSandbox({ install: [{ ok: false, log: NODE_GYP_LOG }] });
    const client = await connect({ sandbox });
    const result = await client.callTool({ name: 'resurrect', arguments: { source: root, tokenBudget: 0, approvals: 'all' } });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(text(result));
    expect(body.outcome).toBe('RESURRECTED');
    expect(body.attempts[0].fix.id).toBe('node-gyp-python');
    expect(body.dockerfile).toContain('FROM node:6');
    expect(body.savedTo).toBe(path.join(storeDir, path.basename(root), 'resurrect.json'));
  });

  it('reports BLOCKED with the reason', async () => {
    const root = await deadApp(expressMongoApp);
    const client = await connect({ sandbox: new FakeSandbox({ boot: [{ ok: false, log: 'Error: Cannot find module ./secret' }] }) });
    const body = JSON.parse(text(await client.callTool({ name: 'resurrect', arguments: { source: root, tokenBudget: 0, save: false } })));
    expect(body.outcome).toMatch(/^BLOCKED: boot failed and no known fix matches/);
    expect(body.savedTo).toBeUndefined();
  });

  it('pauses on a risky fix so the host can ask, then resumes with the answer', async () => {
    const root = await deadApp(expressMongoApp);
    const paused = await connect({ sandbox: new FakeSandbox({ install: [{ ok: false, log: NODE_GYP_LOG }] }) });
    const body = JSON.parse(text(await paused.callTool({ name: 'resurrect', arguments: { source: root, tokenBudget: 0, save: false } })));
    expect(body.outcome).toBe('NEEDS YOU');
    expect(body.pending).toEqual({
      kind: 'approval',
      fix: { source: 'known', id: 'node-gyp-python', description: expect.any(String) },
      risks: ['installs Debian packages: python, make, g++'],
    });
    expect(body.next).toMatch(/ask whether to apply it.*resume: true and approve: true/);
    expect(body.savedTo).toBe(path.join(storeDir, path.basename(root), 'resurrect.json'));

    const client = await connect({ sandbox: new FakeSandbox({}) });
    const missing = await client.callTool({ name: 'resurrect', arguments: { source: root, tokenBudget: 0, resume: true } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('resuming needs a decision on the pending fix');
    // approvals: "all" covers fixes found later, never the pending one, as the CLI's --yes.
    const all = await client.callTool({ name: 'resurrect', arguments: { source: root, tokenBudget: 0, resume: true, approvals: 'all' } });
    expect(all.isError).toBe(true);
    expect(text(all)).toContain('resuming needs a decision on the pending fix');
    expect(text(all)).toContain('then call again with approve: true or false; approvals: "all" does not answer it.');
    const resumed = JSON.parse(
      text(await client.callTool({ name: 'resurrect', arguments: { source: root, tokenBudget: 0, resume: true, approve: true, save: false } })),
    );
    expect(resumed.outcome).toBe('RESURRECTED');
    // Even with save: false, the resumed run replaces the stale needs-you report.
    expect(resumed.savedTo).toBe(path.join(storeDir, path.basename(root), 'resurrect.json'));
    expect((await new ReportStore(storeDir).load(path.basename(root)))?.resurrect?.outcome).toBe('resurrected');
    expect(resumed.decisions).toMatchObject([{ kind: 'approval', subject: 'node-gyp-python', answer: 'approved' }]);
    expect(resumed.pending).toBeUndefined();
  });

  it('refuses approve or answer without resume, and both together, leaving the paused run as it was', async () => {
    const root = await deadApp(expressMongoApp);
    const store = new ReportStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-mcp-')), 'reports'));
    await (await connect({ store, sandbox: new FakeSandbox({ install: [{ ok: false, log: NODE_GYP_LOG }] }) })).callTool({
      name: 'resurrect',
      arguments: { source: root, tokenBudget: 0 },
    });
    const client = await connect({ store, sandbox: new FakeSandbox({}) });
    for (const args of [{ approve: true }, { approve: false }, { answer: 'stub it' }]) {
      const result = await client.callTool({ name: 'resurrect', arguments: { source: root, tokenBudget: 0, ...args } });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('approve and answer go with resume: true');
    }
    const both = await client.callTool({ name: 'resurrect', arguments: { source: root, resume: true, approve: true, answer: 'stub it' } });
    expect(both.isError).toBe(true);
    expect(text(both)).toContain('not both');
    expect((await store.load(path.basename(root)))!.resurrect!.outcome).toBe('needs-you');
  });

  it('keeps the paused run\'s limits on resume unless the caller gives new ones', async () => {
    const root = await deadApp(expressMongoApp);
    const store = new ReportStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-mcp-')), 'reports'));
    const lastResume = () => vi.mocked(resurrect).mock.calls.at(-1)![1].resume!;
    const pause = async () =>
      (await connect({ store, sandbox: new FakeSandbox({ install: [{ ok: false, log: NODE_GYP_LOG }] }) })).callTool({
        name: 'resurrect',
        arguments: { source: root, maxIterations: 4, tokenBudget: 0 },
      });

    await pause();
    const client = await connect({ store, sandbox: new FakeSandbox({}) });
    expect(JSON.parse(text(await client.callTool({ name: 'resurrect', arguments: { source: root, resume: true, approve: true } }))).outcome).toBe('RESURRECTED');
    expect(lastResume()).toMatchObject({ approve: true, maxIterations: undefined, tokenBudget: undefined });

    await pause();
    await client.callTool({ name: 'resurrect', arguments: { source: root, resume: true, approve: true, maxIterations: 6, tokenBudget: 0 } });
    expect(lastResume()).toMatchObject({ approve: true, maxIterations: 6, tokenBudget: 0 });
  });

  it('asks the paused run\'s model on resume, and none when it asked none', async () => {
    const root = await deadApp(expressMongoApp);
    const store = new ReportStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-mcp-')), 'reports'));
    const last = () => vi.mocked(resurrect).mock.calls.at(-1)![1];
    const pause = async (args: Record<string, unknown>, model?: ScriptedModel) =>
      (await connect({ store, model, sandbox: new FakeSandbox({ install: [{ ok: false, log: NODE_GYP_LOG }] }) })).callTool({
        name: 'resurrect',
        arguments: { source: root, ...args },
      });
    const client = await connect({ store, model: new ScriptedModel(), sandbox: new FakeSandbox({}) });

    // Paused without a model: a larger budget alone does not bring one in.
    await pause({ tokenBudget: 0 }, new ScriptedModel());
    await client.callTool({ name: 'resurrect', arguments: { source: root, resume: true, approve: true, tokenBudget: 1000 } });
    expect(last().model).toBeNull();

    await pause({}, new ScriptedModel());
    expect(JSON.parse(text(await client.callTool({ name: 'resurrect', arguments: { source: root, resume: true, approve: true } }))).outcome).toBe('RESURRECTED');
    expect(last().model).toBeInstanceOf(ScriptedModel);

    // Paused with a model, resumed where there is no key: say how to add one, or to go on without.
    await pause({}, new ScriptedModel());
    const keyless = await connect({ store, sandbox: new FakeSandbox({}) });
    const refused = await keyless.callTool({ name: 'resurrect', arguments: { source: root, resume: true, approve: true } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/the paused run asked scripted for fixes, and there is no Anthropic API key; to add one, .*, or call again with tokenBudget: 0/);
    expect((await store.load(path.basename(root)))!.resurrect!.outcome).toBe('needs-you');
    const known = JSON.parse(text(await keyless.callTool({ name: 'resurrect', arguments: { source: root, resume: true, approve: true, tokenBudget: 0 } })));
    expect(known.outcome).toBe('RESURRECTED');
    expect(last().model).toBeNull();
  });

  it('pauses on a question and passes the answer on when resumed', async () => {
    const root = await deadApp(expressMongoApp);
    // A store of its own, so the model fix it learns stays out of the shared fix cache.
    const store = new ReportStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-mcp-')), 'reports'));
    const question = {
      diagnosis: '@acme/core is not on the public registry',
      decision: 'ask',
      ops: [],
      blockedReason: null,
      question: 'Is there a public replacement for @acme/core?',
      choices: ['stub it', 'drop the feature'],
    };
    const asking = await connect({
      store,
      sandbox: new FakeSandbox({ install: [{ ok: false, log: 'npm ERR! 404 Not Found: @acme/core@1.2.0' }] }),
      model: new ScriptedModel(question),
    });
    const body = JSON.parse(text(await asking.callTool({ name: 'resurrect', arguments: { source: root, approvals: 'all' } })));
    expect(body.outcome).toBe('NEEDS YOU');
    expect(body.pending).toEqual({ kind: 'question', question: question.question, context: expect.any(String), choices: question.choices });
    expect(body.next).toMatch(/resume: true and answer/);
    expect(body.next).toContain('do not ask them for passwords, keys or other secrets');

    const model = new ScriptedModel({ diagnosis: 'stub it', decision: 'fix', ops: [{ op: 'setEnv', name: 'CI', value: 'true' }], blockedReason: null, question: null, choices: [] });
    const client = await connect({ store, sandbox: new FakeSandbox({}), model });
    for (const blank of ['', '  ']) {
      const empty = await client.callTool({ name: 'resurrect', arguments: { source: root, resume: true, answer: blank } });
      expect(empty.isError).toBe(true);
      expect(text(empty)).toContain('answer is empty');
    }
    expect((await store.load(path.basename(root)))!.resurrect!.outcome).toBe('needs-you');
    const resumed = JSON.parse(text(await client.callTool({ name: 'resurrect', arguments: { source: root, resume: true, answer: 'stub it' } })));
    expect(resumed.outcome).toBe('RESURRECTED');
    expect(model.requests[0]!.prompt).toContain('The owner answered your question: stub it');
  });
});

describe('necromancer MCP plan', () => {
  it('needs a saved graveyard report', async () => {
    const root = await deadApp(expressMongoApp);
    const result = await (await connect()).callTool({ name: 'plan', arguments: { source: root } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('run the `graveyard` tool first');
  });

  it('returns the steps in a line each and saves plan.json and plan.md', async () => {
    const source = 'https://example.com/plan-me.git';
    await new ReportStore(storeDir).save('graveyard', { ...fakeGraveyard(), repo: { source, commit: null } });
    const body = JSON.parse(text(await (await connect()).callTool({ name: 'plan', arguments: { source } })));
    expect(body.target).toBe('Node 24');
    expect(body.steps).toEqual([`1. Move to Node 24 (high) → necromancer resurrect ${source}`]);
    expect(body.leftAlone).toBe(1);
    expect(body.warnings).toContain(`No witness report: run \`necromancer witness ${source}\` first so each step can be checked against recorded behaviour.`);
    expect(body.savedTo).toBe(path.join(storeDir, slugFor(source), 'plan.json'));
    expect(await readFile(body.markdown, 'utf8')).toContain(`# Modernization plan for ${source}`);
  });

  it('caps the step lines and points at plan.md for the rest', async () => {
    const source = 'https://example.com/plan-big.git';
    const base = fakeGraveyard();
    const tombstones = Array.from({ length: 40 }, (_, i) => ({ ...base.tombstones[0]!, name: `pkg-${String(i).padStart(2, '0')}`, latest: '4.18.0' }));
    await new ReportStore(storeDir).save('graveyard', { ...base, tombstones, repo: { source, commit: null } });
    const body = JSON.parse(text(await (await connect()).callTool({ name: 'plan', arguments: { source, save: false } })));
    expect(body.steps).toHaveLength(31);
    expect(body.steps.at(-1)).toBe('…and 11 more; call plan with save: true to write them all to plan.md');
    const saved = JSON.parse(text(await (await connect()).callTool({ name: 'plan', arguments: { source } })));
    expect(saved.steps.at(-1)).toBe(`…and 11 more; see ${path.join(storeDir, slugFor(source), 'plan.md')}`);
  });

  it('reports a plan.md that could not be saved instead of pointing at it', async () => {
    const source = 'https://example.com/plan-unsaved.git';
    const base = fakeGraveyard();
    const tombstones = Array.from({ length: 40 }, (_, i) => ({ ...base.tombstones[0]!, name: `pkg-${String(i).padStart(2, '0')}`, latest: '4.18.0' }));
    class NoFiles extends ReportStore {
      override async saveFile(source: string, name: string, text: string): Promise<string> {
        if (name === 'plan.md') throw new Error('EACCES: permission denied');
        return super.saveFile(source, name, text);
      }
    }
    const store = new NoFiles(storeDir);
    await store.save('graveyard', { ...base, tombstones, repo: { source, commit: null } });
    const body = JSON.parse(text(await (await connect({ store })).callTool({ name: 'plan', arguments: { source } })));
    expect(body.savedTo).toBe(path.join(storeDir, slugFor(source), 'plan.json'));
    expect(body.markdown).toBeNull();
    expect(body.markdownError).toContain('EACCES: permission denied');
    expect(body.steps.at(-1)).not.toContain('see ');
    expect(body.steps.at(-1)).toContain('could not be saved');
  });
});

describe('necromancer MCP witness', () => {
  const app = {
    ...expressMongoApp,
    'package.json': JSON.stringify({ name: 'dead-api', scripts: { start: 'node server.js', test: 'mocha' }, dependencies: { express: '^4.15.0' } }),
    'server.js': "var app = require('express')();\napp.get('/health', function (req, res) { res.json({ ok: true }); });\napp.listen(3000);\n",
  };

  it('needs a resurrect report first', async () => {
    const root = await deadApp(app);
    const result = await (await connect({ sandbox: new FakeSandbox({}) })).callTool({ name: 'witness', arguments: { source: root } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('run the `resurrect` tool first');
  });

  it('records snapshots, then checks a later run against them', async () => {
    const root = await deadApp(app);
    let ok = true;
    const client = await connect({ sandbox: new FakeSandbox({ exec: answering(() => ({ status: 200, body: { ok } })) }) });
    await client.callTool({ name: 'resurrect', arguments: { source: root, tokenBudget: 0 } });

    const golden = JSON.parse(text(await client.callTool({ name: 'witness', arguments: { source: root } })));
    expect(golden.routes).toEqual({ found: 1, exercised: 1, skipped: [] });
    expect(golden.snapshots).toEqual([{ request: 'GET /health', name: 'default', status: 200, error: null, body: '{"ok":true}' }]);
    expect(golden.tests.summary).toBe('2 passing');
    expect(golden.savedTo).toBe(path.join(storeDir, path.basename(root), 'witness.json'));

    expect(JSON.parse(text(await client.callTool({ name: 'witness', arguments: { source: root, check: true } }))).unchanged).toBe(true);
    ok = false;
    const check = JSON.parse(text(await client.callTool({ name: 'witness', arguments: { source: root, check: true } })));
    expect(check.unchanged).toBe(false);
    expect(check.differences).toEqual([{ case: 'GET /health (default)', what: 'body', detail: 'changed at /ok' }]);
    expect(check.savedTo).toBeUndefined();
  });
});
