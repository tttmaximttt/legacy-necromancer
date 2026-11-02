import { describe, expect, it } from 'vitest';
import type { BuildRecipe } from '@necromancer/core';
import { ScriptedModel } from '@necromancer/llm';
import { FixCache, fixRisks, resurrect, type ApprovalRequest, type FixProposal, type OwnerQuestion } from '@necromancer/resurrect';
import { deadApp, expressMongoApp, FakeSandbox, NODE_GYP_LOG } from './helpers.js';

const UNKNOWN = "Error: Cannot find module './config/local.json'\n    at Function.Module._resolveFilename (module.js:470:15)";
const PRIVATE = 'npm ERR! 404 Not Found: @acme/core@1.2.0';

const fix = (ops: FixProposal['ops'], diagnosis = 'config file is gitignored'): FixProposal => ({ diagnosis, decision: 'fix', ops, blockedReason: null, question: null, choices: [] });
const question = (q = 'Is there a public replacement for @acme/core?'): FixProposal => ({
  diagnosis: '@acme/core is not on the public registry',
  decision: 'ask',
  ops: [],
  blockedReason: null,
  question: q,
  choices: ['stub it', 'drop the feature'],
});

const recipe = { nodeImage: 'node:6' } as BuildRecipe;

describe('fixRisks', () => {
  it('flags changes to dependencies, Node majors, system packages and what runs', () => {
    expect(
      fixRisks(recipe, [
        { op: 'setNodeImage', tag: '14' },
        { op: 'aptInstall', packages: ['python', 'g++'] },
        { op: 'setDependency', name: 'sass', version: '^1.32.0', dev: true },
        { op: 'removeDependency', name: 'node-sass' },
        { op: 'dropLockfile' },
        { op: 'addInstallFlags', flags: ['--legacy-peer-deps', '--ignore-scripts'] },
        { op: 'globalInstall', spec: 'bower@1' },
        { op: 'runBeforeInstall', command: 'echo {} > config.json' },
        { op: 'setBuildCommand', command: null },
        { op: 'setStartCommand', command: 'node app.js' },
      ]),
    ).toEqual([
      { op: 'setNodeImage', reason: 'moves Node from 6 to 14 (node:14)' },
      { op: 'aptInstall', reason: 'installs Debian packages: python, g++' },
      { op: 'setDependency', reason: 'changes package.json: sets sass to ^1.32.0 (dev)' },
      { op: 'removeDependency', reason: 'changes package.json: removes node-sass' },
      { op: 'dropLockfile', reason: 'drops the lockfile, so dependency versions are resolved again' },
      { op: 'addInstallFlags', reason: 'installs with --ignore-scripts, which skips install scripts, so native modules are not built' },
      { op: 'globalInstall', reason: 'installs bower@1 globally in the image' },
      { op: 'runBeforeInstall', reason: 'runs a command before install: echo {} > config.json' },
      { op: 'setBuildCommand', reason: 'skips the build step' },
      { op: 'setStartCommand', reason: 'changes the start command to: node app.js' },
    ]);
  });

  it('lets sandbox tuning through', () => {
    expect(
      fixRisks(recipe, [
        { op: 'setEnv', name: 'HUSKY', value: '0' },
        { op: 'setPort', port: 8080 },
        { op: 'useDebianArchive' },
        { op: 'addInstallFlags', flags: ['--legacy-peer-deps', '--ignore-engines'] },
        { op: 'setNodeImage', tag: '6.17-stretch' },
      ]),
    ).toEqual([]);
    expect(fixRisks(recipe, [{ op: 'addInstallFlags', flags: ['--force'] }])[0]!.reason).toMatch(/^installs with --force/);
  });

  it('flags variables and flags that change where packages come from', () => {
    expect(
      fixRisks(recipe, [
        { op: 'setEnv', name: 'npm_config_registry', value: 'https://evil.example' },
        { op: 'setEnv', name: 'YARN_IGNORE_ENGINES', value: '1' },
        { op: 'setEnv', name: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' },
        { op: 'setEnv', name: 'NODE_OPTIONS', value: '--require ./x.js' },
      ]),
    ).toEqual([
      { op: 'setEnv', reason: 'changes how npm installs: npm_config_registry=https://evil.example' },
      { op: 'setEnv', reason: 'changes how npm installs: YARN_IGNORE_ENGINES=1' },
      { op: 'setEnv', reason: 'turns off TLS certificate checks: NODE_TLS_REJECT_UNAUTHORIZED=0' },
      { op: 'setEnv', reason: 'changes how Node runs every script: NODE_OPTIONS=--require ./x.js' },
    ]);
    for (const flags of [['-f'], ['--registry', 'https://evil.example'], ['--registry=https://evil.example'], ['--unsafe-perm']]) {
      expect(fixRisks(recipe, [{ op: 'addInstallFlags', flags }]), flags.join(' ')).toHaveLength(1);
    }
  });
});

describe('owner approval', () => {
  it('asks before a risky known fix and applies it when approved', async () => {
    const requests: ApprovalRequest[] = [];
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: NODE_GYP_LOG }] }),
      approve: async (r) => (requests.push(r), 'approve'),
    });
    expect(report.outcome).toBe('resurrected');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      attempt: 1,
      phase: 'install',
      fix: { source: 'known', id: 'node-gyp-python' },
      risks: [{ op: 'aptInstall', reason: 'installs Debian packages: python, make, g++' }],
    });
    expect(requests[0]!.errorExcerpt).toContain("Can't find Python");
    expect(report.decisions).toEqual([
      {
        attempt: 1,
        kind: 'approval',
        subject: 'node-gyp-python',
        answer: 'approved',
        description: 'A native module needs node-gyp, which needs Python and a C++ toolchain',
        at: expect.any(String),
      },
    ]);
    expect(report.pending).toBeNull();
    expect(report.resume).toBeNull();
  });

  it('does not ask about safe fixes', async () => {
    let asked = 0;
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: 'npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE could not resolve dependency' }] }),
      approve: async () => (asked++, 'approve'),
    });
    expect(report.outcome).toBe('resurrected');
    expect(report.attempts[0]!.fix).toMatchObject({ id: 'peer-deps' });
    expect(asked).toBe(0);
    expect(report.decisions).toEqual([]);
  });

  it('blocks when the owner declines a known fix and nothing else fits', async () => {
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: NODE_GYP_LOG }] }),
      model: null,
      approve: async () => 'reject',
    });
    expect(report.outcome).toBe('blocked');
    expect(report.blockedReason).toMatch(/^the owner declined node-gyp-python and there is no other fix for: gyp ERR! stack Error: Can't find Python/);
    expect(report.decisions).toMatchObject([{ kind: 'approval', subject: 'node-gyp-python', answer: 'rejected' }]);
    expect(report.attempts[0]!.fix).toBeNull();
  });

  it('asks the model for something else when the owner declines a known fix', async () => {
    const model = new ScriptedModel(fix([{ op: 'setEnv', name: 'SKIP_NATIVE', value: '1' }], 'skip the source build'));
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: NODE_GYP_LOG }] }),
      model,
      approve: async () => 'reject',
    });
    expect(report.outcome).toBe('resurrected');
    expect(report.attempts[0]!.fix).toMatchObject({ source: 'llm' });
    const prompt = model.requests[0]!.prompt;
    expect(prompt).toContain('Your previous proposal was rejected: the owner declined it: A native module needs node-gyp');
    expect(prompt).toContain('- attempt 1: the owner rejected fix node-gyp-python');
  });

  it('re-asks the model when the owner declines its fix, and refuses the same fix twice', async () => {
    const risky = fix([{ op: 'setDependency', name: 'config', version: '^1.0.0' }], 'add the config package');
    const model = new ScriptedModel(risky, risky, fix([{ op: 'setEnv', name: 'CONFIG', value: 'local' }]));
    const verdicts: string[] = [];
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model,
      approve: async (r) => (verdicts.push(r.fix.description), 'reject'),
    });
    expect(report.outcome).toBe('resurrected');
    expect(verdicts).toEqual(['add the config package']);
    expect(model.requests[1]!.prompt).toContain('the owner declined it: add the config package');
    expect(report.warnings).toEqual(['attempt 1: rejected a proposed fix (the owner already declined that fix)']);
    expect(report.attempts[0]!.fix).toMatchObject({ ops: [{ op: 'setEnv', name: 'CONFIG' }] });
  });

  it('names a declined model fix by what it does', async () => {
    const model = new ScriptedModel(
      fix([{ op: 'setDependency', name: 'config', version: '^1.0.0' }], 'add the config package'),
      fix([{ op: 'setEnv', name: 'CONFIG', value: 'local' }]),
    );
    await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model,
      approve: async () => 'reject',
    });
    expect(model.requests[1]!.prompt).toContain('- attempt 1: the owner rejected fix "add the config package"');
  });

  it('pauses as needs-you with the pending fix and the state to resume from', async () => {
    const progress: string[] = [];
    const sandbox = new FakeSandbox({ install: [{ ok: false, log: NODE_GYP_LOG }] });
    const report = await resurrect(await deadApp(expressMongoApp), { sandbox, approve: async () => 'pause', onProgress: (m) => progress.push(m) });
    expect(report.outcome).toBe('needs-you');
    expect(report.blockedReason).toBeNull();
    expect(report.pending).toMatchObject({ kind: 'approval', fix: { id: 'node-gyp-python' }, risks: [{ op: 'aptInstall' }] });
    expect(report.resume).toMatchObject({
      nextAttempt: 2,
      failure: { attempt: 1, phase: 'install', signature: report.attempts[0]!.signature },
      seen: { [report.attempts[0]!.signature!]: 1 },
      tokens: 0,
      calls: 0,
    });
    expect(report.resume!.failure.log).toContain("Can't find Python");
    expect(report.attempts[0]!.fix).toBeNull();
    expect(report.recipe.aptPackages).toEqual([]);
    expect(sandbox.cleaned).toBe(1);
    expect(progress.at(-1)).toBe('NEEDS YOU: approve A native module needs node-gyp, which needs Python and a C++ toolchain');
  });
});

