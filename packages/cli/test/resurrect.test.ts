import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportStore } from '@necromancer/core';
import { PassThrough } from 'node:stream';
import { createProgram } from '../src/index.js';
import { InputClosed, terminalIo } from '../src/interview.js';
import { ScriptedModel } from '@necromancer/llm';
import { DEFAULT_LIMITS, errorSignature, resurrect } from '@necromancer/resurrect';
import { deadApp, expressMongoApp, FakeSandbox, NODE_GYP_LOG } from '../../resurrect/test/helpers.js';

// The real resurrect, wrapped so a test can see the options the CLI passed.
vi.mock('@necromancer/resurrect', async (importOriginal) => {
  const original = await importOriginal<typeof import('@necromancer/resurrect')>();
  return { ...original, resurrect: vi.fn(original.resurrect) };
});

const PRIVATE = 'npm ERR! 404 Not Found: @acme/core@1.2.0';
const question = {
  diagnosis: '@acme/core is not on the public registry',
  decision: 'ask',
  ops: [],
  blockedReason: null,
  question: 'Is there a public replacement for @acme/core?',
  choices: ['stub it', 'drop the feature'],
};
const UNKNOWN = "Error: Cannot find module './config/local.json'\n    at Function.Module._resolveFilename (module.js:470:15)";
const CACHE_FIX = `cache:${errorSignature('boot', UNKNOWN)}`;

/**
 * A sandbox whose first boot fails with UNKNOWN, after seeding the fix cache the CLI keeps next to `reports` with a
 * risky fix for it: known fixes apply without asking, but a cached one waits for the owner.
 */
function pausing(reports: string): FakeSandbox {
  mkdirSync(path.dirname(reports), { recursive: true });
  const fix = { description: 'add the config package', ops: [{ op: 'setDependency', name: 'config', version: '^1.0.0' }], hits: 1 };
  writeFileSync(path.join(path.dirname(reports), 'fix-cache.json'), JSON.stringify({ [errorSignature('boot', UNKNOWN)]: fix }));
  return new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] });
}

