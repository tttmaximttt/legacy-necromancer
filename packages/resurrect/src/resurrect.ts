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
  ResurrectRunState,
  SandboxLimits,
} from '@necromancer/core';
import { errorMessage } from '@necromancer/core';
import { checkout, headCommit, listRepoFiles, readHistory } from '@necromancer/excavate';
import type { StructuredModel } from '@necromancer/llm';
import { proposeFix } from './agent.js';
import { fixRisks } from './approval.js';
import { DEFAULT_LIMITS, renderCompose } from './compose.js';
import { bootServices, chooseNode, detectServices, imageRepoFor, initialRecipe, readFacts, type ProjectFacts } from './detect.js';
import type { Sandbox, StepResult } from './docker.js';
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

export type ApprovalAnswer = 'approve' | 'reject' | 'pause';

/** A question the model asked about a failure, with the attempt that failed. */
export type OwnerQuestion = PendingQuestion & { attempt: number };

/** Carry on from a needs-you report, with the owner's answer to its pending decision. */
export interface ResumeInput {
  from: ResurrectReport;
  /** For a pending approval: apply the fix, or decline it and look for another. */
  approve?: boolean;
  /** For a pending question: the owner's answer. */
  answer?: string;
  /**
   * Attempts in total for the resumed run, replacing the limit the paused run had. Left out, the paused run's
   * limit stands (or, for reports from before it was saved, `ResurrectOptions.maxIterations`). Either way the
   * resumed run gets at least one attempt to try the fix it settles on.
   */
  maxIterations?: number;
  /** Token budget for the whole run, replacing the paused run's. Left out, the paused run's budget stands. */
  tokenBudget?: number;
}

