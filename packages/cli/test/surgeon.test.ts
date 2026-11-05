import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPORT_KINDS, ReportStore, slugFor, type Tombstone } from '@necromancer/core';
import { errorSignature } from '@necromancer/resurrect';
import { createProgram } from '../src/index.js';
import type { FakeSandbox } from '../../resurrect/test/helpers.js';
import { fail, seed, stepSandbox, tomb, type Decide, type Respond } from '../../surgeon/test/helpers.js';

const FOO_LOG = 'npm ERR! canvas@2.0.0 install: Package foo was not found in the pkg-config search path.\nnpm ERR! code ELIFECYCLE';
/** Step b fails to install until the config package is added, which only the cached (risky) fix does. */
const needsConfig: Decide = (_d, deps) => (deps.b === '2.0.0' && !deps.config ? fail(FOO_LOG) : null);

interface Seeded {
  root: string;
  reports: string;
  node: string;
}

/**
 * The surgeon test seed, copied into a reports directory of its own inside a fresh directory, so the fix cache the CLI
 * keeps next to it holds only what a test puts there.
 */
async function seeded(tombstones: Tombstone[], respond?: Respond): Promise<Seeded> {
  const s = await seed(tombstones, respond);
  const reports = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-surgeon-')), 'reports');
  const saved = (await s.store.load(slugFor(s.root)))!;
  const store = new ReportStore(reports);
  for (const kind of REPORT_KINDS) if (saved[kind]) await store.save(kind, saved[kind]);
  return { root: s.root, reports, node: s.node };
}

/** Puts a risky cached fix for FOO_LOG in the fix cache next to `reports`: it adds the config package. */
function cacheConfigFix(reports: string): void {
  const fix = { description: 'add the config package', ops: [{ op: 'setDependency', name: 'config', version: '^1.0.0' }], hits: 1 };
  writeFileSync(path.join(path.dirname(reports), 'fix-cache.json'), JSON.stringify({ [errorSignature('install', FOO_LOG)]: fix }));
}

