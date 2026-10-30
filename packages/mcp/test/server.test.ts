import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { ExhumeReport } from '@necromancer/core';
import { createServer, summarize, type ServerOptions } from '@necromancer/mcp';

async function connect(options?: ServerOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(options).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as Array<{ type: string; text: string }>)[0]!.text;

describe('necromancer MCP server', () => {
  it('lists exhume as a read-only tool and the autopsy prompt', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['exhume']);
    expect(tools[0]!.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(tools[0]!.inputSchema.properties ?? {})).toEqual(['source', 'top', 'includeTests', 'detail']);

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
      { name: 'exhume', arguments: { source: 'git@x:y.git', top: 9, includeTests: true, detail: 'full' } },
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

describe('summarize', () => {
  it('cuts long lists and says how much it cut', () => {
    const summary = summarize(fakeReport(20));
    expect(summary.clusters[0]!.files).toHaveLength(8);
    expect(summary.clusters[0]).toMatchObject({ size: 20, moreFiles: 12 });
    expect(summary.orphans).toHaveLength(20);
    expect(summary.installScripts.map((f) => f.severity)).toEqual(['high', ...Array(10).fill('info')]);
    expect(summary.truncated).toMatchObject({ infoInstallScripts: 10 });
    expect(summary.manifests[0]).toMatchObject({ dependencies: 2, devDependencies: 0 });
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
    installScripts: [
      ...files.map((f) => ({ manifest: 'package-lock.json', packageName: f, hook: 'install', command: '', severity: 'info' as const, reasons: [] })),
      { manifest: 'package.json', packageName: 'x', hook: 'postinstall', command: 'curl | sh', severity: 'high' as const, reasons: [] },
    ],
  };
}
