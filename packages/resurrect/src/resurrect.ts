import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AppliedFix,
  BuildRecipe,
  ExhumeReport,
  GraveyardReport,
  FixRisk,
  InterviewReport,
  OwnerDecision,
  PendingDecision,
  PendingQuestion,
  RecipeOp,
  ResurrectAttempt,
  ResurrectPhase,
  ResurrectReport,
  ResurrectRunSettings,
  ResurrectRunState,
  SandboxLimits,
  SandboxSettings,
} from '@necromancer/core';
import { errorMessage } from '@necromancer/core';
import { checkout, headCommit, listRepoFiles, readHistory } from '@necromancer/excavate';
import type { StructuredModel } from '@necromancer/llm';
import { proposeFix } from './agent.js';
import { fixRisks } from './approval.js';
import { DEFAULT_LIMITS, renderCompose } from './compose.js';
import { bootServices, chooseNode, detectServices, imageRepoFor, initialRecipe, readFacts, type ProjectFacts } from './detect.js';
import { DEFAULT_HEALTH_TIMEOUT_SEC, type Sandbox, type StepResult } from './docker.js';
import { errorSignature, findKnownFix, FixCache, tail } from './fixes.js';
import { applyOps, changesRecipe, patchManifest, renderDockerfile } from './recipe.js';

export const DEFAULT_MAX_ITERATIONS = 10;
export const DEFAULT_TOKEN_BUDGET = 150_000;
/** Questions the owner answers about one failure before the run gives up on it. */
export const MAX_OWNER_QUESTIONS = 3;
/** Fixes the owner declines for one failure before the run gives up on it. */
export const MAX_OWNER_DECLINES = 3;

/** What the owner is shown before a risky fix is applied. */
export interface ApprovalRequest {
  attempt: number;
  phase: ResurrectPhase;
  fix: AppliedFix;
  risks: FixRisk[];
  /** The last lines of the failing step's log. */
  errorExcerpt: string;
}

/**
 * The answer to an `ApprovalRequest`: 'approve' is the owner's OK; 'auto-approve' applies it too, but records the
 * decision as automatic (by "auto"), for a blanket approval such as `--yes` that nobody gave for this fix in particular;
 * 'reject' looks for another fix; 'pause' ends the run as needs-you.
 */
export type ApprovalAnswer = 'approve' | 'auto-approve' | 'reject' | 'pause';

/** A question the model asked about a failure, with the attempt that failed. */
export type OwnerQuestion = PendingQuestion & { attempt: number };

/**
 * Carry on from a needs-you report, with the owner's answer to its pending decision. `run` comes from `checkResumable`,
 * which a front-end calls before asking the owner; `prepareResume` makes the whole input in one call.
 */
export interface ResumeInput {
  run: ResumableRun;
  /** For a pending approval: apply the fix, or decline it and look for another. */
  approve?: boolean;
  /** For a pending question: the owner's answer. */
  answer?: string;
}

/** What a resume can change of a paused run's settings. Everything left out stays as the paused run had it. */
export interface ResumeOverrides {
  /**
   * Attempts in total for the resumed run, replacing the limit the paused run had. Left out, the paused run's
   * limit stands. Either way the resumed run gets at least one attempt to try the fix it settles on.
   */
  maxIterations?: number;
  /** Token budget for the whole run, replacing the paused run's. Left out, the paused run's budget stands. */
  tokenBudget?: number;
  /** Sandbox limits to change for the resumed run; the rest stay as the paused run had them. */
  limits?: Partial<SandboxLimits>;
  /**
   * The model to ask for fixes, by name, replacing the paused run's; null runs on known and cached fixes only.
   * The model handed to `checkResumable` and `resurrect` must then be that model (or none for null).
   */
  model?: string | null;
  /** Whether to keep the built images, replacing the paused run's choice. */
  keepImages?: boolean;
  /** Where to clone remote repos, replacing the paused run's; null for the default temp directory. */
  workdir?: string | null;
  /**
   * How the sandbox is set up for the resumed run, where it differs from the paused run's; the rest stays. The resumed
   * run saves the result, so a later pause keeps it. The sandbox handed in should be set up this way.
   */
  sandbox?: Partial<SandboxSettings>;
}

/**
 * Everything besides the repo that defines a run: the saved `ResurrectRunSettings` plus the sandbox limits. A fresh
 * run takes it from `ResurrectOptions`; a resume takes it from the paused run, changed only by the `ResumeOverrides`
 * the caller gives.
 */
export interface RunSettings extends ResurrectRunSettings {
  limits: SandboxLimits;
}

/** A paused run checked by `checkResumable`: the report, what it waits on, its state, and the settings the resumed run has. */
export interface ResumableRun {
  from: ResurrectReport;
  pending: PendingDecision;
  state: ResurrectRunState;
  settings: RunSettings;
}

