import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportStore } from '@necromancer/core';
import { createProgram } from '../src/index.js';
import { deadApp, expressMongoApp, FakeSandbox, NODE_GYP_LOG } from '../../resurrect/test/helpers.js';

describe('necromancer resurrect', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('saves the report and writes the Dockerfile and compose file', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-'));
    const out = path.join(reports, 'out');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const sandbox = new FakeSandbox({ install: [{ ok: false, log: NODE_GYP_LOG }] });
    await createProgram({ sandbox }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '--out-dir', out, '--no-llm', '-q', '--memory', '1024']);

    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('RESURRECTED on node:6 after 2 attempt(s)');
    expect(process.exitCode).toBeUndefined();
    expect(await readFile(path.join(out, 'Dockerfile.necromancer'), 'utf8')).toContain('python make g++');
    expect(await readFile(path.join(out, 'docker-compose.necromancer.yml'), 'utf8')).toContain('mem_limit: 1024m');
    expect((await new ReportStore(reports).load(path.basename(root)))?.resurrect?.outcome).toBe('resurrected');
  });

  it('exits with code 2 and the reason when blocked', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const sandbox = new FakeSandbox({ boot: [{ ok: false, log: 'Error: Cannot find module ./secret' }] });
    await createProgram({ sandbox }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '--no-llm', '-q']);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('BLOCKED: boot failed and no known fix matches');
    expect(process.exitCode).toBe(2);
  });
});
