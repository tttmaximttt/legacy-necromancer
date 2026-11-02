import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportStore } from '@necromancer/core';
import { createProgram } from '../src/index.js';
import { ScriptedModel } from '@necromancer/llm';
import { deadApp, expressMongoApp, FakeSandbox, NODE_GYP_LOG } from '../../resurrect/test/helpers.js';

const PRIVATE = 'npm ERR! 404 Not Found: @acme/core@1.2.0';
const question = {
  diagnosis: '@acme/core is not on the public registry',
  decision: 'ask',
  ops: [],
  blockedReason: null,
  question: 'Is there a public replacement for @acme/core?',
  choices: ['stub it', 'drop the feature'],
};
const setEnv = { diagnosis: 'stub the private package', decision: 'fix', ops: [{ op: 'setEnv', name: 'ACME_STUB', value: '1' }], blockedReason: null, question: null, choices: [] };

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
    await createProgram({ sandbox, prompt: null }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '--out-dir', out, '--no-llm', '-q', '--memory', '1024', '--yes']);

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
    await createProgram({ sandbox, prompt: null }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '--no-llm', '-q']);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('BLOCKED: boot failed and no known fix matches');
    expect(process.exitCode).toBe(2);
  });

  it('stops with NEEDS YOU and exit code 3 on a risky fix without a terminal, then --resume --approve carries on', async () => {
    const root = await deadApp(expressMongoApp);
    // Inside a fresh directory, so the fix cache next to it starts empty.
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const written = () => stderr.mock.calls.map((c) => String(c[0])).join('');
    const cli = (sandbox: FakeSandbox, ...args: string[]) =>
      createProgram({ sandbox, prompt: null }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '--no-llm', '-q', ...args]);

    await cli(new FakeSandbox({ install: [{ ok: false, log: NODE_GYP_LOG }] }));
    expect(process.exitCode).toBe(3);
    expect(written()).toContain('NEEDS YOU: apply this fix?');
    expect(written()).toContain('  - installs Debian packages: python, make, g++');
    expect(written()).toContain(`necromancer resurrect ${root} --resume --reports ${reports} --approve`);
    expect((await new ReportStore(reports).load(path.basename(root)))?.resurrect?.outcome).toBe('needs-you');

    await expect(cli(new FakeSandbox({}), '--resume')).rejects.toThrow(/waiting for your OK on a fix; pass --approve or --reject/);
    await expect(cli(new FakeSandbox({}), '--approve')).rejects.toThrow(/go with --resume/);

    process.exitCode = undefined;
    await cli(new FakeSandbox({}), '--resume', '--approve');
    expect(process.exitCode).toBeUndefined();
    expect(written()).toContain('RESURRECTED on node:6 after 2 attempt(s)');
    const report = (await new ReportStore(reports).load(path.basename(root)))!.resurrect!;
    expect(report.outcome).toBe('resurrected');
    expect(report.decisions).toMatchObject([{ kind: 'approval', subject: 'node-gyp-python', answer: 'approved' }]);
    await expect(cli(new FakeSandbox({}), '--resume', '--approve')).rejects.toThrow(/not waiting on you \(it ended resurrected\)/);
  });

  it('asks about risky fixes on a terminal', async () => {
    const root = await deadApp(expressMongoApp);
    // Inside a fresh directory, so the fix cache next to it starts empty.
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const asked: string[] = [];
    const replies = ['maybe', 'y'];
    const prompt = async (q: string) => (asked.push(q), replies.shift()!);
    await createProgram({ sandbox: new FakeSandbox({ install: [{ ok: false, log: NODE_GYP_LOG }] }), prompt }).parseAsync([
      'node', 'necromancer', 'resurrect', root, '--reports', reports, '--no-llm', '-q',
    ]);
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatch(/^Apply it\? \[y\]es/);
    expect(written).toContain("Attempt 1 failed at install: gyp ERR! stack Error: Can't find Python");
    expect(written).toContain('Please answer y, n or p.');
    expect(written).toContain('RESURRECTED');
    expect(process.exitCode).toBeUndefined();
  });

  it('pauses on a question, then --resume --answer passes the answer on', async () => {
    const root = await deadApp(expressMongoApp);
    // Inside a fresh directory, so the fix cache next to it starts empty.
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const written = () => stderr.mock.calls.map((c) => String(c[0])).join('');
    const cli = (sandbox: FakeSandbox, model: ScriptedModel, ...args: string[]) =>
      createProgram({ sandbox, model, prompt: null }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '-q', ...args]);

    await cli(new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }), new ScriptedModel(question));
    expect(process.exitCode).toBe(3);
    expect(written()).toContain('NEEDS YOU: Is there a public replacement for @acme/core?\n');
    expect(written()).toContain('  1. stub it\n  2. drop the feature\n');
    expect(written()).toContain(`necromancer resurrect ${root} --resume --reports ${reports} --answer "…"`);

    await expect(cli(new FakeSandbox({}), new ScriptedModel(), '--resume', '--approve')).rejects.toThrow(/waiting on a question/);
    process.exitCode = undefined;
    const model = new ScriptedModel(setEnv);
    await cli(new FakeSandbox({}), model, '--resume', '--answer', 'stub it');
    expect(process.exitCode).toBeUndefined();
    expect(model.requests[0]!.prompt).toContain('The owner answered your question: stub it');
    expect((await new ReportStore(reports).load(path.basename(root)))!.resurrect!.outcome).toBe('resurrected');
  });
});