export interface ResurrectOptions {
  sandbox: Sandbox;
  /**
   * Asked for a fix when the known-fix table and the cache have none. null runs table-only, as does a token budget
   * of 0. When resuming, it must be the model the resumed run's settings name (`resume.run.settings.model`), or none
   * when they name none.
   */
  model?: StructuredModel | null;
  /** Attempts in total. When resuming, the paused run's limit is kept instead; `resume.maxIterations` changes it. */
  maxIterations?: number;
  /** Input plus output tokens the model may spend across the whole run. When resuming, as `maxIterations`. */
  tokenBudget?: number;
  /** When resuming, the paused run's limits are kept instead; `resume.limits` changes them. */
  limits?: Partial<SandboxLimits>;
  /**
   * Earlier reports, if saved: the era comes from graveyard, the project's intent and the owner's goals from interview.
   * When resuming, none is read: the paused run's era and interview are used instead.
   */
  exhume?: ExhumeReport | null;
  graveyard?: GraveyardReport | null;
  interview?: InterviewReport | null;
  /** Fixes the model found before, by error signature. */
  fixCache?: FixCache;
  /** CA certificate for a TLS-intercepting proxy during install. When resuming, the paused run's is used instead. */
  caFile?: string;
  /** Where remote repos are cloned. When resuming, the paused run's is used unless `resume.workdir` changes it. */
  workdir?: string;
  /** Keep the images, e.g. to run the result yourself. When resuming, as `workdir`. */
  keepImages?: boolean;
  onProgress?: (message: string) => void;
  /**
   * Asked before applying a cached or model fix that `fixRisks` flags. Known fixes are built in and trusted: they are
   * applied without asking, and recorded as decisions by "auto" when they are risky. Without it every fix is applied,
   * and the risky ones are recorded by "auto" too.
   */
  approve?: (request: ApprovalRequest) => Promise<ApprovalAnswer>;
  /** Asked when the model needs the owner's answer to go on. null, or no callback, ends the run as needs-you. */
  ask?: (question: OwnerQuestion) => Promise<string | null>;
  /** Carry on from a paused run, from `prepareResume` (or `checkResumable` and the owner's answer). */
  resume?: ResumeInput;
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];

/** A failed attempt that needs a fix. `log` is the tail the fix is chosen from. */
interface Failure {
  attempt: ResurrectAttempt;
  phase: ResurrectPhase;
  signature: string;
  log: string;
}

/** What is known while looking for a fix for one failure. Declined fixes are tracked for the whole run instead. */
interface Turn {
  rejected?: string;
  answer?: string;
  /** The fixes the owner declined, for the blocked message. */
  declined: string[];
  /** Questions the owner answered so far. */
  questions: number;
  /** Fixes the owner declined so far. */
  declines: number;
}

type Settled =
  | { kind: 'apply'; fix: AppliedFix }
  | { kind: 'blocked'; reason: string }
  | { kind: 'pause'; pending: PendingDecision; turn: Turn };

/**
 * The key a declined fix is remembered by, whatever its source. Two fixes get the same key when they have the same
 * effect on a recipe (`applyOps`): optional fields count as their defaults; apt packages and install flags are one set
 * however they are split across ops or ordered; repeated ops count once; of the ops that set one thing (the image, a
 * variable, a dependency, a command, the port) only the last counts; and the ops' order does not matter, except that
 * the commands run before install keep theirs.
 */
export const opsKey = (ops: RecipeOp[]): string => `ops:${canonicalJson(normalizeOps(ops))}`;

