import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  BuildRecipe,
  ExhumeReport,
  GraveyardReport,
  InterviewReport,
  ResurrectReport,
  SandboxLimits,
  SurgeonBudgets,
  SurgeonReport,
  SurgeonStep,
  SurgeonStepResult,
  WitnessDiffSummary,
  WitnessDifference,
  WitnessReport,
} from '@necromancer/core';
import { errorMessage, shellArg, slugFor, type ReportStore } from '@necromancer/core';
import type { StructuredModel } from '@necromancer/llm';
import { TARGET_NODE } from '@necromancer/plan';
import {
  applyOps,
  changesRecipe,
  DEFAULT_LIMITS,
  DEFAULT_TOKEN_BUDGET,
  FixCache,
  prepareResume,
  renderCompose,
  renderDockerfile,
  resurrect,
  type ResurrectOptions,
  type Sandbox,
} from '@necromancer/resurrect';
import { compareWitness, witness } from '@necromancer/witness';
import { planSteps } from './plan.js';

export const DEFAULT_MAX_STEPS = 20;
/** About 20 steps of 2 attempts each, the baseline included. */
export const DEFAULT_MAX_ATTEMPTS = 40;
/** Attempts one step may use: the step itself, then the step with one fix. */
const STEP_ATTEMPTS = 2;
const MAX_EXAMPLES = 10;

export interface SurgeonInputs {
  /** The repo, as given to resurrect; the saved reports are loaded with `deps.store.load(slugFor(source))`. */
  source: string;
}

export interface SurgeonDeps {
  /** DockerSandbox in the CLI, a fake in tests. */
  sandbox: Sandbox;
  /** Reads the saved graveyard, resurrect and witness reports (and exhume and interview, if saved); saves the surgeon report. */
  store: ReportStore;
  /** Passed to the inner resurrect runs only; null uses known and cached fixes only. */
  model?: StructuredModel | null;
  /** The witness runner; defaults to witness from @necromancer/witness. */
  witness?: typeof witness;
  /** For generatedAt and durations; defaults to the system clock. */
  clock?: () => Date;
  /** Fixes the model found before, by error signature; defaults to an empty in-memory cache. */
  fixCache?: FixCache;
  /**
   * The same approval gate as resurrect: asked before a risky cached or model fix is applied on top of a step.
   * Without it the run pauses as needs-you on such a fix rather than applying it.
   */
  approve?: ResurrectOptions['approve'];
  /** Asked when the model needs the owner's answer; without one, or with no answer, the run pauses as needs-you. */
  ask?: ResurrectOptions['ask'];
  onProgress?: (message: string) => void;
}

export interface SurgeonOptions {
  /** Steps that may run; defaults to DEFAULT_MAX_STEPS. */
  maxSteps?: number;
  /** Resurrect attempts in total, the baseline included; at least 1. Defaults to DEFAULT_MAX_ATTEMPTS. */
  maxAttempts?: number;
  /** Tokens across every inner resurrect run; defaults to resurrect's DEFAULT_TOKEN_BUDGET. 0 asks no model. */
  tokenBudget?: number;
  /** Over DEFAULT_LIMITS, then the saved resurrect report's limits. */
  limits?: Partial<SandboxLimits>;
  /** The Node release to end on; defaults to TARGET_NODE from @necromancer/plan. */
  targetNode?: string;
  caFile?: string;
  workdir?: string;
  /** Also write Dockerfile.necromancer and docker-compose.necromancer.yml here, as `resurrect --out-dir` does. */
  outDir?: string;
  /** Save the report via `deps.store`; defaults to true. */
  save?: boolean;
  /**
   * Continue the saved needs-you surgeon run with the owner's answer to its pending decision. The saved run's budgets
   * and settings stand; the other options are not read.
   */
  resume?: { approve?: boolean; answer?: string };
}

