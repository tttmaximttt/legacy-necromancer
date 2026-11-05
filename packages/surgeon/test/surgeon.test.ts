import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ReportStore, slugFor, type WitnessReport } from '@necromancer/core';
import { ScriptedModel } from '@necromancer/llm';
import { errorSignature, FixCache, type ApprovalAnswer, type ApprovalRequest } from '@necromancer/resurrect';
import { loadSurgeonInputs, runSurgeon, summarizeDiffs, type SurgeonDeps, type SurgeonOptions } from '@necromancer/surgeon';
import { NODE_GYP_LOG, type FakeSandbox } from '../../resurrect/test/helpers.js';
import { fail, fix, fixed, giveUp, seed, stepSandbox, tokenModel, tomb, type Seeded } from './helpers.js';

const VIPS_LOG = 'npm ERR! sharp@0.30.0 install: Package vips was not found in the pkg-config search path.\nnpm ERR! code ELIFECYCLE';
const FOO_LOG = 'npm ERR! canvas@2.0.0 install: Package foo was not found in the pkg-config search path.\nnpm ERR! code ELIFECYCLE';

const run = (s: Seeded, deps: Partial<SurgeonDeps> = {}, options: SurgeonOptions = {}) =>
  runSurgeon({ source: s.root }, { sandbox: stepSandbox(), store: s.store, clock: fixed, model: null, ...deps }, { targetNode: s.node, ...options });

const installs = (sandbox: FakeSandbox) => sandbox.calls.filter((c) => c.step === 'install').length;
const depsAt = (sandbox: FakeSandbox, i: number) => sandbox.manifests[i]!.dependencies as Record<string, string>;