describe('questions', () => {
  it('passes the owner’s answer into the next request', async () => {
    const model = new ScriptedModel(question(), fix([{ op: 'setEnv', name: 'ACME_STUB', value: '1' }]));
    const asked: OwnerQuestion[] = [];
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }),
      model,
      ask: async (q) => (asked.push(q), 'stub it'),
    });
    expect(report.outcome).toBe('resurrected');
    expect(asked).toEqual([
      {
        kind: 'question',
        attempt: 1,
        question: 'Is there a public replacement for @acme/core?',
        context: `@acme/core is not on the public registry Failing line: ${PRIVATE}`,
        choices: ['stub it', 'drop the feature'],
      },
    ]);
    const prompt = model.requests[1]!.prompt;
    expect(prompt).toContain('The owner answered your question: stub it');
    expect(prompt).toContain('- attempt 1: asked "Is there a public replacement for @acme/core?"; the owner answered: stub it');
    expect(report.decisions).toMatchObject([{ attempt: 1, kind: 'question', subject: 'Is there a public replacement for @acme/core?', answer: 'stub it' }]);
  });

  it('keeps the owner’s answer when they decline the fix built on it', async () => {
    const model = new ScriptedModel(
      question(),
      fix([{ op: 'setDependency', name: '@acme/core', version: 'file:./stub' }], 'stub @acme/core'),
      fix([{ op: 'setEnv', name: 'ACME_STUB', value: '1' }]),
    );
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }),
      model,
      ask: async () => 'stub it',
      approve: async () => 'reject',
    });
    expect(report.outcome).toBe('resurrected');
    expect(model.requests[2]!.prompt).toContain('The owner answered your question: stub it');
    expect(model.requests[2]!.prompt).toContain('the owner declined it: stub @acme/core');
  });

  it('gives up after three rounds with the owner about one failure', async () => {
    const model = new ScriptedModel(question('one?'), question('two?'), question('three?'), question('four?'));
    const asked: string[] = [];
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }),
      model,
      ask: async (q) => (asked.push(q.question), 'no idea'),
    });
    expect(report.outcome).toBe('blocked');
    expect(report.blockedReason).toBe(`asked the owner 3 times about this failure and still no fix: ${PRIVATE}`);
    expect(asked).toEqual(['one?', 'two?', 'three?']);
    expect(report.llm.calls).toBe(4);
  });

  it('keeps a fix built on the owner’s answer out of the shared cache', async () => {
    const cache = new FixCache(null);
    const report = await resurrect(await deadApp(expressMongoApp), {
      sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }),
      model: new ScriptedModel(question(), fix([{ op: 'setEnv', name: 'ACME_STUB', value: '1' }])),
      ask: async () => 'stub it',
      fixCache: cache,
    });
    expect(report.outcome).toBe('resurrected');
    expect(await cache.get(report.attempts[0]!.signature!)).toBeNull();
  });

  it('pauses when there is nobody to ask, or no answer', async () => {
    for (const ask of [undefined, async () => null]) {
      const progress: string[] = [];
      const report = await resurrect(await deadApp(expressMongoApp), {
        sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }),
        model: new ScriptedModel(question()),
        ask,
        onProgress: (m) => progress.push(m),
      });
      expect(report.outcome).toBe('needs-you');
      expect(report.pending).toMatchObject({ kind: 'question', question: 'Is there a public replacement for @acme/core?' });
      expect(report.resume).toMatchObject({ nextAttempt: 2, calls: 1 });
      expect(progress.at(-1)).toBe('NEEDS YOU: Is there a public replacement for @acme/core?');
    }
  });
});