export interface LoadedInputs {
  graveyard: GraveyardReport;
  resurrect: ResurrectReport;
  witness: WitnessReport;
  exhume: ExhumeReport | null;
  interview: InterviewReport | null;
  surgeon: SurgeonReport | null;
}

/** Loads the saved reports surgeon starts from, and throws a readable error naming the command to run when one is missing or unusable. */
export async function loadSurgeonInputs(store: ReportStore, source: string): Promise<LoadedInputs> {
  const saved = await store.load(slugFor(source));
  const first = (kind: string) => new Error(`no ${kind} report for ${source}; run \`necromancer ${kind} ${shellArg(source)}\` first`);
  if (!saved?.graveyard) throw first('graveyard');
  if (!saved.resurrect) throw first('resurrect');
  if (!saved.witness) throw first('witness');
  if (saved.resurrect.outcome !== 'resurrected') {
    throw new Error(
      `resurrect did not get ${source} running (${saved.resurrect.outcome}); run \`necromancer resurrect ${shellArg(source)}\` (or --resume) first`,
    );
  }
  if (!saved.witness.snapshots.length && !saved.witness.tests) {
    throw new Error(`the witness report has nothing to compare; run \`necromancer witness ${shellArg(source)}\` first`);
  }
  return {
    graveyard: saved.graveyard,
    resurrect: saved.resurrect,
    witness: saved.witness,
    exhume: saved.exhume,
    interview: saved.interview,
    surgeon: saved.surgeon,
  };
}

/** compareWitness output as a summary: the total, counts by kind, and the first few differences. */
export function summarizeDiffs(diffs: WitnessDifference[]): WitnessDiffSummary {
  const byKind: WitnessDiffSummary['byKind'] = {};
  for (const d of diffs) byKind[d.what] = (byKind[d.what] ?? 0) + 1;
  return { total: diffs.length, byKind, examples: diffs.slice(0, MAX_EXAMPLES) };
}

type Used = SurgeonReport['used'];
type Check = { ok: true; diff: WitnessDiffSummary } | { ok: false; reason: string; diff: WitnessDiffSummary | null };
type Finished = { kind: 'done'; result: SurgeonStepResult; recipe: BuildRecipe | null } | { kind: 'pause'; inner: ResurrectReport };

/**
 * The bounded upgrade loop. Checks that the unmodified recipe still matches the golden witness snapshots, then
 * tries each planned step on a copy of the recipe: resurrect builds and boots it (with at most one fix, through the
 * same approval gate as resurrect), witness replays the golden requests, and the step is kept only when nothing
 * differs. A failed step is rolled back and the next one runs on the recipe from before it. Stops blocked when a
 * budget runs out, and needs-you when a fix waits on the owner; `options.resume` carries on from there.
 */