function normalizeOps(ops: RecipeOp[]): RecipeOp[] {
  const packages = new Set<string>();
  const flags = new Set<string>();
  const globals = new Set<string>();
  const commands: string[] = [];
  // The last op for each thing an op sets, by what it sets; flags (useDebianArchive, dropLockfile) count once.
  const last = new Map<string, RecipeOp>();
  for (const op of ops) {
    switch (op.op) {
      case 'aptInstall':
        op.packages.forEach((p) => packages.add(p));
        break;
      case 'addInstallFlags':
        op.flags.forEach((f) => flags.add(f));
        break;
      case 'globalInstall':
        globals.add(op.spec);
        break;
      case 'runBeforeInstall':
        if (!commands.includes(op.command)) commands.push(op.command);
        break;
      case 'setNodeImage':
        last.set(op.op, { op: op.op, tag: op.tag });
        break;
      case 'setEnv':
        last.set(`env:${op.name}`, { op: op.op, name: op.name, value: op.value });
        break;
      // Both write the same dependency patch.
      case 'setDependency':
        last.set(`dep:${op.name}`, { op: op.op, name: op.name, version: op.version, dev: op.dev ?? false });
        break;
      case 'removeDependency':
        last.set(`dep:${op.name}`, { op: op.op, name: op.name });
        break;
      case 'setBuildCommand':
      case 'setStartCommand':
        last.set(op.op, { op: op.op, command: op.command });
        break;
      case 'setPort':
        last.set(op.op, { op: op.op, port: op.port });
        break;
      case 'useDebianArchive':
      case 'dropLockfile':
        last.set(op.op, { op: op.op });
        break;
    }
  }
  const sorted = [...last.values()];
  if (packages.size) sorted.push({ op: 'aptInstall', packages: [...packages].sort() });
  if (flags.size) sorted.push({ op: 'addInstallFlags', flags: [...flags].sort() });
  for (const spec of globals) sorted.push({ op: 'globalInstall', spec });
  const keyed = sorted.map((op) => [canonicalJson(op), op] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [...keyed.map(([, op]) => op), ...commands.map((command) => ({ op: 'runBeforeInstall' as const, command }))];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Phase 5: the build-fix loop. Each attempt installs (the only step with network), runs the build script and
 * boots the app in the sandbox. After a failure, the next change comes from the known-fix table, then the fix
 * cache, then the model; with none, or out of attempts or tokens, the run ends "BLOCKED: <reason>". A risky cached
 * or model fix waits for `approve`, and a question from the model for `ask`; without an answer the run ends
 * needs-you, and `resume` carries on from that report.
 */
export async function resurrect(source: string, options: ResurrectOptions): Promise<ResurrectReport> {
  // The structural checks ran in `checkResumable`; only the answer, and that the model is the one checked, are left.
  const resumed = options.resume ? checkDecision(options.resume, options.model ?? null) : null;
  const settings = resumed?.settings ?? runSettings(options);
  const { maxIterations, tokenBudget: budget, limits } = settings;
  const caFile = settings.caFile ?? undefined;
  const workdir = settings.workdir ?? undefined;
  // The settings name the model to ask; a model handed in for a run that names none (a budget of 0) is not asked.
  const model = settings.model ? options.model! : null;
  const log = options.onProgress ?? (() => {});
  const cache = options.fixCache ?? new FixCache(null);
  const sandbox = options.sandbox;
  // What the model is told about the project; a resume tells it what the paused run did.
  const interview: ResurrectRunState['interview'] = resumed
    ? (resumed.state.interview ?? null)
    : options.interview
      ? { intent: options.interview.intent, goals: options.interview.goals.map((g) => g.text) }
      : null;

  await sandbox.ping();
  log(`checking out ${source}`);
  const repo = await checkout(source, { workdir });
  const context = await mkdtemp(path.join(workdir ?? os.tmpdir(), 'necromancer-context-'));
  try {
    const files = await listRepoFiles(repo.root);
    const facts = await readFacts(repo.root, files);
    const commit = await headCommit(repo.root);
    // A resume carries on with the paused run's era, services and recipe; reports saved since are not consulted again.
    let era: { date: string | null; why: string };
    let services: ResurrectReport['services'];
    let recipe: BuildRecipe;
    if (resumed) {
      era = { date: resumed.from.era.date, why: resumed.from.era.why };
      services = structuredClone(resumed.from.services);
      recipe = structuredClone(resumed.from.recipe);
    } else {
      const eraDate =
        options.graveyard?.era.estimate ?? options.graveyard?.era.died ?? options.exhume?.history.lastCommit ?? (await readHistory(repo.root)).lastCommit;
      const node = chooseNode(facts, eraDate);
      era = { date: eraDate?.slice(0, 10) ?? null, why: node.why };
      services = detectServices(facts, eraDate);
      recipe = initialRecipe(facts, node.tag, services);
    }
    log(`era ${era.date?.slice(0, 7) ?? 'unknown'}: ${era.why}; services: ${services.map((s) => s.image).join(', ') || 'none'}`);

    const attempts: ResurrectAttempt[] = resumed ? structuredClone(resumed.from.attempts) : [];
    const warnings: string[] = resumed ? [...resumed.from.warnings] : [];
    if (resumed && settings.sandbox && sandbox.settings && !sameSandbox(settings.sandbox, sandbox.settings)) {
      warnings.push(
        `the sandbox is set up differently from the paused run's (${describeSandbox(sandbox.settings)}, was ${describeSandbox(settings.sandbox)})`,
      );
    }
    const pausedAt = resumed?.from.repo.commit ?? null;
    if (pausedAt && commit && pausedAt !== commit) {
      warnings.push(
        `the repo changed since the run paused (${pausedAt.slice(0, 7)} → ${commit.slice(0, 7)}); the saved recipe was diagnosed against the old commit`,
      );
    }
    // Decisions saved before `by` existed were all the owner's.
    const decisions: OwnerDecision[] = resumed ? (resumed.from.decisions ?? []).map((d) => ({ ...d, by: d.by ?? 'owner' })) : [];
    let tokens = resumed?.state.tokens ?? 0;
    let calls = resumed?.state.calls ?? 0;
    let health: ResurrectReport['health'] = null;
    let blockedReason: string | null = null;
    let pending = null as PendingDecision | null;
    let runState: ResurrectRunState | null = null;

    const report = (): ResurrectReport => ({
      repo: { source, commit },
      generatedAt: new Date().toISOString(),
      outcome: health ? 'resurrected' : pending ? 'needs-you' : 'blocked',
      blockedReason: health || pending ? null : blockedReason,
      pending,
      resume: runState,
      decisions,
      health,
      era: { date: era.date, node: recipe.nodeImage, why: era.why },
      services,
      recipe,
      // The proxy CA was only for this machine's install step; the saved Dockerfile stays portable.
      dockerfile: renderDockerfile(recipe),
      compose: renderCompose(recipe, services, limits),
      limits,
      attempts,
      llm: { model: settings.model, calls, tokens, budget },
      warnings,
    });

    if (!facts.manifest) {
      blockedReason = 'no package.json at the repository root, so there is nothing to install';
      return report();
    }

    // The sandbox gets a copy of the repo; the checkout is never modified.
    const manifest = facts.manifest;
    const dependencies = { ...asRecord(manifest.devDependencies), ...asRecord(manifest.dependencies) };
    const devOnly = new Set(Object.keys(asRecord(manifest.devDependencies)).filter((d) => !(d in asRecord(manifest.dependencies))));
    const build = await BuildContext.copy(repo.root, context, manifest);
    const tagBase = imageRepoFor(source);

    // A model fix waiting to be cached once it gets past its error.
    let pendingLlmFix = null as { signature: string; fix: AppliedFix } | null;
    const seen = new Map<string, number>(Object.entries(resumed?.state.seen ?? {}));
    // Every fix the owner declined in this run, by opsKey: none with the same effect comes back, from any source. A fix
    // is matched by what it would do now, never by its id, since a known fix's ops depend on the recipe.
    const declinedFixes = new Set<string>(resumed?.state.declinedFixes ?? []);
    const isDeclined = (ops: RecipeOp[]) => declinedFixes.has(opsKey(ops));

    const decideQuestion = (attempt: number, question: string, answer: string) =>
      decisions.push({ attempt, kind: 'question', by: 'owner', subject: question, answer, at: new Date().toISOString() });
    const decideFix = (attempt: number, by: OwnerDecision['by'], fix: AppliedFix, risks: FixRisk[], approved: boolean) =>
      decisions.push({
        attempt,
        kind: 'approval',
        by,
        subject: fix.id,
        answer: approved ? 'approved' : 'rejected',
        description: fix.description,
        risks,
        at: new Date().toISOString(),
      });

    /** One candidate fix for a failure: the known-fix table, then the cache, then the model. */
    const propose = async (
      f: Failure,
      turn: Turn,
    ): Promise<{ kind: 'fix'; fix: AppliedFix } | { kind: 'question'; question: PendingQuestion } | { kind: 'blocked'; reason: string }> => {
      const n = f.attempt.n;
      const lastError = firstError(f.log);
      const ctx = { phase: f.phase, log: f.log, recipe, dependencies, devOnly };
      // The first fix the owner already declined that would otherwise have been offered, for the blocked message.
      let passedOver: string | null = null;
      const known = findKnownFix(ctx, (k, ops) => {
        const declined = isDeclined(ops);
        if (declined) passedOver ??= k.id;
        return declined;
      });
      if (known) return { kind: 'fix', fix: { source: 'known', id: known.fix.id, description: known.fix.description, ops: known.ops } };
      const cacheId = `cache:${f.signature}`;
      const cached = await cache.get(f.signature);
      if (cached && changesRecipe(recipe, cached.ops)) {
        if (!isDeclined(cached.ops)) return { kind: 'fix', fix: { source: 'cache', id: cacheId, ...cached } };
        passedOver ??= cacheId;
      }
      if (!model) {
        const reason = turn.declined.length
          ? `the owner declined ${turn.declined.at(-1)} and there is no other fix for: ${lastError}`
          : passedOver
            ? `the owner declined ${passedOver} earlier in this run and there is no other fix for: ${lastError}`
            : `${f.phase} failed and no known fix matches (no model configured): ${lastError}`;
        return { kind: 'blocked', reason };
      }
      let rejected = turn.rejected;
      // Once the owner has answered as many questions as they will about this failure, the model may not ask another.
      const canAsk = turn.questions < MAX_OWNER_QUESTIONS;
      for (let ask = 0; ask < 2; ask++) {
        if (tokens >= budget) return { kind: 'blocked', reason: `token budget of ${budget} spent; last error at ${f.phase}: ${lastError}` };
        log(`attempt ${n}: ${turn.answer ? 'passing the owner’s answer to' : 'no known fix, asking'} ${model.name}`);
        calls++;
        let answer: Awaited<ReturnType<typeof proposeFix>>;
        try {
          answer = await proposeFix(model, {
            phase: f.phase,
            errorTail: f.log,
            recipe,
            dockerfile: renderDockerfile(recipe),
            dependencies,
            history: attempts,
            interview,
            rejected,
            decisions,
            answer: turn.answer,
            canAsk,
          });
        } catch (err) {
          return { kind: 'blocked', reason: `could not ask ${model.name} for a fix (${errorMessage(err)}); last error at ${f.phase}: ${lastError}` };
        }
        const { proposal, tokens: used } = answer;
        tokens += used;
        try {
          if (proposal.decision === 'blocked') return { kind: 'blocked', reason: proposal.blockedReason?.trim() || proposal.diagnosis.trim() };
          if (proposal.decision === 'ask') {
            const question = proposal.question?.trim();
            if (!question) throw new Error('it asked the owner without a question');
            const context = `${proposal.diagnosis.trim()} Failing line: ${lastError}`;
            return { kind: 'question', question: { kind: 'question', question, context, choices: proposal.choices } };
          }
          if (isDeclined(proposal.ops)) throw new Error('the owner already declined that fix');
          if (!changesRecipe(recipe, proposal.ops)) {
            applyOps(recipe, proposal.ops); // surfaces validation errors
            throw new Error('it changes nothing that was not already tried');
          }
          return { kind: 'fix', fix: { source: 'llm', id: `llm:${f.signature}`, description: proposal.diagnosis, ops: proposal.ops } };
        } catch (err) {
          rejected = errorMessage(err);
          warnings.push(`attempt ${n}: rejected a proposed fix (${rejected})`);
        }
      }
      return { kind: 'blocked', reason: `the model proposed no usable fix for: ${lastError}` };
    };

    const decline = (f: Failure, turn: Turn, fix: AppliedFix): Turn => {
      log(`attempt ${f.attempt.n}: the owner declined ${fix.source} fix: ${fix.description}`);
      declinedFixes.add(opsKey(fix.ops));
      return {
        rejected: `the owner declined it: ${fix.description}`,
        answer: turn.answer,
        declined: [...turn.declined, fix.source === 'llm' ? `"${fix.description}"` : fix.id],
        questions: turn.questions,
        declines: turn.declines + 1,
      };
    };

    /**
     * Finds the fix to apply for a failure, asking the owner where needed, or says why the run must stop.
     * Every fix found is either applied or shown to the owner; only further questions and further proposals after
     * the owner has had enough are cut off.
     */
    const settle = async (f: Failure, turn: Turn): Promise<Settled> => {
      for (;;) {
        if (turn.declines >= MAX_OWNER_DECLINES) {
          return {
            kind: 'blocked',
            reason: `the owner declined ${turn.declines} fixes for this failure (${turn.declined.join(', ')}): ${firstError(f.log)}`,
          };
        }
        const found = await propose(f, turn);
        if (found.kind === 'blocked') return found;
        if (found.kind === 'question') {
          if (turn.questions >= MAX_OWNER_QUESTIONS) {
            return { kind: 'blocked', reason: `asked the owner ${turn.questions} questions about this failure and still no fix: ${firstError(f.log)}` };
          }
          const reply = options.ask ? await options.ask({ ...found.question, attempt: f.attempt.n }) : null;
          if (!reply?.trim()) return { kind: 'pause', pending: found.question, turn };
          decideQuestion(f.attempt.n, found.question.question, reply);
          turn = { ...turn, rejected: undefined, answer: reply, questions: turn.questions + 1 };
          continue;
        }
        const { fix } = found;
        const risks = fixRisks(recipe, fix.ops);
        if (!risks.length) return { kind: 'apply', fix };
        // Known fixes are curated and trusted, so they never wait; nor does anything when nobody is set up to approve.
        // Either way the risks are logged and the fix is recorded as applied without asking.
        if (fix.source === 'known' || !options.approve) {
          log(`attempt ${f.attempt.n}: applying ${fix.source} fix ${fix.id} without asking, though it ${risks.map((r) => r.reason).join('; ')}`);
          decideFix(f.attempt.n, 'auto', fix, risks, true);
          return { kind: 'apply', fix };
        }
        const errorExcerpt = f.attempt.errorExcerpt ?? tail(f.log, 40);
        const verdict = await options.approve({ attempt: f.attempt.n, phase: f.phase, fix, risks, errorExcerpt });
        if (verdict === 'pause') return { kind: 'pause', pending: { kind: 'approval', fix, risks }, turn };
        const approved = verdict === 'approve' || verdict === 'auto-approve';
        decideFix(f.attempt.n, verdict === 'auto-approve' ? 'auto' : 'owner', fix, risks, approved);
        if (approved) return { kind: 'apply', fix };
        turn = decline(f, turn, fix);
      }
    };

    /** Applies a settled fix, or records why the run stops. Returns whether to make another attempt. */
    const conclude = (f: Failure, settled: Settled): boolean => {
      if (settled.kind === 'blocked') {
        blockedReason = settled.reason;
        return false;
      }
      if (settled.kind === 'pause') {
        const { turn } = settled;
        pending = settled.pending;
        runState = {
          nextAttempt: f.attempt.n + 1,
          failure: { attempt: f.attempt.n, phase: f.phase, signature: f.signature, log: f.log },
          seen: Object.fromEntries(seen),
          tokens,
          calls,
          declinedFixes: [...declinedFixes],
          declined: turn.declined,
          answer: turn.answer ?? null,
          questions: turn.questions,
          declines: turn.declines,
          interview,
          settings: savedSettings(settings),
        };
        return false;
      }
      const { fix } = settled;
      log(`attempt ${f.attempt.n}: applying ${fix.source} fix: ${fix.description}`);
      f.attempt.fix = fix;
      recipe = applyOps(recipe, fix.ops);
      // Once the owner has answered a question, the model's fixes may rest on it and be specific to this project, so
      // none from the rest of the run goes into the shared cache. The decisions carry over a pause, so this does too.
      if (fix.source === 'llm' && !decisions.some((d) => d.kind === 'question' && d.by === 'owner')) pendingLlmFix = { signature: f.signature, fix };
      return true;
    };

    try {
      let first = 1;
      let go = true;
      if (resumed) {
        const { pending: waiting, state } = resumed;
        const attempt = attempts.find((a) => a.n === state.failure.attempt);
        if (!attempt) throw new Error(`the saved report has no attempt ${state.failure.attempt} to resume from`);
        const f: Failure = { attempt, phase: state.failure.phase, signature: state.failure.signature, log: state.failure.log };
        const turn: Turn = { declined: state.declined, answer: state.answer ?? undefined, questions: state.questions, declines: state.declines };
        log(`resuming after attempt ${attempt.n}`);
        let settled: Settled;
        if (waiting.kind === 'approval') {
          decideFix(attempt.n, 'owner', waiting.fix, waiting.risks, resumed.approve!);
          settled = resumed.approve ? { kind: 'apply', fix: waiting.fix } : await settle(f, decline(f, turn, waiting.fix));
        } else {
          const answer = resumed.answer!;
          decideQuestion(attempt.n, waiting.question, answer);
          settled = await settle(f, { ...turn, rejected: undefined, answer, questions: turn.questions + 1 });
        }
        go = conclude(f, settled);
        first = state.nextAttempt;
      }

      for (let n = first; go && n <= maxIterations; n++) {
        await build.write(recipe, caFile);
        const started = Date.now();
        const tag = `${tagBase}:attempt-${n}`;
        log(`attempt ${n}/${maxIterations}: installing on ${recipe.nodeImage}`);

        let phase: ResurrectPhase = 'install';
        let step: StepResult = await sandbox.install(context, tag, limits);
        let image = tag;
        if (step.ok && recipe.buildCommand) {
          phase = 'build';
          log(`attempt ${n}: ${recipe.buildCommand} (no network)`);
          image = `${tag}-built`;
          step = await sandbox.run(tag, recipe.buildCommand, recipe.env, limits, image);
        }
        if (step.ok) {
          phase = 'boot';
          if (recipe.startCommand) {
            log(`attempt ${n}: booting \`${recipe.startCommand}\`${services.length ? ` with ${services.map((s) => s.kind).join(', ')}` : ''}`);
            const boot = await sandbox.boot(image, {
              command: recipe.startCommand,
              env: recipe.env,
              port: recipe.port,
              services: bootServices(services),
              limits,
            });
            step = boot;
            if (boot.ok) health = boot.health;
          } else {
            log(`attempt ${n}: no start command, so treating it as a library and loading it`);
            step = await sandbox.run(image, `node -e "require('./')"`, recipe.env, limits);
            if (step.ok) health = { kind: 'library', detail: "installed, built and require('.') loads" };
          }
        }

        const attempt: ResurrectAttempt = {
          n,
          phase,
          ok: step.ok,
          durationMs: Date.now() - started,
          signature: step.ok ? null : errorSignature(phase, step.log),
          errorExcerpt: step.ok ? null : tail(step.log, 40),
          fix: null,
        };
        attempts.push(attempt);

        // A model fix that got us past its error is worth remembering.
        if (pendingLlmFix && attempt.signature !== pendingLlmFix.signature) {
          await cache.remember(pendingLlmFix.signature, { description: pendingLlmFix.fix.description, ops: pendingLlmFix.fix.ops });
        }
        pendingLlmFix = null;

        if (step.ok) {
          log(`resurrected after ${n} attempt${n === 1 ? '' : 's'}: ${health!.detail}`);
          break;
        }
        const signature: string = attempt.signature!;
        seen.set(signature, (seen.get(signature) ?? 0) + 1);
        log(`attempt ${n} failed at ${phase}: ${firstError(step.log)}`);
        if (seen.get(signature)! >= 3) {
          blockedReason = `the same ${phase} error came back after ${seen.get(signature)! - 1} fixes: ${firstError(step.log)}`;
          break;
        }
        if (n === maxIterations) {
          blockedReason = `still failing after ${maxIterations} attempts; last error at ${phase}: ${firstError(step.log)}`;
          break;
        }
        const failure: Failure = { attempt, phase, signature, log: tail(step.log, 120) };
        if (!conclude(failure, await settle(failure, { declined: [], questions: 0, declines: 0 }))) break;
      }
    } finally {
      if (!settings.keepImages) await sandbox.cleanup();
    }
    if (!health && !blockedReason && !pending) {
      blockedReason = attempts.length ? `out of attempts: ${maxIterations} allowed, ${attempts.length} made` : 'no attempts were made';
    }
    if (pending) log(`NEEDS YOU: ${pending.kind === 'question' ? pending.question : `approve ${pending.fix.description}`}`);
    else if (!health) log(`BLOCKED: ${blockedReason}`);
    return report();
  } finally {
    await rm(context, { recursive: true, force: true });
    await repo.cleanup();
  }
}

type SettingsOptions = Pick<ResurrectOptions, 'model' | 'maxIterations' | 'tokenBudget' | 'limits' | 'caFile' | 'keepImages' | 'workdir'> & {
  sandbox?: Pick<Sandbox, 'settings'>;
};

/**
 * Why a saved report can't be resumed as asked, from `checkResumable` and `prepareResume` (and, for the model and the
 * answer, `resurrect` with `resume`), so a front-end can say what to change without repeating the checks:
 * - `not-paused`: the run did not end needs-you;
 * - `no-state`: it did, but the report lacks the pending decision or the state to carry on from;
 * - `model-without-budget`: the resume names a model, but the token budget is 0, so none would be asked;
 * - `budget-spent`: a pending question needs a model, and the budget is spent;
 * - `no-model`: a pending question needs a model, and the resumed run's settings name none;
 * - `model-null`: the settings name a model, and none was handed in;
 * - `model-mismatch`: a model was handed in that the settings don't name (another one, or one where they name none);
 * - `wrong-kind`: an approval for a pending question, or an answer for a pending fix;
 * - `needs-approve`: a pending fix, and no approve true or false;
 * - `needs-answer`: a pending question, and no answer.
 */
export class ResumeError extends Error {
  constructor(
    readonly code:
      | 'not-paused'
      | 'no-state'
      | 'model-without-budget'
      | 'budget-spent'
      | 'no-model'
      | 'model-null'
      | 'model-mismatch'
      | 'wrong-kind'
      | 'needs-approve'
      | 'needs-answer',
    message: string,
  ) {
    super(message);
    this.name = 'ResumeError';
  }
}

/** A fresh run's settings, from its options. A budget of 0 means no model is asked, so the settings name none. */
function runSettings(options: SettingsOptions): RunSettings {
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  return {
    maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    tokenBudget,
    limits: { ...DEFAULT_LIMITS, ...defined(options.limits) },
    model: tokenBudget > 0 ? (options.model?.name ?? null) : null,
    caFile: options.caFile ?? null,
    sandbox: options.sandbox?.settings ?? null,
    keepImages: options.keepImages ?? false,
    // Saved with the report for a resume, so made absolute.
    workdir: options.workdir ? path.resolve(options.workdir) : null,
  };
}

/** What a paused run saves of its settings; the limits are saved as the report's own. */
function savedSettings({ limits: _limits, ...settings }: RunSettings): ResurrectRunSettings {
  return settings;
}

/** What a needs-you report waits on and the state to carry on from; throws a readable error for any other report. */
function pausedRun(from: ResurrectReport): { pending: PendingDecision; state: ResurrectRunState } {
  if (from.outcome !== 'needs-you') {
    throw new ResumeError('not-paused', `only a run that is waiting on the owner (needs-you) can be resumed; this one ended ${from.outcome}`);
  }
  if (!from.pending || !from.resume) {
    throw new ResumeError('no-state', 'the saved run is waiting on the owner but is missing the state it needs to carry on; start a new run instead');
  }
  return { pending: from.pending, state: from.resume };
}

/**
 * The settings a resume of `from` will run with: the paused run's, changed only by the overrides given. Nothing is
 * checked but that `from` is a paused run, so a front-end can build its sandbox, and the model the settings name
 * (none when `model` is null), before validating with `checkResumable`.
 */
export function resumeSettings(from: ResurrectReport, overrides: ResumeOverrides = {}): RunSettings {
  const { settings: saved, nextAttempt } = pausedRun(from).state;
  const tokenBudget = overrides.tokenBudget ?? saved.tokenBudget;
  const model = overrides.model !== undefined ? overrides.model : saved.model;
  const workdir = overrides.workdir !== undefined ? overrides.workdir : saved.workdir;
  const sandbox = defined(overrides.sandbox);
  return {
    // A resume that settles on a fix gets at least the attempt that tries it.
    maxIterations: Math.max(overrides.maxIterations ?? saved.maxIterations, nextAttempt),
    tokenBudget,
    limits: { ...DEFAULT_LIMITS, ...from.limits, ...defined(overrides.limits) },
    model: tokenBudget > 0 ? model : null,
    caFile: saved.caFile,
    // A paused run whose sandbox did not say how it was set up counts as the defaults when the resume changes one.
    sandbox: Object.keys(sandbox).length
      ? { ...(saved.sandbox ?? { buildProxy: false, healthTimeoutSec: DEFAULT_HEALTH_TIMEOUT_SEC }), ...sandbox }
      : saved.sandbox,
    keepImages: overrides.keepImages ?? saved.keepImages,
    workdir: workdir ? path.resolve(workdir) : null,
  };
}

function defined<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function sameSandbox(a: SandboxSettings, b: SandboxSettings): boolean {
  return a.buildProxy === b.buildProxy && a.healthTimeoutSec === b.healthTimeoutSec;
}

function describeSandbox(s: SandboxSettings): string {
  return `${s.buildProxy ? 'with' : 'without'} the build proxy, ${s.healthTimeoutSec}s health timeout`;
}

/**
 * Checks that a saved report is a paused run that can carry on, before anyone is asked for an answer: it is
 * waiting on the owner, has the state to resume from, is handed the model its settings name (or none when they
 * name none), and, for a pending question, has a model and budget left to turn the answer into a fix. Returns the
 * report, what it waits on and the settings the resumed run will have (`resumeSettings`), for `ResumeInput.run`.
 * Throws a `ResumeError` otherwise, whose code says which check failed; a resume naming a model with a token budget
 * of 0 fails too.
 */
export function checkResumable(from: ResurrectReport, options: Pick<ResurrectOptions, 'model'> & { resume?: ResumeOverrides } = {}): ResumableRun {
  const { pending, state } = pausedRun(from);
  const settings = resumeSettings(from, options.resume);
  const named = options.resume?.model;
  if (typeof named === 'string' && settings.tokenBudget <= 0) {
    throw new ResumeError('model-without-budget', `the resume names the model ${named}, but its token budget is 0, so no model would be asked; raise the budget`);
  }
  if (pending.kind === 'question') {
    if (settings.tokenBudget <= state.tokens) {
      throw new ResumeError(
        'budget-spent',
        `answering the pending question needs a model, but the token budget of ${settings.tokenBudget} is already spent (${state.tokens} used); raise the budget`,
      );
    }
    if (!settings.model) {
      throw new ResumeError('no-model', 'answering the pending question needs a model to turn the answer into a fix, and the resumed run has none (its model is null)');
    }
    if (!options.model) {
      throw new ResumeError(
        'model-null',
        `answering the pending question needs a model to turn the answer into a fix, and none is available; the resumed run asks ${settings.model}`,
      );
    }
  }
  checkModel(settings, options.model ?? null);
  return { from, pending, state, settings };
}

/** That the model handed in is the one the settings name, or none when they name none. */
function checkModel(settings: RunSettings, model: StructuredModel | null): void {
  const given = model?.name ?? null;
  if (given === settings.model) return;
  throw new ResumeError(
    given === null ? 'model-null' : 'model-mismatch',
    settings.model === null
      ? `the resumed run uses known and cached fixes only, but was handed the model ${given}; resume without a model, or name it in the resume's model`
      : given === null
        ? `the resumed run asks ${settings.model} for fixes, but was handed no model; pass that model, or resume with model null for known fixes only`
        : `the resumed run asks ${settings.model} for fixes, but was handed the model ${given}; pass ${settings.model}, or name ${given} in the resume's model`,
  );
}

/**
 * That a checked run is handed the model it was checked with, and that the resume answers what the run waits on:
 * approve for a fix, an answer for a question. Returns the run with the answer.
 */
function checkDecision(resume: ResumeInput, model: StructuredModel | null): ResumableRun & Pick<ResumeInput, 'approve' | 'answer'> {
  const { run, approve, answer } = resume;
  checkModel(run.settings, model);
  const { pending } = run;
  if (pending.kind === 'approval') {
    const fix = `${pending.fix.id} (${pending.fix.description})`;
    if (answer !== undefined) {
      throw new ResumeError('wrong-kind', `the run is waiting on a fix approval, not a question; pass approve true or false for ${fix}`);
    }
    if (typeof approve !== 'boolean') throw new ResumeError('needs-approve', `resuming needs a decision on the pending fix: approve or reject ${fix}`);
  } else {
    if (approve !== undefined) {
      throw new ResumeError('wrong-kind', `the run is waiting on an answer to a question, not a fix approval; pass an answer to: ${pending.question}`);
    }
    if (!answer?.trim()) throw new ResumeError('needs-answer', `resuming needs an answer to the pending question: ${pending.question}`);
  }
  return { ...run, approve, answer };
}

/**
 * `checkResumable` and the decision check in one call, for library use: the `ResumeInput` that carries `from` on
 * with the owner's answer. Pass the same `model` to `resurrect`. Throws a `ResumeError` as those checks do.
 */
export function prepareResume(
  from: ResurrectReport,
  options: { model?: StructuredModel | null; overrides?: ResumeOverrides; approve?: boolean; answer?: string } = {},
): ResumeInput {
  const run = checkResumable(from, { model: options.model, resume: options.overrides });
  const input: ResumeInput = { run, approve: options.approve, answer: options.answer };
  checkDecision(input, options.model ?? null);
  return input;
}

/** The sandbox's copy of the repo: everything but .git and node_modules, with the recipe's manifest and Dockerfile. */
export class BuildContext {
  private constructor(
    readonly dir: string,
    private readonly manifest: Record<string, unknown>,
    private readonly lockfiles: Map<string, string>,
  ) {}

  static async copy(root: string, dir: string, manifest: Record<string, unknown>): Promise<BuildContext> {
    await cp(root, dir, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules)([/\\]|$)/.test(src.slice(root.length)) });
    const lockfiles = new Map<string, string>();
    for (const f of LOCKFILES) {
      const text = await readFile(path.join(root, f), 'utf8').catch(() => null);
      if (text !== null) lockfiles.set(f, text);
    }
    return new BuildContext(dir, manifest, lockfiles);
  }

  async write(recipe: BuildRecipe, caFile?: string): Promise<void> {
    const dir = this.dir;
    await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(patchManifest(this.manifest, recipe), null, 2)}\n`);
    for (const [name, text] of this.lockfiles) {
      if (recipe.dropLockfile) await rm(path.join(dir, name), { force: true });
      else await writeFile(path.join(dir, name), text);
    }
    await writeFile(path.join(dir, 'Dockerfile.necromancer'), renderDockerfile(recipe, { caFile }));
    await writeFile(path.join(dir, '.dockerignore'), 'node_modules\n.git\n');
    if (caFile) {
      await rm(path.join(dir, '.necromancer'), { recursive: true, force: true });
      await cp(caFile, path.join(dir, '.necromancer', 'ca.crt'));
    }
  }
}

function asRecord(v: unknown): Record<string, string> {
  return v && typeof v === 'object' ? (v as Record<string, string>) : {};
}

/** The most telling line of a failure, for one-line summaries. */
export function firstError(log: string): string {
  const lines = tail(log, 60).split('\n');
  const hit =
    lines.find((l) => /npm ERR! (code|gyp|Failed|404|notarget|peer)|gyp ERR! (stack Error|find Python)|^E: |Error: |error /.test(l)) ??
    lines.findLast((l) => /(ERR!|error|Error|failed|not found)/i.test(l)) ??
    lines.at(-1) ??
    'no output';
  return hit.trim().slice(0, 240);
}

