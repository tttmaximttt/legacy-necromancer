import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { ReportStore, type ExhumeReport, type GraveyardReport, type Tombstone } from '@necromancer/core';
import { ScriptedModel } from '@necromancer/llm';
import { createServer, summarize, type ServerOptions } from '@necromancer/mcp';
import { fixtureRepo, goodProposal } from '../../interview/test/fixtures.js';
import { deadApp, expressMongoApp, FakeSandbox, NODE_GYP_LOG } from '../../resurrect/test/helpers.js';
import { answering } from '../../witness/test/helpers.js';

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
    expect(tools.map((t) => t.name)).toEqual(['exhume', 'graveyard', 'interview', 'record_interview', 'resurrect', 'witness']);
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
    const result = await client.callTool({ name: 'resurrect', arguments: { source: root, tokenBudget: 0 } });
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