export async function runSurgeon(inputs: SurgeonInputs, deps: SurgeonDeps, options: SurgeonOptions = {}): Promise<SurgeonReport> {
  const { source } = inputs;
  const { sandbox, store } = deps;
  const clock = deps.clock ?? (() => new Date());
  const runWitness = deps.witness ?? witness;
  const fixCache = deps.fixCache ?? new FixCache(null);
  const log = deps.onProgress ?? (() => {});
  // With nobody set up to approve, a risky fix waits for the owner instead of being applied.
  const approve: NonNullable<ResurrectOptions['approve']> = deps.approve ?? (async () => 'pause');

  const saved = await loadSurgeonInputs(store, source);
  const golden = saved.witness;
  const from = options.resume ? pausedRun(saved, source) : null;

  const budgets: SurgeonBudgets = from?.budgets ?? {
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    tokenBudget: options.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    limits: { ...DEFAULT_LIMITS, ...saved.resurrect.limits, ...defined(options.limits) },
  };
  if (budgets.maxAttempts < 1) throw new Error('maxAttempts must be at least 1 (the baseline)');
  const target = from?.target.node ?? options.targetNode ?? TARGET_NODE;
  const settings = from?.resume?.inner.resume?.settings;
  const caFile = from ? (settings?.caFile ?? undefined) : options.caFile;
  const workdir = from ? (settings?.workdir ?? undefined) : options.workdir;
  const model = budgets.tokenBudget > 0 ? (deps.model ?? null) : null;
  const basedOn: SurgeonReport['basedOn'] = { graveyard: null, resurrect: saved.resurrect.generatedAt, witness: golden.generatedAt };
  // A resume runs the paused run's own steps, once they are checked against a fresh plan from the reports now saved.
  const steps = from ? checkUnchanged(from, basedOn, planSteps(saved, { targetNode: target })) : planSteps(saved, { targetNode: target });

  const warnings: string[] = from ? [...from.warnings] : [];
  const warn = (prefix: string, list: string[]) => {
    for (const w of list) if (!warnings.includes(`${prefix}: ${w}`)) warnings.push(`${prefix}: ${w}`);
  };
  const used: Used = from ? { ...from.resume!.used } : { steps: 0, attempts: 0, tokens: 0, calls: 0, model: model?.name ?? null };
  const count = (inner: ResurrectReport) => {
    used.attempts += inner.attempts.length;
    used.tokens += inner.llm.tokens;
    used.calls += inner.llm.calls;
  };

  const runInner = (recipe: BuildRecipe, maxIterations: number) => {
    const tokenBudget = Math.max(0, budgets.tokenBudget - used.tokens);
    return resurrect(source, {
      sandbox,
      model: tokenBudget > 0 ? model : null,
      fixCache,
      onProgress: log,
      start: { recipe, services: saved.resurrect.services, era: { date: saved.resurrect.era.date, why: saved.resurrect.era.why } },
      maxIterations,
      tokenBudget,
      limits: budgets.limits,
      caFile,
      workdir,
      interview: saved.interview,
      approve,
      ask: deps.ask,
    });
  };

  /** Replays the golden requests against a green inner run and compares the answers. */
  const check = async (inner: ResurrectReport, prefix: string): Promise<Check> => {
    let current: WitnessReport;
    try {
      current = await runWitness(source, {
        sandbox,
        resurrect: inner,
        exhume: saved.exhume,
        model: null,
        cases: golden.snapshots.map((s) => s.case),
        runTests: golden.tests !== null,
        limits: budgets.limits,
        caFile,
        workdir,
        onProgress: log,
      });
    } catch (err) {
      return { ok: false, reason: `the witness check failed: ${errorMessage(err)}`, diff: null };
    }
    warn(prefix, current.warnings);
    const diff = summarizeDiffs(compareWitness(golden, current));
    if (!diff.total) return { ok: true, diff };
    const kinds = Object.entries(diff.byKind).map(([kind, n]) => `${n} ${kind}`).join(', ');
    return { ok: false, reason: `${diff.total} difference${diff.total === 1 ? '' : 's'} from the golden snapshots (${kinds})`, diff };
  };

  /** Turns a finished inner run for a step into its result: kept only when green, the step's op intact, and the witness check clean. */
  const finish = async (step: SurgeonStep, inner: ResurrectReport, elapsedMs: number, startedAt: number): Promise<Finished> => {
    const prefix = `step ${step.n}`;
    warn(prefix, inner.warnings);
    if (inner.outcome === 'needs-you') return { kind: 'pause', inner };
    const fix = inner.attempts.find((a) => a.fix)?.fix ?? null;
    const result = (status: SurgeonStepResult['status'], failedAt: SurgeonStepResult['failedAt'], reason: string | null, diff: WitnessDiffSummary | null) => ({
      step,
      status,
      reason,
      failedAt,
      fix,
      diff,
      attempts: inner.attempts.length,
      tokens: inner.llm.tokens,
      durationMs: elapsedMs + clock().getTime() - startedAt,
    });
    if (inner.outcome === 'blocked') {
      return { kind: 'done', result: result('rolled_back', 'resurrect', inner.blockedReason ?? 'resurrect did not get it running', null), recipe: null };
    }
    // A fix that sets the step's change back (say, Node back to 14) boots the old recipe, not the step.
    if (changesRecipe(inner.recipe, [step.op])) {
      const reason = `the fix that booted it undoes the step: ${fix?.description ?? 'a fix'}`;
      return { kind: 'done', result: result('rolled_back', 'resurrect', reason, null), recipe: null };
    }
    const checked = await check(inner, prefix);
    if (!checked.ok) return { kind: 'done', result: result('rolled_back', 'witness', checked.reason, checked.diff), recipe: null };
    return { kind: 'done', result: result('kept', null, null, checked.diff), recipe: inner.recipe };
  };

  let current: BuildRecipe;
  let baseline: SurgeonReport['baseline'];
  let results: SurgeonStepResult[];
  let blockedReason: string | null = null;
  let paused: { step: SurgeonStep; inner: ResurrectReport; elapsedMs: number; before: Used } | null = null;
  // Steps after this n are planned against `current`; earlier ones are already in `results`.
  let after: number;
  const remaining: SurgeonStep[] = [];

  if (from) {
    const state = from.resume!;
    const step = from.remaining[0]!;
    current = structuredClone(from.recipe);
    baseline = from.baseline;
    results = from.results.filter((r) => r.step.n < step.n);
    after = step.n;
    const input = prepareResume(state.inner, { model: () => deps.model ?? null, approve: options.resume!.approve, answer: options.resume!.answer });
    log(`step ${step.n}: resuming ${step.title}`);
    const startedAt = clock().getTime();
    const inner = await resurrect(source, { sandbox, model: input.run.model, fixCache, onProgress: log, approve, ask: deps.ask, resume: input });
    const before = { ...state.used };
    count(inner);
    const done = await finish(step, inner, state.elapsedMs, startedAt);
    if (done.kind === 'pause') {
      paused = { step, inner: done.inner, elapsedMs: state.elapsedMs + clock().getTime() - startedAt, before };
      remaining.push(step);
    } else {
      used.steps++;
      results.push(done.result);
      if (done.recipe) current = done.recipe;
    }
  } else {
    current = structuredClone(saved.resurrect.recipe);
    results = [];
    after = 0;
    log('baseline: booting the unmodified recipe and checking it against the golden snapshots');
    const inner = await runInner(current, 1);
    count(inner);
    warn('baseline', inner.warnings);
    if (inner.outcome !== 'resurrected') {
      const reason = inner.blockedReason ?? 'resurrect did not get it running';
      baseline = { ok: false, reason, diff: null };
      blockedReason = `the unmodified recipe no longer boots: ${reason}; re-run resurrect`;
    } else {
      const checked = await check(inner, 'baseline');
      baseline = { ok: checked.ok, reason: checked.ok ? null : checked.reason, diff: checked.diff };
      if (!checked.ok) blockedReason = `baseline doesn't match snapshots; re-run witness (${checked.reason})`;
    }
  }

  /** Why the next runnable step can't start, or null while every budget has room. */
  const spent = (): string | null => {
    if (used.steps >= budgets.maxSteps) return `step budget of ${budgets.maxSteps} spent`;
    if (used.attempts >= budgets.maxAttempts) return `attempt budget of ${budgets.maxAttempts} spent (baseline included)`;
    if (model && used.tokens >= budgets.tokenBudget) return `token budget of ${budgets.tokenBudget} spent (${used.tokens} used)`;
    return null;
  };
  const skipped = (step: SurgeonStep, reason: string): SurgeonStepResult => ({
    step,
    status: 'skipped',
    reason,
    failedAt: null,
    fix: null,
    diff: null,
    attempts: 0,
    tokens: 0,
    durationMs: 0,
  });

  for (const step of steps.filter((s) => s.n > after)) {
    // Skip-marked steps are recorded wherever the run stops: no budget would ever run them.
    if (step.skip) {
      results.push(skipped(step, step.skip));
      continue;
    }
    if (blockedReason || paused) {
      remaining.push(step);
      continue;
    }
    if (!changesRecipe(current, [step.op])) {
      results.push(skipped(step, 'already in the recipe'));
      continue;
    }
    blockedReason = spent();
    if (blockedReason) {
      log(`BLOCKED before step ${step.n}: ${blockedReason}`);
      remaining.push(step);
      continue;
    }
    log(`step ${step.n}/${steps.length}: ${step.title}`);
    const startedAt = clock().getTime();
    const before = { ...used };
    const inner = await runInner(applyOps(current, [step.op]), Math.min(STEP_ATTEMPTS, budgets.maxAttempts - used.attempts));
    count(inner);
    const done = await finish(step, inner, 0, startedAt);
    if (done.kind === 'pause') {
      paused = { step, inner: done.inner, elapsedMs: clock().getTime() - startedAt, before };
      remaining.push(step);
      continue;
    }
    used.steps++;
    results.push(done.result);
    log(`step ${step.n}: ${done.result.status === 'kept' ? 'kept' : `rolled back (${done.result.reason})`}`);
    if (done.recipe) current = done.recipe;
  }

  const summary = {
    kept: results.filter((r) => r.status === 'kept').length,
    rolledBack: results.filter((r) => r.status === 'rolled_back').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    remaining: remaining.length,
  };
  const report: SurgeonReport = {
    repo: { source, commit: saved.resurrect.repo.commit },
    generatedAt: clock().toISOString(),
    status: paused ? 'needs-you' : blockedReason ? 'blocked' : 'complete',
    blockedReason: paused ? null : blockedReason,
    pending: paused?.inner.pending ?? null,
    resume: paused ? { step: paused.step.n, elapsedMs: paused.elapsedMs, used: paused.before, inner: paused.inner } : null,
    basedOn,
    target: { node: target },
    baseline,
    budgets,
    used,
    summary,
    results,
    remaining,
    recipe: current,
    dockerfile: renderDockerfile(current),
    warnings,
  };
  if (paused) log(`NEEDS YOU at step ${paused.step.n}`);
  if (options.save !== false) await store.save('surgeon', report);
  if (options.outDir) {
    await mkdir(options.outDir, { recursive: true });
    await writeFile(path.join(options.outDir, 'Dockerfile.necromancer'), report.dockerfile);
    await writeFile(path.join(options.outDir, 'docker-compose.necromancer.yml'), renderCompose(current, saved.resurrect.services, budgets.limits));
  }
  return report;
}

/** The saved surgeon run to resume; throws unless it is waiting on the owner. */
function pausedRun(saved: LoadedInputs, source: string): SurgeonReport {
  const from = saved.surgeon;
  if (from?.status !== 'needs-you' || !from.resume) {
    throw new Error(`no surgeon run is waiting on you for ${source}; start one without --resume`);
  }
  return from;
}

/**
 * The paused run's planned steps, in plan order, after checking that the reports it started from are still the ones
 * saved and that planning again gives exactly the same steps (ids, ops and skip reasons).
 */
function checkUnchanged(from: SurgeonReport, basedOn: SurgeonReport['basedOn'], fresh: SurgeonStep[]): SurgeonStep[] {
  const planned = [...from.results.map((r) => r.step), ...from.remaining].sort((a, b) => a.n - b.n);
  const same =
    from.basedOn.graveyard === basedOn.graveyard &&
    from.basedOn.resurrect === basedOn.resurrect &&
    from.basedOn.witness === basedOn.witness &&
    from.remaining[0]?.n === from.resume!.step &&
    JSON.stringify(planned) === JSON.stringify(fresh);
  if (!same) throw new Error('the saved reports changed since surgeon paused; start a new surgeon run');
  return planned;
}

function defined<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}