describe('resume', () => {
  async function paused(log = NODE_GYP_LOG) {
    const root = await deadApp(expressMongoApp);
    const report = await resurrect(root, { sandbox: new FakeSandbox({ install: [{ ok: false, log }] }), approve: async () => 'pause' });
    expect(report.outcome).toBe('needs-you');
    return { root, report };
  }

  it('applies the approved fix and carries on with the next attempt', async () => {
    const { root, report: from } = await paused();
    const sandbox = new FakeSandbox({});
    const report = await resurrect(root, { sandbox, resume: { from, approve: true } });
    expect(report.outcome).toBe('resurrected');
    expect(report.attempts.map((a) => [a.n, a.ok])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(report.attempts[0]!.fix).toMatchObject({ id: 'node-gyp-python' });
    expect(report.recipe.aptPackages).toEqual(['python', 'make', 'g++']);
    expect(sandbox.dockerfiles[0]).toContain('apt-get install -y --no-install-recommends python make g++');
    expect(sandbox.calls[0]!.image).toMatch(/:attempt-2$/);
    expect(report.decisions).toMatchObject([{ attempt: 1, kind: 'approval', subject: 'node-gyp-python', answer: 'approved' }]);
    expect(report.pending).toBeNull();
    expect(report.resume).toBeNull();
  });

  it('asks the model again when the owner declines on resume', async () => {
    const { root, report: from } = await paused();
    const model = new ScriptedModel(fix([{ op: 'setEnv', name: 'npm_config_build_from_source', value: 'false' }]));
    const report = await resurrect(root, { sandbox: new FakeSandbox({}), model, resume: { from, approve: false } });
    expect(report.outcome).toBe('resurrected');
    expect(model.requests[0]!.prompt).toContain('the owner declined it: A native module needs node-gyp');
    expect(report.attempts[0]!.fix).toMatchObject({ source: 'llm' });
    expect(report.decisions).toMatchObject([{ subject: 'node-gyp-python', answer: 'rejected' }]);
  });

  it('remembers model fixes the owner declined before the pause', async () => {
    const root = await deadApp(expressMongoApp);
    const a = fix([{ op: 'setDependency', name: 'config', version: '^1.0.0' }], 'add the config package');
    const b = fix([{ op: 'removeDependency', name: 'config' }], 'drop config');
    const verdicts: Array<'reject' | 'pause'> = ['reject', 'pause'];
    const from = await resurrect(root, {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model: new ScriptedModel(a, b),
      approve: async () => verdicts.shift()!,
    });
    expect(from.outcome).toBe('needs-you');
    expect(from.resume).toMatchObject({ declined: ['"add the config package"'], rounds: 1, answer: null });
    const model = new ScriptedModel(a, fix([{ op: 'setEnv', name: 'CONFIG', value: 'local' }]));
    const report = await resurrect(root, { sandbox: new FakeSandbox({}), model, approve: async () => 'reject', resume: { from, approve: false } });
    expect(report.outcome).toBe('resurrected');
    expect(report.warnings).toContain('attempt 1: rejected a proposed fix (the owner already declined that fix)');
    expect(report.attempts[0]!.fix).toMatchObject({ ops: [{ op: 'setEnv', name: 'CONFIG' }] });
  });

  it('warns when the repo moved on since the pause', async () => {
    const { root, report: paused1 } = await paused();
    const from = { ...paused1, repo: { ...paused1.repo, commit: 'a'.repeat(40) } };
    const report = await resurrect(root, { sandbox: new FakeSandbox({}), resume: { from, approve: true } });
    expect(report.outcome).toBe('resurrected');
    expect(report.warnings).toContain(
      `the repo changed since the run paused (aaaaaaa → ${report.repo.commit!.slice(0, 7)}); the saved recipe was diagnosed against the old commit`,
    );
  });

  it('passes the answer to the model on resume', async () => {
    const root = await deadApp(expressMongoApp);
    const from = await resurrect(root, { sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }), model: new ScriptedModel(question()) });
    expect(from.outcome).toBe('needs-you');
    const model = new ScriptedModel(fix([{ op: 'setEnv', name: 'ACME_STUB', value: '1' }]));
    const report = await resurrect(root, { sandbox: new FakeSandbox({}), model, resume: { from, answer: 'stub it' } });
    expect(report.outcome).toBe('resurrected');
    expect(model.requests[0]!.prompt).toContain('The owner answered your question: stub it');
    expect(report.llm.calls).toBe(2);
    expect(report.attempts.map((a) => a.n)).toEqual([1, 2]);
  });

  it('counts attempts before the pause toward the limit', async () => {
    const { root, report: from } = await paused();
    const report = await resurrect(root, {
      sandbox: new FakeSandbox({ boot: [{ ok: false, log: UNKNOWN }] }),
      model: null,
      maxIterations: 2,
      resume: { from, approve: true },
    });
    expect(report.blockedReason).toMatch(/^still failing after 2 attempts/);
  });

  it('refuses a report that is not waiting, or a resume without the answer it needs', async () => {
    const root = await deadApp(expressMongoApp);
    const done = await resurrect(root, { sandbox: new FakeSandbox({}) });
    await expect(resurrect(root, { sandbox: new FakeSandbox({}), resume: { from: done, approve: true } })).rejects.toThrow(/needs-you.*ended resurrected/);

    const { report: approval } = await paused();
    await expect(resurrect(root, { sandbox: new FakeSandbox({}), resume: { from: approval, answer: 'yes' } })).rejects.toThrow(
      /approve or reject node-gyp-python/,
    );
    const asking = await resurrect(root, { sandbox: new FakeSandbox({ install: [{ ok: false, log: PRIVATE }] }), model: new ScriptedModel(question()) });
    await expect(resurrect(root, { sandbox: new FakeSandbox({}), resume: { from: asking, answer: ' ' } })).rejects.toThrow(
      /needs an answer to the pending question: Is there a public replacement/,
    );
    for (const options of [{ model: null }, { model: new ScriptedModel(), tokenBudget: 0 }]) {
      await expect(resurrect(root, { sandbox: new FakeSandbox({}), ...options, resume: { from: asking, answer: 'stub it' } })).rejects.toThrow(
        /answering the pending question needs a model/,
      );
    }
  });
});