export interface ResurrectOptions {
  sandbox: Sandbox;
  /** Asked for a fix when the known-fix table and the cache have none. null runs table-only. */
  model?: StructuredModel | null;
  /** Attempts in total. When resuming, the paused run's limit is kept instead; `resume.maxIterations` changes it. */
  maxIterations?: number;
  /** Input plus output tokens the model may spend across the whole run. When resuming, as `maxIterations`. */
  tokenBudget?: number;
  limits?: Partial<SandboxLimits>;
  /** Earlier reports, if saved: the era comes from graveyard, the owner's goals from interview. */
  exhume?: ExhumeReport | null;
  graveyard?: GraveyardReport | null;
  interview?: InterviewReport | null;
  /** Fixes the model found before, by error signature. */
  fixCache?: FixCache;
  /** CA certificate for a TLS-intercepting proxy during install. */
  caFile?: string;
  workdir?: string;
  /** Keep the images, e.g. to run the result yourself. */
  keepImages?: boolean;
  onProgress?: (message: string) => void;
  /**
   * Asked before applying a fix that `fixRisks` flags, whatever its source. 'reject' looks for another fix,
   * 'pause' ends the run as needs-you. Without it every fix is applied.
   */
  approve?: (request: ApprovalRequest) => Promise<ApprovalAnswer>;
  /** Asked when the model needs the owner's answer to go on. null, or no callback, ends the run as needs-you. */
  ask?: (question: OwnerQuestion) => Promise<string | null>;
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

/** What is known while looking for a fix for one failure. */
interface Turn {
  /** Known/cache fix ids and model op lists the owner declined. */
  skip: Set<string>;
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
  | { kind: 'apply'; fix: AppliedFix; answered: boolean }
  | { kind: 'blocked'; reason: string }
  | { kind: 'pause'; pending: PendingDecision; turn: Turn };

/**
 * The key a declined model fix is remembered by: the same ops match whatever order their keys come in, and
 * whatever order apt packages or install flags are listed in.
 */
export const opsKey = (ops: RecipeOp[]): string =>
  `ops:${canonicalJson(
    ops.map((op) =>
      op.op === 'aptInstall' ? { ...op, packages: [...op.packages].sort() } : op.op === 'addInstallFlags' ? { ...op, flags: [...op.flags].sort() } : op,
    ),
  )}`;

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
 * cache, then the model; with none, or out of attempts or tokens, the run ends "BLOCKED: <reason>". A risky fix
 * waits for `approve`, and a question from the model for `ask`; without an answer the run ends needs-you, and
 * `resume` carries on from that report.
 */
export async function resurrect(source: string, options: ResurrectOptions): Promise<ResurrectReport> {
  const resumed = options.resume ? checkResume(options.resume, options) : null;
  const budget = resumed?.budget ?? options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  // A resume that settles on a fix gets at least the attempt that tries it.
  const maxIterations = resumed?.maxIterations ?? options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const log = options.onProgress ?? (() => {});
  const limits: SandboxLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const cache = options.fixCache ?? new FixCache(null);
  const sandbox = options.sandbox;

  await sandbox.ping();
  log(`checking out ${source}`);
  const repo = await checkout(source, { workdir: options.workdir });
  const context = await mkdtemp(path.join(options.workdir ?? os.tmpdir(), 'necromancer-context-'));
  try {
    const files = await listRepoFiles(repo.root);
    const facts = await readFacts(repo.root, files);
    const commit = await headCommit(repo.root);
    const eraDate =
      options.graveyard?.era.estimate ?? options.graveyard?.era.died ?? options.exhume?.history.lastCommit ?? (await readHistory(repo.root)).lastCommit;
    const node = chooseNode(facts, eraDate);
    const services = detectServices(facts, eraDate);
    let recipe = resumed ? structuredClone(resumed.from.recipe) : initialRecipe(facts, node.tag, services);
    log(`era ${eraDate?.slice(0, 7) ?? 'unknown'}: ${node.why}; services: ${services.map((s) => s.image).join(', ') || 'none'}`);

    const attempts: ResurrectAttempt[] = resumed ? structuredClone(resumed.from.attempts) : [];
    const warnings: string[] = resumed ? [...resumed.from.warnings] : [];
    const pausedAt = resumed?.from.repo.commit ?? null;
    if (pausedAt && commit && pausedAt !== commit) {
      warnings.push(
        `the repo changed since the run paused (${pausedAt.slice(0, 7)} → ${commit.slice(0, 7)}); the saved recipe was diagnosed against the old commit`,
      );
    }
    const decisions: OwnerDecision[] = resumed ? [...(resumed.from.decisions ?? [])] : [];
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
      era: { date: eraDate?.slice(0, 10) ?? null, node: recipe.nodeImage, why: node.why },
      services,
      recipe,
      // The proxy CA was only for this machine's install step; the saved Dockerfile stays portable.
      dockerfile: renderDockerfile(recipe),
      compose: renderCompose(recipe, services, limits),
      limits,
      attempts,
      llm: { model: options.model?.name ?? null, calls, tokens, budget },
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

    const decide = (attempt: number, kind: OwnerDecision['kind'], subject: string, answer: string, description?: string) =>
      decisions.push({ attempt, kind, subject, answer, ...(description !== undefined && { description }), at: new Date().toISOString() });

    /** One candidate fix for a failure: the known-fix table, then the cache, then the model. */
    const propose = async (
      f: Failure,
      turn: Turn,
    ): Promise<{ kind: 'fix'; fix: AppliedFix } | { kind: 'question'; question: PendingQuestion } | { kind: 'blocked'; reason: string }> => {
      const n = f.attempt.n;
      const lastError = firstError(f.log);
      const ctx = { phase: f.phase, log: f.log, recipe, dependencies, devOnly };
      const known = findKnownFix(ctx, turn.skip);
      if (known) return { kind: 'fix', fix: { source: 'known', id: known.id, description: known.description, ops: known.ops(ctx) } };
      const cacheId = `cache:${f.signature}`;
      const cached = turn.skip.has(cacheId) ? null : await cache.get(f.signature);
      if (cached && changesRecipe(recipe, cached.ops)) return { kind: 'fix', fix: { source: 'cache', id: cacheId, ...cached } };
      if (!options.model) {
        const reason = turn.declined.length
          ? `the owner declined ${turn.declined.at(-1)} and there is no other fix for: ${lastError}`
          : `${f.phase} failed and no known fix matches (no model configured): ${lastError}`;
        return { kind: 'blocked', reason };
      }
      let rejected = turn.rejected;
      for (let ask = 0; ask < 2; ask++) {
        if (tokens >= budget) return { kind: 'blocked', reason: `token budget of ${budget} spent; last error at ${f.phase}: ${lastError}` };
        log(`attempt ${n}: ${turn.answer ? 'passing the owner’s answer to' : 'no known fix, asking'} ${options.model.name}`);
        calls++;
        let answer: Awaited<ReturnType<typeof proposeFix>>;
        try {
          answer = await proposeFix(options.model, {
            phase: f.phase,
            errorTail: f.log,
            recipe,
            dockerfile: renderDockerfile(recipe),
            dependencies,
            history: attempts,
            interview: options.interview ?? null,
            rejected,
            decisions,
            answer: turn.answer,
          });
        } catch (err) {
          return { kind: 'blocked', reason: `could not ask ${options.model.name} for a fix (${errorMessage(err)}); last error at ${f.phase}: ${lastError}` };
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
          if (turn.skip.has(opsKey(proposal.ops))) throw new Error('the owner already declined that fix');
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
      return {
        skip: new Set(turn.skip).add(fix.source === 'llm' ? opsKey(fix.ops) : fix.id),
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
          decide(f.attempt.n, 'question', found.question.question, reply);
          turn = { ...turn, rejected: undefined, answer: reply, questions: turn.questions + 1 };
          continue;
        }
        const { fix } = found;
        const answered = turn.answer !== undefined;
        const risks = fixRisks(recipe, fix.ops);
        if (!risks.length || !options.approve) return { kind: 'apply', fix, answered };
        const errorExcerpt = f.attempt.errorExcerpt ?? tail(f.log, 40);
        const verdict = await options.approve({ attempt: f.attempt.n, phase: f.phase, fix, risks, errorExcerpt });
        if (verdict === 'pause') return { kind: 'pause', pending: { kind: 'approval', fix, risks }, turn };
        decide(f.attempt.n, 'approval', fix.id, verdict === 'approve' ? 'approved' : 'rejected', fix.description);
        if (verdict === 'approve') return { kind: 'apply', fix, answered };
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
          skip: [...turn.skip],
          declined: turn.declined,
          answer: turn.answer ?? null,
          questions: turn.questions,
          declines: turn.declines,
          maxIterations,
          tokenBudget: budget,
        };
        return false;
      }
      const { fix } = settled;
      log(`attempt ${f.attempt.n}: applying ${fix.source} fix: ${fix.description}`);
      f.attempt.fix = fix;
      recipe = applyOps(recipe, fix.ops);
      // A fix built on the owner's answer is specific to this project, so it stays out of the shared cache.
      if (fix.source === 'llm' && !settled.answered) pendingLlmFix = { signature: f.signature, fix };
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
        // Older reports counted questions and declines together as `rounds`.
        const declines = state.declines ?? state.declined?.length ?? 0;
        const turn: Turn = {
          skip: new Set(state.skip ?? []),
          declined: state.declined ?? [],
          answer: state.answer ?? undefined,
          questions: state.questions ?? Math.max(0, (state.rounds ?? 0) - declines),
          declines,
        };
        log(`resuming after attempt ${attempt.n}`);
        let settled: Settled;
        if (waiting.kind === 'approval') {
          decide(attempt.n, 'approval', waiting.fix.id, options.resume!.approve ? 'approved' : 'rejected', waiting.fix.description);
          settled = options.resume!.approve
            ? { kind: 'apply', fix: waiting.fix, answered: turn.answer !== undefined }
            : await settle(f, decline(f, turn, waiting.fix));
        } else {
          const answer = options.resume!.answer!;
          decide(attempt.n, 'question', waiting.question, answer);
          settled = await settle(f, { ...turn, rejected: undefined, answer, questions: turn.questions + 1 });
        }
        go = conclude(f, settled);
        first = state.nextAttempt;
      }

      for (let n = first; go && n <= maxIterations; n++) {
        await build.write(recipe, options.caFile);
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
        if (!conclude(failure, await settle(failure, { skip: new Set(), declined: [], questions: 0, declines: 0 }))) break;
      }
    } finally {
      if (!options.keepImages) await sandbox.cleanup();
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

/** Checks that a resume has a paused run to carry on and the answer its pending decision needs. */
function checkResume(
  resume: ResumeInput,
  options: Pick<ResurrectOptions, 'model' | 'maxIterations' | 'tokenBudget'>,
): { from: ResurrectReport; pending: PendingDecision; state: ResurrectRunState; maxIterations: number; budget: number } {
  const { from } = resume;
  const model = options.model ?? null;
  if (from.outcome !== 'needs-you' || !from.pending || !from.resume) {
    throw new Error(`only a run that is waiting on the owner (needs-you) can be resumed; this one ended ${from.outcome}`);
  }
  const state = from.resume;
  const budget = resume.tokenBudget ?? state.tokenBudget ?? options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const limit = resume.maxIterations ?? state.maxIterations ?? options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxIterations = Math.max(limit, state.nextAttempt);
  if (from.pending.kind === 'approval' && typeof resume.approve !== 'boolean') {
    throw new Error(`resuming needs a decision on the pending fix: approve or reject ${from.pending.fix.id} (${from.pending.fix.description})`);
  }
  if (from.pending.kind === 'question') {
    if (!resume.answer?.trim()) throw new Error(`resuming needs an answer to the pending question: ${from.pending.question}`);
    if (!model) throw new Error('answering the pending question needs a model to turn the answer into a fix, and none is available (no API key, --no-llm, or a token budget of 0)');
    if (budget <= from.resume.tokens) {
      throw new Error(`answering the pending question needs a model, but the token budget of ${budget} is already spent (${from.resume.tokens} used); raise it`);
    }
  }
  return { from, pending: from.pending, state, maxIterations, budget };
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

