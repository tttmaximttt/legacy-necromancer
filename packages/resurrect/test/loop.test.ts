import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlmError, ScriptedModel, type StructuredModel, type StructuredRequest, type StructuredResult } from '@necromancer/llm';
import { FixCache, resurrect, type FixProposal } from '@necromancer/resurrect';
import { deadApp, expressMongoApp, FakeSandbox, NODE_GYP_LOG } from './helpers.js';

const UNKNOWN = 'Error: Cannot find module \'./config/local.json\'\n    at Function.Module._resolveFilename (module.js:470:15)';

const fix = (ops: FixProposal['ops'], diagnosis = 'config file is gitignored'): FixProposal => ({ diagnosis, decision: 'fix', ops, blockedReason: null, question: null, choices: [] });

/** Like ScriptedModel, but reports token usage so the budget can be tested. */
class MeteredModel implements StructuredModel {
  readonly name = 'metered';
  calls = 0;
  constructor(private readonly answer: (n: number) => FixProposal, private readonly tokensPerCall: number) {}
  async generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const output = request.schema.parse(this.answer(this.calls++));
    return { output, model: this.name, fellBack: false, usage: { inputTokens: this.tokensPerCall - 100, outputTokens: 100 } };
  }
}

describe('resurrect loop', () => {
  it('fixes a known failure from the table, then boots the app with its era database', async () => {
    const root = await deadApp(expressMongoApp);
    const sandbox = new FakeSandbox({ install: [{ ok: false, log: NODE_GYP_LOG }] });
    const model = new ScriptedModel();
    const report = await resurrect(root, { sandbox, model });

    expect(report.outcome).toBe('resurrected');
    expect(report.health).toEqual({ kind: 'port', detail: 'port answered' });
    expect(report.era).toMatchObject({ date: '2017-09-01', node: 'node:6' });
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts[0]).toMatchObject({ phase: 'install', ok: false, fix: { source: 'known', id: 'node-gyp-python' } });
    expect(report.attempts[0]!.errorExcerpt).toContain("Can't find Python");
    expect(model.requests).toHaveLength(0);
    expect(report.llm).toMatchObject({ calls: 0, tokens: 0 });

    expect(sandbox.dockerfiles[0]).toContain('FROM node:6');
    expect(sandbox.dockerfiles[0]).not.toContain('apt-get');
    expect(sandbox.dockerfiles[1]).toContain('apt-get install -y --no-install-recommends python make g++');
    const boot = sandbox.calls.find((c) => c.step === 'boot')!;
    expect(boot.boot).toMatchObject({
      command: 'npm start',
      port: 3000,
      env: { MONGO_URL: 'mongodb://localhost:27017/app', PORT: '3000' },
      services: [{ image: 'mongo:3.4', port: 27017 }],
    });
    expect(sandbox.cleaned).toBe(1);
    expect(report.compose).toContain('mongo:3.4');
  });

  it('asks the model when nothing in the table matches, and caches what worked', async () => {
    const root = await deadApp(expressMongoApp);
    const cacheFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cache-')), 'fix-cache.json');
    const ops: FixProposal['ops'] = [{ op: 'runBeforeInstall', command: 'echo {} > config.json' }];
    const model = new ScriptedModel(fix(ops));
    const sandbox = new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] });
    const report = await resurrect(root, { sandbox, model, fixCache: new FixCache(cacheFile) });

    expect(report.outcome).toBe('resurrected');
    expect(report.attempts[0]!.fix).toMatchObject({ source: 'llm', ops });
    const prompt = model.requests[0]!.prompt;
    expect(prompt).toContain('Failed step: boot');
    expect(prompt).toContain("Cannot find module './config/local.json'");
    expect(prompt).toContain('"nodeImage": "node:6"');
    expect(report.llm).toMatchObject({ model: 'scripted', calls: 1 });

    // Same failure in another repo: the cache answers, the model isn't asked.
    const again = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model: new ScriptedModel(),
      fixCache: new FixCache(cacheFile),
    });
    expect(again.outcome).toBe('resurrected');
    expect(again.attempts[0]!.fix).toMatchObject({ source: 'cache', ops });
  });

  it('runs the build script with no network, and boots the built image', async () => {
    const root = await deadApp({
      'package.json': JSON.stringify({ name: 'spa', scripts: { build: 'gulp build', start: 'node server.js' } }),
      'server.js': 'require("http").createServer().listen(8080)',
    });
    const sandbox = new FakeSandbox({});
    const report = await resurrect(root, { sandbox, model: null });
    expect(report.outcome).toBe('resurrected');
    const run = sandbox.calls.find((c) => c.step === 'run')!;
    expect(run).toMatchObject({ command: 'npm run build', image: expect.stringMatching(/:attempt-1$/), outTag: expect.stringMatching(/:attempt-1-built$/) });
    expect(sandbox.calls.find((c) => c.step === 'boot')!.image).toBe(run.outTag);
  });

  it('loads a library instead of booting it', async () => {
    const root = await deadApp({ 'package.json': JSON.stringify({ name: 'lib', main: 'index.js' }), 'index.js': 'module.exports = 1' });
    const sandbox = new FakeSandbox({});
    const report = await resurrect(root, { sandbox, model: null });
    expect(report.health).toMatchObject({ kind: 'library' });
    expect(sandbox.calls.map((c) => c.step)).toEqual(['install', 'run']);
    expect(sandbox.calls[1]!.command).toBe(`node -e "require('./')"`);
  });

  it('applies sandbox limits to every step', async () => {
    const root = await deadApp(expressMongoApp);
    const sandbox = new FakeSandbox({});
    const report = await resurrect(root, { sandbox, limits: { memoryMb: 1024, stepTimeoutSec: 60 } });
    expect(report.limits).toEqual({ cpus: 2, memoryMb: 1024, pids: 512, stepTimeoutSec: 60 });
    expect(sandbox.calls.find((c) => c.step === 'install')!.limits).toEqual(report.limits);
    expect(sandbox.calls.find((c) => c.step === 'boot')!.boot!.limits).toEqual(report.limits);
  });

  describe('BLOCKED', () => {
    it('when nothing matches and there is no model', async () => {
      const report = await resurrect(await deadApp(expressMongoApp), { sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }), model: null });
      expect(report.outcome).toBe('blocked');
      expect(report.blockedReason).toBe("boot failed and no known fix matches (no model configured): Error: Cannot find module './config/local.json'");
    });

    it('when the model says nothing anyone could say would fix it', async () => {
      const model = new ScriptedModel({
        diagnosis: 'the build calls phantomjs',
        decision: 'blocked',
        ops: [],
        blockedReason: 'needs phantomjs, which is no longer distributed',
        question: null,
        choices: [],
      });
      const report = await resurrect(await deadApp(expressMongoApp), { sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }), model });
      expect(report.outcome).toBe('blocked');
      expect(report.blockedReason).toBe('needs phantomjs, which is no longer distributed');
      expect(report.pending).toBeNull();
    });

    it('when the model call fails', async () => {
      const model = new ScriptedModel(new LlmError('credentials', 'no key'));
      const report = await resurrect(await deadApp(expressMongoApp), { sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }), model });
      expect(report.blockedReason).toMatch(/^could not ask scripted for a fix \(no key\)/);
    });

    it('after the maximum number of attempts', async () => {
      let i = 0;
      const model = new MeteredModel(() => fix([{ op: 'setEnv', name: `TRY_${i++}`, value: '1' }]), 1000);
      const boots = Array.from({ length: 5 }, (_, n) => ({ ok: false, log: `Error: failure number ${'x'.repeat(n + 1)}` }));
      const report = await resurrect(await deadApp(expressMongoApp), { sandbox: new FakeSandbox({ boot: boots }), model, maxIterations: 4 });
      expect(report.attempts).toHaveLength(4);
      expect(report.blockedReason).toMatch(/^still failing after 4 attempts; last error at boot: Error: failure number xxxx$/);
      expect(report.llm).toMatchObject({ calls: 3, tokens: 3000 });
    });

    it('when the token budget is spent', async () => {
      let i = 0;
      const model = new MeteredModel(() => fix([{ op: 'setEnv', name: `TRY_${i++}`, value: '1' }]), 6000);
      const boots = Array.from({ length: 5 }, (_, n) => ({ ok: false, log: `Error: failure ${'y'.repeat(n + 1)}` }));
      const report = await resurrect(await deadApp(expressMongoApp), { sandbox: new FakeSandbox({ boot: boots }), model, tokenBudget: 10_000 });
      expect(model.calls).toBe(2);
      expect(report.blockedReason).toMatch(/^token budget of 10000 spent; last error at boot: Error: failure yyy$/);
    });

    it('when the same error keeps coming back', async () => {
      let i = 0;
      const model = new MeteredModel(() => fix([{ op: 'setEnv', name: `TRY_${i++}`, value: '1' }]), 10);
      const report = await resurrect(await deadApp(expressMongoApp), {
        sandbox: new FakeSandbox({ boot: Array.from({ length: 6 }, () => ({ ok: false, log: UNKNOWN })) }),
        model,
      });
      expect(report.attempts).toHaveLength(3);
      expect(report.blockedReason).toMatch(/^the same boot error came back after 2 fixes/);
    });

    it('when there is no package.json', async () => {
      const sandbox = new FakeSandbox({});
      const report = await resurrect(await deadApp({ 'README.md': '# old' }), { sandbox });
      expect(report.blockedReason).toMatch(/no package.json/);
      expect(sandbox.calls).toHaveLength(0);
    });
  });

  it('stops for the owner when the model asks a question', async () => {
    const model = new ScriptedModel({
      diagnosis: 'needs @acme/* packages',
      decision: 'ask',
      ops: [],
      blockedReason: null,
      question: 'Is there a public replacement for @acme/core?',
      choices: ['stub it', 'drop it'],
    });
    const sandbox = new FakeSandbox({ install: [{ ok: false, log: 'npm ERR! 404 Not Found: @acme/core@1.2.0' }] });
    const report = await resurrect(await deadApp(expressMongoApp), { sandbox, model });
    expect(report.outcome).toBe('needs-you');
    expect(report.blockedReason).toBeNull();
    expect(report.pending).toEqual({
      kind: 'question',
      question: 'Is there a public replacement for @acme/core?',
      context: 'needs @acme/* packages Failing line: npm ERR! 404 Not Found: @acme/core@1.2.0',
      choices: ['stub it', 'drop it'],
    });
    expect(sandbox.cleaned).toBe(1);
  });

  it('re-asks once when the model proposes something the sandbox rejects', async () => {
    const model = new ScriptedModel(fix([{ op: 'setNodeImage', tag: 'attacker/miner' }]), fix([{ op: 'setEnv', name: 'CONFIG', value: 'local' }]));
    const report = await resurrect(await deadApp(expressMongoApp), { sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }), model });
    expect(report.outcome).toBe('resurrected');
    expect(report.warnings).toEqual(['attempt 1: rejected a proposed fix (rejected setNodeImage: "attacker/miner" is not an official node image tag)']);
    expect(model.requests[1]!.prompt).toContain('Your previous proposal was rejected');
    expect(report.recipe.nodeImage).toBe('node:6');
  });

  it('uses the interview’s intent and goals when asking for fixes', async () => {
    const model = new ScriptedModel(fix([{ op: 'setEnv', name: 'CONFIG', value: 'local' }]));
    await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model,
      interview: { intent: 'A notes API', goals: [{ text: 'Keep the REST API identical', origin: 'user' }] } as never,
    });
    expect(model.requests[0]!.prompt).toContain("Owner's goals: Keep the REST API identical");
  });
});