describe('runSurgeon', () => {
  it('keeps a green step, and later steps build on it', async () => {
    const s = await seed([tomb('a'), tomb('b')]);
    const sandbox = stepSandbox();
    const outDir = await mkdtemp(path.join(os.tmpdir(), 'necro-surgeon-out-'));
    const report = await run(s, { sandbox }, { outDir });

    expect(report.status).toBe('complete');
    expect(report.baseline).toEqual({ ok: true, reason: null, diff: { total: 0, byKind: {}, examples: [] } });
    expect(report.results.map((r) => [r.step.id, r.status, r.attempts])).toEqual([
      ['dep:a', 'kept', 1],
      ['dep:b', 'kept', 1],
    ]);
    expect(report.summary).toEqual({ kept: 2, rolledBack: 0, skipped: 0, remaining: 0 });
    // baseline, then each step: its resurrect attempt and its witness run.
    expect(installs(sandbox)).toBe(6);
    expect(depsAt(sandbox, 2)).toMatchObject({ a: '2.0.0', b: '^1.0.0' });
    expect(depsAt(sandbox, 4)).toMatchObject({ a: '2.0.0', b: '2.0.0' });
    expect(report.recipe.dependencyPatches).toEqual({ a: { version: '2.0.0', dev: false }, b: { version: '2.0.0', dev: false } });
    expect(report.dockerfile).toContain('#   a@2.0.0\n#   b@2.0.0');
    expect(report.used).toEqual({ steps: 2, attempts: 3, tokens: 0, calls: 0, model: null });

    const saved = await s.store.load(slugFor(s.root));
    expect(saved!.surgeon).toEqual(report);
    expect(await readFile(path.join(outDir, 'Dockerfile.necromancer'), 'utf8')).toBe(report.dockerfile);
    expect(await readFile(path.join(outDir, 'docker-compose.necromancer.yml'), 'utf8')).toContain('dockerfile: Dockerfile.necromancer');
  });

  it('rolls back a step whose witness check differs, and runs the next step on the old recipe', async () => {
    const s = await seed([tomb('a'), tomb('b')]);
    const sandbox = stepSandbox(undefined, (_c, deps) => (deps.a === '2.0.0' ? { status: 500, body: { error: 'boom' } } : { status: 200, body: { items: ['a', 'b'] } }));
    const report = await run(s, { sandbox });

    const [a, b] = report.results;
    expect(a).toMatchObject({ status: 'rolled_back', failedAt: 'witness', fix: null, attempts: 1 });
    expect(a!.reason).toMatch(/differences? from the golden snapshots/);
    expect(a!.diff!.total).toBeGreaterThan(0);
    expect(a!.diff!.byKind.status).toBeGreaterThan(0);
    expect(b).toMatchObject({ status: 'kept' });
    expect(depsAt(sandbox, 4)).toMatchObject({ a: '^1.0.0', b: '2.0.0' });
    expect(report.recipe.dependencyPatches).toEqual({ b: { version: '2.0.0', dev: false } });
    expect(report.summary).toEqual({ kept: 1, rolledBack: 1, skipped: 0, remaining: 0 });
    expect(report.status).toBe('complete');
  });

  it('keeps a step after a build failure and one fix', async () => {
    const s = await seed([tomb('a')]);
    const sandbox = stepSandbox((dockerfile, deps) => (deps.a === '2.0.0' && !dockerfile.includes('g++') ? fail(NODE_GYP_LOG) : null));
    const approve = vi.fn<(r: ApprovalRequest) => Promise<ApprovalAnswer>>();
    const report = await run(s, { sandbox, approve });

    expect(report.results[0]).toMatchObject({ status: 'kept', attempts: 2, fix: { source: 'known', id: 'node-gyp-python' } });
    expect(report.recipe.aptPackages).toEqual(['python', 'make', 'g++']);
    expect(report.used.attempts).toBe(3);
    // Known fixes are trusted, so the gate is never asked.
    expect(approve).not.toHaveBeenCalled();
  });

  it('asks before a risky model fix in a terminal: y keeps the step, n rolls it back', async () => {
    const s = await seed([tomb('a'), tomb('b')]);
    const sandbox = stepSandbox((dockerfile, deps) =>
      deps.a === '2.0.0' && !dockerfile.includes('libvips-dev')
        ? fail(VIPS_LOG)
        : deps.b === '2.0.0' && !dockerfile.includes('libfoo-dev')
          ? fail(FOO_LOG)
          : null,
    );
    const model = new ScriptedModel(fix([{ op: 'aptInstall', packages: ['libvips-dev'] }]), fix([{ op: 'aptInstall', packages: ['libfoo-dev'] }]), giveUp);
    const approve = vi.fn<(r: ApprovalRequest) => Promise<ApprovalAnswer>>().mockResolvedValueOnce('approve').mockResolvedValueOnce('reject');
    const report = await run(s, { sandbox, model, approve });

    expect(report.results[0]).toMatchObject({ status: 'kept', attempts: 2, fix: { source: 'llm', ops: [{ op: 'aptInstall', packages: ['libvips-dev'] }] } });
    expect(report.results[1]).toMatchObject({ status: 'rolled_back', failedAt: 'resurrect', fix: null, attempts: 1, reason: 'nothing else to try' });
    expect(approve).toHaveBeenCalledTimes(2);
    for (const [request] of approve.mock.calls) expect(request.risks).toEqual([{ op: 'aptInstall', reason: expect.stringContaining('installs Debian packages') }]);
    expect(report.recipe.aptPackages).toEqual(['libvips-dev']);
    expect(report.used).toMatchObject({ calls: 3, model: 'scripted' });
    expect(report.status).toBe('complete');
  });

  it('pauses as needs-you without a terminal, then resumes with approve and does not redo the baseline or kept steps', async () => {
    const s = await seed([tomb('a'), tomb('b'), tomb('c')]);
    const decide = (_d: string, deps: Record<string, string>) => (deps.b === '2.0.0' && !deps.config ? fail(FOO_LOG) : null);
    const fixCache = new FixCache(null);
    await fixCache.remember(errorSignature('install', FOO_LOG), { description: 'add the config package', ops: [{ op: 'setDependency', name: 'config', version: '^1.0.0' }] });

    // No approve callback: the risky cached fix waits for the owner.
    const paused = await run(s, { sandbox: stepSandbox(decide), fixCache });
    expect(paused.status).toBe('needs-you');
    expect(paused.blockedReason).toBeNull();
    expect(paused.pending).toMatchObject({ kind: 'approval', fix: { source: 'cache', description: 'add the config package' } });
    expect(paused.resume).toMatchObject({ step: 2, used: { steps: 1, attempts: 2 }, inner: { outcome: 'needs-you' } });
    expect(paused.results.map((r) => [r.step.id, r.status])).toEqual([['dep:a', 'kept']]);
    expect(paused.remaining.map((r) => r.id)).toEqual(['dep:b', 'dep:c']);
    expect(paused.summary).toEqual({ kept: 1, rolledBack: 0, skipped: 0, remaining: 2 });
    expect(paused.used).toMatchObject({ steps: 1, attempts: 3 });
    expect((await s.store.load(slugFor(s.root)))!.surgeon).toEqual(paused);

    const sandbox = stepSandbox(decide);
    const report = await run(s, { sandbox }, { resume: { approve: true } });
    expect(report.status).toBe('complete');
    expect(report.pending).toBeNull();
    expect(report.resume).toBeNull();
    expect(report.results.map((r) => [r.step.id, r.status, r.attempts])).toEqual([
      ['dep:a', 'kept', 1],
      ['dep:b', 'kept', 2],
      ['dep:c', 'kept', 1],
    ]);
    expect(report.results[1]!.fix).toMatchObject({ source: 'cache', ops: [{ op: 'setDependency', name: 'config', version: '^1.0.0' }] });
    // Step b's second attempt and its witness run, then step c's: no baseline, no step a.
    expect(installs(sandbox)).toBe(4);
    expect(depsAt(sandbox, 0)).toMatchObject({ a: '2.0.0', b: '2.0.0', config: '^1.0.0' });
    expect(report.used).toMatchObject({ steps: 3, attempts: 5 });
    expect(report.recipe.dependencyPatches).toMatchObject({ a: { version: '2.0.0' }, b: { version: '2.0.0' }, c: { version: '2.0.0' }, config: { version: '^1.0.0' } });

    await expect(run(s, {}, { resume: { approve: true } })).rejects.toThrow(/no surgeon run is waiting on you/);
  });

  it('refuses to resume once the saved reports changed', async () => {
    const s = await seed([tomb('a')]);
    const decide = (_d: string, deps: Record<string, string>) => (deps.a === '2.0.0' && !deps.config ? fail(FOO_LOG) : null);
    const fixCache = new FixCache(null);
    await fixCache.remember(errorSignature('install', FOO_LOG), { description: 'add the config package', ops: [{ op: 'setDependency', name: 'config', version: '^1.0.0' }] });
    expect((await run(s, { sandbox: stepSandbox(decide), fixCache })).status).toBe('needs-you');

    const golden = (await s.store.load(slugFor(s.root)))!.witness!;
    await s.store.save('witness', { ...golden, generatedAt: '2030-01-01T00:00:00.000Z' } satisfies WitnessReport);
    await expect(run(s, {}, { resume: { approve: true } })).rejects.toThrow('the saved reports changed since surgeon paused; start a new surgeon run');
  });

  it('rolls back a step whose only fix undoes it', async () => {
    const s = await seed([tomb('fibers', { latest: null })]);
    const sandbox = stepSandbox((dockerfile) => (dockerfile.includes('FROM node:24') ? fail('npm ERR! fibers@1.0.15 install: `node build.js`\nError: fibers does not build') : null));
    const report = await run(s, { sandbox }, { targetNode: '24' });

    const node = report.results.find((r) => r.step.id === 'node:24')!;
    expect(node).toMatchObject({ status: 'rolled_back', failedAt: 'resurrect', attempts: 2, fix: { source: 'known', id: 'fibers-node16' } });
    expect(node.reason).toMatch(/^the only fix that boots it undoes the step: fibers does not build/);
    expect(report.recipe.nodeImage).toBe('node:6');
  });

  it('records a skip-marked step as skipped and never runs it', async () => {
    const s = await seed([tomb('a'), tomb('gone', { latest: null })]);
    const sandbox = stepSandbox();
    const report = await run(s, { sandbox });

    expect(report.results.map((r) => [r.step.id, r.status])).toEqual([
      ['dep:a', 'kept'],
      ['dep:gone', 'skipped'],
    ]);
    expect(report.results[1]).toMatchObject({ reason: 'no release found on the registry', attempts: 0, failedAt: null, diff: null });
    expect(sandbox.manifests.every((m) => (m.dependencies as Record<string, string>).gone === '^1.0.0')).toBe(true);
    expect(report.used.steps).toBe(1);
    expect(report.summary).toEqual({ kept: 1, rolledBack: 0, skipped: 1, remaining: 0 });
  });

  it.each([
    ['steps', {}, { maxSteps: 1 }, /^step budget of 1 spent$/],
    ['attempts', {}, { maxAttempts: 2 }, /^attempt budget of 2 spent \(baseline included\)$/],
    [
      'tokens',
      { model: tokenModel(new ScriptedModel(fix([{ op: 'setEnv', name: 'TZ', value: 'UTC' }])), 1000) },
      { tokenBudget: 1000 },
      /^token budget of 1000 spent \(1000 used\)$/,
    ],
  ] as Array<[string, Partial<SurgeonDeps>, SurgeonOptions, RegExp]>)('stops blocked when the %s budget is spent, with the unreached steps in remaining', async (_name, deps, options, reason) => {
    const s = await seed([tomb('a'), tomb('b'), tomb('c'), tomb('z', { status: 'ailing', latest: null })]);
    // Step a needs a fix only the model knows; with no model in play it is never reached that way.
    const sandbox = stepSandbox((dockerfile, d) => (deps.model && d.a === '2.0.0' && !dockerfile.includes('TZ=') ? fail(VIPS_LOG) : null));
    const report = await run(s, { sandbox, ...deps }, options);

    expect(report.status).toBe('blocked');
    expect(report.blockedReason).toMatch(reason);
    expect(report.results.map((r) => [r.step.id, r.status])).toEqual([
      ['dep:a', 'kept'],
      ['dep:z', 'skipped'],
    ]);
    expect(report.remaining.map((r) => r.id)).toEqual(['dep:b', 'dep:c']);
    expect(report.summary).toEqual({ kept: 1, rolledBack: 0, skipped: 1, remaining: 2 });
    expect(report.used.steps).toBe(1);
  });

  it('blocks before any step when the baseline no longer matches the snapshots', async () => {
    const s = await seed([tomb('a'), tomb('b'), tomb('gone', { latest: null })]);
    const sandbox = stepSandbox(undefined, () => ({ status: 404, body: null }));
    const report = await run(s, { sandbox });

    expect(report.status).toBe('blocked');
    expect(report.blockedReason).toContain("baseline doesn't match snapshots; re-run witness");
    expect(report.baseline.ok).toBe(false);
    expect(report.baseline.diff!.total).toBeGreaterThan(0);
    expect(installs(sandbox)).toBe(2);
    expect(report.results.map((r) => [r.step.id, r.status])).toEqual([['dep:gone', 'skipped']]);
    expect(report.remaining.map((r) => r.id)).toEqual(['dep:a', 'dep:b']);
    expect(report.used).toMatchObject({ steps: 0, attempts: 1 });
    expect(report.recipe).toEqual((await s.store.load(slugFor(s.root)))!.resurrect!.recipe);
  });

  it('gives the same plan and report when run again on the same inputs', async () => {
    const s = await seed([tomb('a'), tomb('b'), tomb('gone', { latest: null })]);
    const respond = (_c: unknown, deps: Record<string, string>) => (deps.a === '2.0.0' ? { status: 500, body: null } : { status: 200, body: { items: ['a', 'b'] } });
    const first = await run(s, { sandbox: stepSandbox(undefined, respond) });
    const second = await run(s, { sandbox: stepSandbox(undefined, respond) });

    expect(second.results.map((r) => r.step)).toEqual(first.results.map((r) => r.step));
    expect(second.remaining).toEqual(first.remaining);
    expect(second).toEqual(first);
    expect(first.results.map((r) => r.status)).toEqual(['rolled_back', 'kept', 'skipped']);
  });
});