const setEnv = { diagnosis: 'stub the private package', decision: 'fix', ops: [{ op: 'setEnv', name: 'CI', value: 'true' }], blockedReason: null, question: null, choices: [] };

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
    // Inside a fresh directory, so the fix cache next to it holds only what pausing() puts there.
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const written = () => stderr.mock.calls.map((c) => String(c[0])).join('');
    const cli = (sandbox: FakeSandbox, ...args: string[]) =>
      createProgram({ sandbox, prompt: null }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '--no-llm', '-q', ...args]);

    await cli(pausing(reports));
    expect(process.exitCode).toBe(3);
    expect(written()).toContain('NEEDS YOU: apply this fix?');
    expect(written()).toContain('  - changes package.json: sets config to ^1.0.0');
    expect(written()).toContain(`necromancer resurrect ${root} --resume --reports ${reports} --approve`);
    expect((await new ReportStore(reports).load(path.basename(root)))?.resurrect?.outcome).toBe('needs-you');

    // No terminal and no answer: still waiting, so NEEDS YOU and exit 3 again rather than an error.
    stderr.mockClear();
    process.exitCode = undefined;
    await cli(new FakeSandbox({}), '--resume');
    expect(process.exitCode).toBe(3);
    expect(written()).toContain('NEEDS YOU: apply this fix?');
    expect(written()).toContain(`necromancer resurrect ${root} --resume --reports ${reports} --approve`);
    expect((await new ReportStore(reports).load(path.basename(root)))?.resurrect?.outcome).toBe('needs-you');
    await expect(cli(new FakeSandbox({}), '--approve')).rejects.toThrow(/go with --resume/);

    process.exitCode = undefined;
    await cli(new FakeSandbox({}), '--resume', '--approve');
    expect(process.exitCode).toBeUndefined();
    expect(written()).toContain('RESURRECTED on node:6 after 2 attempt(s)');
    const report = (await new ReportStore(reports).load(path.basename(root)))!.resurrect!;
    expect(report.outcome).toBe('resurrected');
    expect(report.decisions).toMatchObject([{ kind: 'approval', subject: CACHE_FIX, answer: 'approved' }]);
    await expect(cli(new FakeSandbox({}), '--resume', '--approve')).rejects.toThrow(/this one ended resurrected \(`necromancer resurrect .* without --resume starts a new run\)/);
  });

  it('never answers the pending fix with --yes on --resume: --reject wins, and without --approve or --reject it asks or stays paused', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cli = (sandbox: FakeSandbox, prompt: ((q: string) => Promise<string>) | null, ...args: string[]) =>
      createProgram({ sandbox, prompt }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '--no-llm', '-q', ...args]);
    const pause = () => cli(pausing(reports), null);
    const lastResume = () => vi.mocked(resurrect).mock.calls.at(-1)![1].resume!;

    await pause();
    expect(process.exitCode).toBe(3);
    await cli(pausing(reports), null, '--resume', '--reject', '--yes');
    expect(lastResume().approve).toBe(false);
    expect((await new ReportStore(reports).load(path.basename(root)))!.resurrect!.decisions).toMatchObject([{ subject: CACHE_FIX, answer: 'rejected' }]);

    // No terminal: --yes alone leaves the run paused.
    await pause();
    const calls = vi.mocked(resurrect).mock.calls.length;
    stderr.mockClear();
    process.exitCode = undefined;
    await cli(new FakeSandbox({}), null, '--resume', '--yes');
    expect(process.exitCode).toBe(3);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('NEEDS YOU: apply this fix?');
    expect(vi.mocked(resurrect).mock.calls.length).toBe(calls);

    // On a terminal: --yes alone still asks.
    const asked: string[] = [];
    process.exitCode = undefined;
    await cli(new FakeSandbox({}), async (q) => (asked.push(q), 'n'), '--resume', '--yes');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Apply it\? \[y\]es/);
    expect(lastResume().approve).toBe(false);
  });

  it('applies a risky cached fix with --yes and records it as approved automatically', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await createProgram({ sandbox: pausing(reports), prompt: null }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '--no-llm', '-q', '--yes']);
    expect(process.exitCode).toBeUndefined();
    const report = (await new ReportStore(reports).load(path.basename(root)))!.resurrect!;
    expect(report.outcome).toBe('resurrected');
    expect(report.decisions).toMatchObject([{ kind: 'approval', subject: CACHE_FIX, answer: 'approved', by: 'auto' }]);
  });

  it('pauses and saves the run when the input ends at the prompt (Ctrl-D)', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    /** A terminal whose input has already ended. */
    const ended = () => {
      const input = new PassThrough();
      input.end();
      return terminalIo({ input, output: new PassThrough() }).ask!;
    };
    const cli = (sandbox: FakeSandbox, ...args: string[]) =>
      createProgram({ sandbox, prompt: ended() }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '--no-llm', '-q', ...args]);

    await cli(pausing(reports));
    expect(process.exitCode).toBe(3);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('NEEDS YOU: apply this fix?');
    expect((await new ReportStore(reports).load(path.basename(root)))!.resurrect!.outcome).toBe('needs-you');
    // On --resume too: still waiting, so NEEDS YOU and exit 3 again rather than an error.
    process.exitCode = undefined;
    await cli(new FakeSandbox({}), '--resume');
    expect(process.exitCode).toBe(3);
    expect((await new ReportStore(reports).load(path.basename(root)))!.resurrect!.outcome).toBe('needs-you');
  });

  it('rejects a question, and every later one, with InputClosed once the input ends', async () => {
    const input = new PassThrough();
    const ask = terminalIo({ input, output: new PassThrough() }).ask!;
    const pending = ask('first? ');
    input.end();
    await expect(pending).rejects.toBeInstanceOf(InputClosed);
    await expect(ask('second? ')).rejects.toBeInstanceOf(InputClosed);
  });

  it('asks about risky fixes on a terminal', async () => {
    const root = await deadApp(expressMongoApp);
    // Inside a fresh directory, so the fix cache next to it holds only what pausing() puts there.
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const asked: string[] = [];
    const replies = ['maybe', 'y'];
    const prompt = async (q: string) => (asked.push(q), replies.shift()!);
    await createProgram({ sandbox: pausing(reports), prompt }).parseAsync([
      'node', 'necromancer', 'resurrect', root, '--reports', reports, '--no-llm', '-q',
    ]);
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatch(/^Apply it\? \[y\]es/);
    expect(written).toContain("Attempt 1 failed at boot: Error: Cannot find module './config/local.json'");
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

  it('maps a numeric --answer to the numbered choice, as the prompt does', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cli = (sandbox: FakeSandbox, model: ScriptedModel, ...args: string[]) =>
      createProgram({ sandbox, model, prompt: null }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '-q', ...args]);
    const pause = () => cli(new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }), new ScriptedModel(question));
    const lastResume = () => vi.mocked(resurrect).mock.calls.at(-1)![1].resume!;

    await pause();
    const model = new ScriptedModel(setEnv);
    await cli(new FakeSandbox({}), model, '--resume', '--answer', '2');
    expect(lastResume().answer).toBe('drop the feature');
    expect(model.requests[0]!.prompt).toContain('The owner answered your question: drop the feature');
    // A number with no choice of its own is the answer as typed.
    await pause();
    await cli(new FakeSandbox({}), new ScriptedModel(setEnv), '--resume', '--answer', '3');
    expect(lastResume().answer).toBe('3');
    // Only plain digits are a choice number.
    await pause();
    await cli(new FakeSandbox({}), new ScriptedModel(setEnv), '--resume', '--answer', '1.0');
    expect(lastResume().answer).toBe('1.0');
  });

  it('checks Docker before asking on --resume, and says how to pass the answer again when the run fails before using it', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await createProgram({ sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }), model: new ScriptedModel(question), prompt: null }).parseAsync([
      'node', 'necromancer', 'resurrect', root, '--reports', reports, '-q',
    ]);
    expect(process.exitCode).toBe(3);
    const asked: string[] = [];
    const prompt = async (q: string) => (asked.push(q), '1');
    const out = path.join(path.dirname(reports), 'out');
    const resume = (sandbox: FakeSandbox) =>
      createProgram({ sandbox, model: new ScriptedModel(setEnv), prompt }).parseAsync([
        'node', 'necromancer', 'resurrect', root, '--reports', reports, '-q', '--resume', '-n', '6', '--yes', '--out-dir', out,
      ]);

    const down = Object.assign(new FakeSandbox({}), { ping: async () => Promise.reject(new Error('Docker is not reachable')) });
    await expect(resume(down)).rejects.toThrow('Docker is not reachable');
    expect(asked).toEqual([]);

    // The repo is gone, so the checkout fails after the owner answered: the error carries the answer on, with every
    // flag typed that changes the resumed run.
    await rm(root, { recursive: true, force: true });
    await expect(resume(new FakeSandbox({}))).rejects.toThrow(
      new RegExp(`could not clone[^]*\\nTo carry on with your answer:\\n  necromancer resurrect ${root} --resume --reports ${reports} -n 6 --yes -q --out-dir ${out} --answer 'stub it'$`),
    );
    expect(asked).toHaveLength(1);
    expect((await new ReportStore(reports).load(path.basename(root)))!.resurrect!.outcome).toBe('needs-you');
  });

  it('keeps the paused run\'s limits on --resume unless -n or --token-budget is given again', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cli = (sandbox: FakeSandbox, ...args: string[]) =>
      createProgram({ sandbox, prompt: null }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '--no-llm', '-q', ...args]);
    const lastResume = () => vi.mocked(resurrect).mock.calls.at(-1)![1].resume!;

    await cli(pausing(reports), '-n', '4', '--token-budget', '1000');
    expect(process.exitCode).toBe(3);
    await cli(new FakeSandbox({}), '--resume', '--approve');
    expect(lastResume()).toMatchObject({ approve: true, run: { settings: { maxIterations: 4, tokenBudget: 1000 } } });
    // A resume runs on the paused run's settings, so none of the fresh-run options is passed.
    expect(Object.keys(vi.mocked(resurrect).mock.calls.at(-1)![1]).sort()).toEqual(['approve', 'ask', 'fixCache', 'model', 'onProgress', 'resume', 'sandbox']);

    await cli(pausing(reports));
    await cli(new FakeSandbox({}), '--resume', '--approve', '-n', '6', '--token-budget', '2000');
    expect(lastResume()).toMatchObject({ approve: true, run: { settings: { maxIterations: 6, tokenBudget: 2000 } } });
  });

  it('builds the model the paused run used on --resume, unless --no-llm or -m is given again', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cli = (sandbox: FakeSandbox, ...args: string[]) =>
      createProgram({ sandbox, model: new ScriptedModel(), prompt: null }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '-q', ...args]);
    const last = () => vi.mocked(resurrect).mock.calls.at(-1)![1];
    const pause = (...args: string[]) => cli(pausing(reports), ...args);

    // A paused run without a model resumes without one, even with a budget, until a model is named.
    await pause('--token-budget', '0');
    expect(process.exitCode).toBe(3);
    await cli(new FakeSandbox({}), '--resume', '--approve');
    expect(last().model).toBeNull();
    await pause('--token-budget', '0');
    await cli(new FakeSandbox({}), '--resume', '--approve', '--token-budget', '1000');
    expect(last().model).toBeNull();
    await pause('--token-budget', '0');
    await cli(new FakeSandbox({}), '--resume', '--approve', '--token-budget', '1000', '-m', 'scripted');
    expect(last().model).toBeInstanceOf(ScriptedModel);
    expect(last().resume!.run.settings).toMatchObject({ tokenBudget: 1000, model: 'scripted' });

    // A paused run with a model gets it back without -m, and --no-llm turns it off.
    await pause();
    await cli(new FakeSandbox({}), '--resume', '--approve');
    expect(last().model).toBeInstanceOf(ScriptedModel);
    expect(last().resume!.run.settings.model).toBe(new ScriptedModel().name);
    await pause();
    await cli(new FakeSandbox({}), '--resume', '--approve', '--no-llm');
    expect(last().model).toBeNull();
    expect(last().resume!.run.settings.model).toBeNull();
  });

  it('keeps the paused run\'s --keep-images and --workdir on --resume unless given again', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'necro-cli-wd-'));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cli = (sandbox: FakeSandbox, ...args: string[]) =>
      createProgram({ sandbox, prompt: null }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '-q', '--no-llm', ...args]);
    const lastResume = () => vi.mocked(resurrect).mock.calls.at(-1)![1].resume!;
    const pause = () => cli(pausing(reports), '--keep-images', '--workdir', workdir);

    await pause();
    expect((await new ReportStore(reports).load(path.basename(root)))!.resurrect!.resume!.settings).toMatchObject({ keepImages: true, workdir });
    await cli(new FakeSandbox({}), '--resume', '--approve');
    expect(lastResume()).toMatchObject({ approve: true, run: { settings: { keepImages: true, workdir } } });
    await pause();
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'necro-cli-wd-'));
    await cli(new FakeSandbox({}), '--resume', '--approve', '--no-keep-images', '--workdir', path.relative(process.cwd(), elsewhere));
    expect(lastResume().run.settings).toMatchObject({ keepImages: false, workdir: elsewhere });
  });

  it('checks the saved run can be resumed before asking anything', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await createProgram({ sandbox: pausing(reports), prompt: null }).parseAsync([
      'node', 'necromancer', 'resurrect', root, '--reports', reports, '--no-llm', '-q',
    ]);
    const store = new ReportStore(reports);
    const { resume: _state, ...broken } = (await store.load(path.basename(root)))!.resurrect!;
    await store.save('resurrect', broken);

    const asked: string[] = [];
    const prompt = async (q: string) => (asked.push(q), 'y');
    await expect(
      createProgram({ sandbox: new FakeSandbox({}), prompt }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '--no-llm', '-q', '--resume']),
    ).rejects.toThrow(/the saved run is waiting on the owner but is missing the state it needs to carry on; start a new run instead \(`necromancer/);
    expect(asked).toEqual([]);
  });

  it('keeps the paused run\'s sandbox limits on --resume unless --cpus, --memory or --step-timeout is given again', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cli = (sandbox: FakeSandbox, ...args: string[]) =>
      createProgram({ sandbox, prompt: null }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '--no-llm', '-q', ...args]);
    const lastResume = () => vi.mocked(resurrect).mock.calls.at(-1)![1].resume!;
    const saved = async () => (await new ReportStore(reports).load(path.basename(root)))!.resurrect!;
    const pause = () => cli(pausing(reports), '--memory', '1024', '--step-timeout', '120', '--cpus', '2');

    await pause();
    expect(process.exitCode).toBe(3);
    await cli(new FakeSandbox({}), '--resume', '--approve');
    expect(lastResume().run.settings.limits).toEqual({ cpus: 2, memoryMb: 1024, pids: DEFAULT_LIMITS.pids, stepTimeoutSec: 120 });
    expect(await saved()).toMatchObject({ outcome: 'resurrected', limits: { cpus: 2, memoryMb: 1024, stepTimeoutSec: 120 } });

    await pause();
    await cli(new FakeSandbox({}), '--resume', '--approve', '--memory', '2048');
    expect(lastResume().run.settings.limits).toEqual({ cpus: 2, memoryMb: 2048, pids: DEFAULT_LIMITS.pids, stepTimeoutSec: 120 });
    expect(await saved()).toMatchObject({ outcome: 'resurrected', limits: { cpus: 2, memoryMb: 2048, stepTimeoutSec: 120 } });
  });

  it('rebuilds the paused run\'s sandbox on --resume, and takes a new --ca-file there', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await createProgram({ sandbox: pausing(reports), prompt: null }).parseAsync([
      'node', 'necromancer', 'resurrect', root, '--reports', reports, '--no-llm', '-q',
    ]);
    const store = new ReportStore(reports);
    const paused = (await store.load(path.basename(root)))!.resurrect!;
    await store.save('resurrect', { ...paused, resume: { ...paused.resume!, settings: { ...paused.resume!.settings, sandbox: { buildProxy: true, healthTimeoutSec: 30 } } } });

    // No injected sandbox, so the CLI builds a DockerSandbox; resurrect itself is stubbed so Docker is never reached.
    const resumeWith = async (...args: string[]) => {
      vi.mocked(resurrect).mockResolvedValueOnce(paused);
      await createProgram({ prompt: null }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '--no-llm', '-q', '--resume', '--approve', ...args]);
      return vi.mocked(resurrect).mock.calls.at(-1)![1].sandbox.settings;
    };
    expect(await resumeWith()).toEqual({ buildProxy: true, healthTimeoutSec: 30 });
    await store.save('resurrect', { ...paused, resume: { ...paused.resume!, settings: { ...paused.resume!.settings, sandbox: { buildProxy: true, healthTimeoutSec: 30 } } } });
    expect(await resumeWith('--health-timeout', '45')).toEqual({ buildProxy: true, healthTimeoutSec: 45 });
    expect(vi.mocked(resurrect).mock.calls.at(-1)![1].resume!.run.settings.sandbox).toEqual({ buildProxy: true, healthTimeoutSec: 45 });
    await store.save('resurrect', { ...paused, resume: { ...paused.resume!, settings: { ...paused.resume!.settings, sandbox: { buildProxy: true, healthTimeoutSec: 30 } } } });
    expect(await resumeWith('--no-build-proxy')).toEqual({ buildProxy: false, healthTimeoutSec: 30 });
    expect(vi.mocked(resurrect).mock.calls.at(-1)![1].resume!.run.settings.sandbox).toEqual({ buildProxy: false, healthTimeoutSec: 30 });
    // A paused run that saved no sandbox settings resumes on the defaults, changed by what is typed again.
    await store.save('resurrect', { ...paused, resume: { ...paused.resume!, settings: { ...paused.resume!.settings, sandbox: null } } });
    expect(await resumeWith('--build-proxy')).toEqual({ buildProxy: true, healthTimeoutSec: 90 });


    // The saved CA file may have moved: --ca-file replaces it, made absolute as on a fresh run.
    await resumeWith('--ca-file', 'ca.pem');
    expect(vi.mocked(resurrect).mock.calls.at(-1)![1].resume!.run.settings.caFile).toBe(path.resolve('ca.pem'));
    await store.save('resurrect', { ...paused, resume: { ...paused.resume!, settings: { ...paused.resume!.settings, caFile: '/old/ca.pem' } } });
    await resumeWith();
    expect(vi.mocked(resurrect).mock.calls.at(-1)![1].resume!.run.settings.caFile).toBe('/old/ca.pem');
  });

  it('does not ask a pending question that no model could act on', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await createProgram({ sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }), model: new ScriptedModel(question), prompt: null }).parseAsync([
      'node', 'necromancer', 'resurrect', root, '--reports', reports, '-q',
    ]);
    expect(process.exitCode).toBe(3);

    const asked: string[] = [];
    const prompt = async (q: string) => (asked.push(q), 'stub it');
    await expect(
      createProgram({ sandbox: new FakeSandbox({}), prompt }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '--no-llm', '-q', '--resume']),
    ).rejects.toThrow(/needs a model.*; drop --no-llm, or pass -m /);
    await expect(
      createProgram({ sandbox: new FakeSandbox({}), model: new ScriptedModel(), prompt }).parseAsync([
        'node', 'necromancer', 'resurrect', root, '--reports', reports, '-q', '--resume', '--token-budget', '0',
      ]),
    ).rejects.toThrow(/token budget of 0 is already spent.*; pass a larger --token-budget$/);
    expect(asked).toEqual([]);
  });

  it('says to add a key, or pass --no-llm, when the paused run used a model and there is no key', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await createProgram({ sandbox: pausing(reports), model: new ScriptedModel(), prompt: null }).parseAsync([
      'node', 'necromancer', 'resurrect', root, '--reports', reports, '-q',
    ]);
    expect(process.exitCode).toBe(3);
    // No injected model and no key in the test environment.
    const cli = (...args: string[]) =>
      createProgram({ sandbox: new FakeSandbox({}), prompt: null }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '-q', '--resume', '--approve', ...args]);
    await expect(cli()).rejects.toThrow(/asks scripted for fixes, but was handed no model.*; to add an Anthropic API key, .*, or pass --no-llm to carry on with known and cached fixes only$/);
    await cli('--no-llm');
    expect(vi.mocked(resurrect).mock.calls.at(-1)![1].model).toBeNull();
  });

  it('hints at the flag that gets past each refused resume', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await createProgram({ sandbox: pausing(reports), model: new ScriptedModel(), prompt: null }).parseAsync([
      'node', 'necromancer', 'resurrect', root, '--reports', reports, '-q',
    ]);
    expect(process.exitCode).toBe(3);
    const cli = (...args: string[]) =>
      createProgram({ sandbox: new FakeSandbox({}), model: new ScriptedModel(), prompt: null }).parseAsync([
        'node', 'necromancer', 'resurrect', root, '--reports', reports, '-q', '--resume', '--approve', ...args,
      ]);
    await expect(cli('-m', 'other', '--token-budget', '0')).rejects.toThrow(/token budget is 0.*; pass a larger --token-budget, or drop -m$/);
    // The injected model is named scripted, so naming another is a mismatch.
    await expect(cli('-m', 'other')).rejects.toThrow(/handed the model scripted.*; pass -m other \(or another model\)$/);
  });

  it('prints NEEDS YOU and exits 3 when a question is pending and there is no terminal or --answer', async () => {
    const root = await deadApp(expressMongoApp);
    const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-res-')), 'reports');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cli = (sandbox: FakeSandbox, ...args: string[]) =>
      createProgram({ sandbox, model: new ScriptedModel(question), prompt: null }).parseAsync(['node', 'necromancer', 'resurrect', root, '--reports', reports, '-q', ...args]);
    await cli(new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }));
    stderr.mockClear();
    process.exitCode = undefined;
    await cli(new FakeSandbox({}), '--resume');
    expect(process.exitCode).toBe(3);
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('NEEDS YOU: Is there a public replacement for @acme/core?');
    expect(written).toContain(`necromancer resurrect ${root} --resume --reports ${reports} --answer "…"`);

    // A blank --answer is a mistake, not "still waiting": an error rather than exit 3, so a script cannot loop on it.
    for (const blank of ['', '   ']) {
      process.exitCode = undefined;
      await expect(cli(new FakeSandbox({}), '--resume', '--answer', blank)).rejects.toThrow('--answer is empty');
      expect(process.exitCode).toBeUndefined();
    }
    expect((await new ReportStore(reports).load(path.basename(root)))!.resurrect!.outcome).toBe('needs-you');
  });
});
