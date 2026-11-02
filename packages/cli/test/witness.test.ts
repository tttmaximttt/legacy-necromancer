import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportStore } from '@necromancer/core';
import { createProgram } from '../src/index.js';
import { deadApp, expressMongoApp, FakeSandbox } from '../../resurrect/test/helpers.js';
import { answering } from '../../witness/test/helpers.js';

const app = {
  ...expressMongoApp,
  'package.json': JSON.stringify({ name: 'dead-api', scripts: { start: 'node server.js', test: 'mocha' }, dependencies: { express: '^4.15.0' } }),
  'server.js': "var app = require('express')();\napp.get('/users/:id', function (req, res) { res.json({ name: 'ada' }); });\napp.listen(3000);\n",
};

describe('necromancer witness', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('saves golden snapshots, then --check exits 1 when behaviour changes', async () => {
    const root = await deadApp(app);
    const reports = await mkdtemp(path.join(os.tmpdir(), 'necro-cli-wit-'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let status = 200;
    const sandbox = new FakeSandbox({ exec: answering(() => ({ status, body: { name: 'ada' } })) });
    const cli = (...args: string[]) => createProgram({ sandbox }).parseAsync(['node', 'necromancer', ...args, root, '--reports', reports, '-q']);
    const written = () => stderr.mock.calls.map((c) => String(c[0])).join('');

    await expect(cli('witness')).rejects.toThrow(/run `necromancer resurrect/);
    await cli('resurrect', '--no-llm');
    await cli('witness', '--no-llm');
    expect(written()).toContain('WITNESSED 1/1 route(s) with 1 request(s); tests passed (2 passing)');
    const golden = (await new ReportStore(reports).load(path.basename(root)))!.witness!;
    expect(golden.snapshots[0]).toMatchObject({ case: { path: '/users/1' }, response: { status: 200, body: { name: 'ada' } } });

    await cli('witness', '--check');
    expect(written()).toContain('No behaviour changes across 1 request(s)');
    expect(process.exitCode).toBeUndefined();

    status = 500;
    await cli('witness', '--check');
    expect(written()).toContain('status  GET /users/1 (default): 200 → 500');
    expect(process.exitCode).toBe(1);
    expect((await new ReportStore(reports).load(path.basename(root)))!.witness!.generatedAt).toBe(golden.generatedAt);
  });
});