describe('loadSurgeonInputs', () => {
  it.each(['graveyard', 'resurrect', 'witness'] as const)('says to run %s first when its report is missing', async (kind) => {
    const s = await seed([tomb('a')]);
    const saved = (await s.store.load(slugFor(s.root)))!;
    const store = new ReportStore(await mkdtemp(path.join(os.tmpdir(), 'necro-surgeon-')));
    for (const k of ['graveyard', 'resurrect', 'witness'] as const) if (k !== kind) await store.save(k, saved[k]!);
    await expect(loadSurgeonInputs(store, s.root)).rejects.toThrow(`no ${kind} report for ${s.root}; run \`necromancer ${kind} `);
  });

  it('refuses a resurrect report that did not get the app running', async () => {
    const s = await seed([tomb('a')]);
    const saved = (await s.store.load(slugFor(s.root)))!;
    await s.store.save('resurrect', { ...saved.resurrect!, outcome: 'blocked', blockedReason: 'no' });
    await expect(loadSurgeonInputs(s.store, s.root)).rejects.toThrow(/resurrect did not get .* running \(blocked\)/);
  });

  it('refuses maxAttempts below 1', async () => {
    const s = await seed([tomb('a')]);
    await expect(run(s, {}, { maxAttempts: 0 })).rejects.toThrow('maxAttempts must be at least 1 (the baseline)');
  });
});

describe('summarizeDiffs', () => {
  it('counts by kind and keeps the first 10', () => {
    const diffs = Array.from({ length: 12 }, (_, i) => ({ case: `GET /${i}`, what: i % 3 ? ('status' as const) : ('body' as const), detail: '' }));
    const summary = summarizeDiffs(diffs);
    expect(summary).toMatchObject({ total: 12, byKind: { body: 4, status: 8 } });
    expect(summary.examples).toEqual(diffs.slice(0, 10));
  });
});