describe('necromancer surgeon', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  const capture = () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return { stderr, written: () => stderr.mock.calls.map((c) => String(c[0])).join('') };
  };
  const cli = (s: Seeded, sandbox: FakeSandbox, prompt: ((q: string) => Promise<string>) | null, ...args: string[]) =>
    createProgram({ sandbox, prompt }).parseAsync(['node', 'necromancer', 'surgeon', s.root, '--reports', s.reports, '-q', ...args]);
  const fresh = (s: Seeded, sandbox: FakeSandbox, ...args: string[]) => cli(s, sandbox, null, '--no-llm', '--target-node', s.node, ...args);
  const savedSurgeon = async (s: Seeded) => (await new ReportStore(s.reports).load(slugFor(s.root)))!.surgeon!;

  it('runs every step, prints what it kept, rolled back and skipped, and saves the report and recipe', async () => {
    const s = await seeded([tomb('a'), tomb('b'), tomb('gone', { latest: null })]);
    const { written } = capture();
    const out = path.join(path.dirname(s.reports), 'out');
    const sandbox = stepSandbox(undefined, (_c, deps) => (deps.a === '2.0.0' ? { status: 500, body: { error: 'boom' } } : { status: 200, body: { items: ['a', 'b'] } }));
    await fresh(s, sandbox, '--out-dir', out);

    expect(process.exitCode).toBeUndefined();
    const text = written();
    expect(text).toMatch(/\n {2}1\. {2}rolled back Upgrade a from 1\.0\.0 to 2\.0\.0\n {7}at witness: \d+ differences? from the golden snapshots \(\d+ status, \d+ body\)\n {9}status /);
    expect(text).toContain('  2.  kept        Upgrade b from 1.0.0 to 2.0.0\n');
    expect(text).toContain('  3.  skipped     Keep gone at 1.0.0: no release found on the registry\n');
    expect(text).toContain('\nCOMPLETE: 1 kept, 1 rolled back, 1 skipped\n');
    const file = path.join(s.reports, slugFor(s.root), 'surgeon.json');
    expect(text).toContain(`saved ${file} and the Dockerfile and compose file to ${out}\n`);

    const report = await savedSurgeon(s);
    expect(report.status).toBe('complete');
    expect(report.results.map((r) => [r.step.id, r.status])).toEqual([
      ['dep:a', 'rolled_back'],
      ['dep:b', 'kept'],
      ['dep:gone', 'skipped'],
    ]);
    expect(await readFile(path.join(out, 'Dockerfile.necromancer'), 'utf8')).toBe(report.dockerfile);
    expect(report.dockerfile).toContain('#   b@2.0.0');
  });

  it('exits 2 with the reason and the steps not reached when a budget runs out', async () => {
    const s = await seeded([tomb('a'), tomb('b'), tomb('c')]);
    const { written } = capture();
    await fresh(s, stepSandbox(), '--max-steps', '1');

    expect(process.exitCode).toBe(2);
    expect(written()).toContain('  1.  kept        Upgrade a from 1.0.0 to 2.0.0\n');
    expect(written()).toContain('\nBLOCKED: step budget of 1 spent\n1 kept, 0 rolled back, 0 skipped; not reached:\n  2.  Upgrade b from 1.0.0 to 2.0.0\n  3.  Upgrade c from 1.0.0 to 2.0.0\n');
    expect((await savedSurgeon(s)).budgets).toMatchObject({ maxSteps: 1 });
  });

  it('stops with NEEDS YOU and exit code 3 on a risky fix without a terminal, then --resume --approve carries on', async () => {
    const s = await seeded([tomb('a'), tomb('b'), tomb('c')]);
    cacheConfigFix(s.reports);
    const { stderr, written } = capture();
    const command = `necromancer surgeon ${s.root} --resume --reports ${s.reports}`;

    await fresh(s, stepSandbox(needsConfig));
    expect(process.exitCode).toBe(3);
    expect(written()).toContain('  1.  kept        Upgrade a from 1.0.0 to 2.0.0\n');
    expect(written()).toContain('Paused at step 2: Upgrade b from 1.0.0 to 2.0.0\nNot reached yet:\n  3.  Upgrade c from 1.0.0 to 2.0.0\n');
    expect(written()).toContain('NEEDS YOU: apply this fix? add the config package (cache fix ');
    expect(written()).toContain('  - changes package.json: sets config to ^1.0.0');
    expect(written()).toContain(`  ${command} --approve\n  ${command} --reject\n`);
    expect((await savedSurgeon(s)).status).toBe('needs-you');

    // No terminal and no answer: still waiting, so NEEDS YOU and exit 3 again rather than an error.
    stderr.mockClear();
    process.exitCode = undefined;
    await cli(s, stepSandbox(needsConfig), null, '--resume');
    expect(process.exitCode).toBe(3);
    expect(written()).toContain(`  ${command} --approve\n`);
    expect((await savedSurgeon(s)).status).toBe('needs-you');

    process.exitCode = undefined;
    stderr.mockClear();
    const sandbox = stepSandbox(needsConfig);
    await cli(s, sandbox, null, '--resume', '--approve');
    expect(process.exitCode).toBeUndefined();
    expect(written()).toContain('  2.  kept        Upgrade b from 1.0.0 to 2.0.0 (with fix: add the config package)\n');
    expect(written()).toContain('\nCOMPLETE: 3 kept, 0 rolled back, 0 skipped\n');
    const report = await savedSurgeon(s);
    expect(report.status).toBe('complete');
    expect(report.results.map((r) => [r.step.id, r.status])).toEqual([
      ['dep:a', 'kept'],
      ['dep:b', 'kept'],
      ['dep:c', 'kept'],
    ]);
    await expect(cli(s, stepSandbox(), null, '--resume', '--approve')).rejects.toThrow(`no surgeon run is waiting on you for ${s.root}; start one without --resume`);
  });

  it('asks about a risky fix on a terminal', async () => {
    const s = await seeded([tomb('a'), tomb('b')]);
    cacheConfigFix(s.reports);
    const { written } = capture();
    const asked: string[] = [];
    await fresh(s, stepSandbox(needsConfig));
    expect(process.exitCode).toBe(3);

    process.exitCode = undefined;
    await cli(s, stepSandbox(needsConfig), async (q) => (asked.push(q), 'n'), '--resume');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Apply it\? \[y\]es/);
    expect(written()).toContain('Proposed fix (cache): add the config package');
    expect(process.exitCode).toBeUndefined();
    expect((await savedSurgeon(s)).results.map((r) => [r.step.id, r.status])).toEqual([
      ['dep:a', 'kept'],
      ['dep:b', 'rolled_back'],
    ]);
  });

  it('never answers the pending fix with --yes on --resume, and --reject rolls the step back', async () => {
    const s = await seeded([tomb('a'), tomb('b')]);
    cacheConfigFix(s.reports);
    const { written } = capture();
    await fresh(s, stepSandbox(needsConfig));
    expect(process.exitCode).toBe(3);

    // No terminal: --yes covers later fixes only, so the run stays paused on this one.
    process.exitCode = undefined;
    await cli(s, stepSandbox(needsConfig), null, '--resume', '--yes');
    expect(process.exitCode).toBe(3);
    expect(written()).toContain(`necromancer surgeon ${s.root} --resume --reports ${s.reports} --approve`);
    expect((await savedSurgeon(s)).status).toBe('needs-you');

    process.exitCode = undefined;
    await cli(s, stepSandbox(needsConfig), null, '--resume', '--reject', '--yes');
    expect(process.exitCode).toBeUndefined();
    const report = await savedSurgeon(s);
    expect(report.status).toBe('complete');
    expect(report.results.map((r) => [r.step.id, r.status, r.failedAt])).toEqual([
      ['dep:a', 'kept', null],
      ['dep:b', 'rolled_back', 'resurrect'],
    ]);
    expect(report.recipe.dependencyPatches).not.toHaveProperty('config');
  });

  it('validates the --resume flags', async () => {
    const s = await seeded([tomb('a')]);
    capture();
    await expect(fresh(s, stepSandbox(), '--approve')).rejects.toThrow('--approve, --reject and --answer go with --resume');
    await expect(cli(s, stepSandbox(), null, '--resume', '--approve', '--reject')).rejects.toThrow('pass --approve or --reject, not both');
    await expect(cli(s, stepSandbox(), null, '--resume', '--answer', '  ')).rejects.toThrow('--answer is empty');
    await expect(cli(s, stepSandbox(), null, '--resume', '--approve', '--max-steps', '3', '--no-llm')).rejects.toThrow(
      "--max-steps, --no-llm don't go with --resume: the paused run's budgets and settings stand",
    );
    await expect(cli(s, stepSandbox(), null, '--resume', '--approve')).rejects.toThrow('no surgeon run is waiting on you');
    expect(process.exitCode).toBeUndefined();
  });

  it('says which command to run first when a report is missing', async () => {
    const s = await seeded([tomb('a')]);
    capture();
    const store = new ReportStore(s.reports);
    const saved = (await store.load(slugFor(s.root)))!;
    const empty: Seeded = { ...s, reports: path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cli-surgeon-')), 'reports') };
    await expect(fresh(empty, stepSandbox())).rejects.toThrow(`no graveyard report for ${s.root}; run \`necromancer graveyard ${s.root}\` first`);
    await new ReportStore(empty.reports).save('graveyard', saved.graveyard!);
    await expect(fresh(empty, stepSandbox())).rejects.toThrow(`run \`necromancer resurrect ${s.root}\` first`);
    await new ReportStore(empty.reports).save('resurrect', saved.resurrect!);
    await expect(fresh(empty, stepSandbox())).rejects.toThrow(`run \`necromancer witness ${s.root}\` first`);
  });
});
