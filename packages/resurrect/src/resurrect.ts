import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AppliedFix,
  BuildRecipe,
  ExhumeReport,
  GraveyardReport,
  InterviewReport,
  ResurrectAttempt,
  ResurrectPhase,
  ResurrectReport,
  SandboxLimits,
} from '@necromancer/core';
import { slugFor } from '@necromancer/core';
import { checkout, headCommit, listRepoFiles, readHistory } from '@necromancer/excavate';
import type { StructuredModel } from '@necromancer/llm';
import { proposeFix } from './agent.js';
import { DEFAULT_LIMITS, renderCompose } from './compose.js';
import { chooseNode, detectServices, initialRecipe, readFacts, SERVICES, serviceEnv, type ProjectFacts } from './detect.js';
import type { Sandbox, StepResult } from './docker.js';
import { errorSignature, findKnownFix, FixCache, tail } from './fixes.js';
import { applyOps, changesRecipe, patchManifest, renderDockerfile } from './recipe.js';

export const DEFAULT_MAX_ITERATIONS = 10;
export const DEFAULT_TOKEN_BUDGET = 150_000;

export interface ResurrectOptions {
  sandbox: Sandbox;
  /** Asked for a fix when the known-fix table and the cache have none. null runs table-only. */
  model?: StructuredModel | null;
  maxIterations?: number;
  /** Input plus output tokens the model may spend across the whole run. */
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
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];

/**
 * Phase 5: the build-fix loop. Each attempt installs (the only step with network), runs the build script and
 * boots the app in the sandbox. After a failure, the next change comes from the known-fix table, then the fix
 * cache, then the model; with none, or out of attempts or tokens, the run ends "BLOCKED: <reason>".
 */
export async function resurrect(source: string, options: ResurrectOptions): Promise<ResurrectReport> {
  const log = options.onProgress ?? (() => {});
  const limits: SandboxLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
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
    let recipe = initialRecipe(facts, node.tag, services);
    log(`era ${eraDate?.slice(0, 7) ?? 'unknown'}: ${node.why}; services: ${services.map((s) => s.image).join(', ') || 'none'}`);

    const attempts: ResurrectAttempt[] = [];
    const warnings: string[] = [];
    let tokens = 0;
    let calls = 0;
    let health: ResurrectReport['health'] = null;
    let blockedReason: string | null = null;

    const report = (): ResurrectReport => ({
      repo: { source, commit },
      generatedAt: new Date().toISOString(),
      outcome: health ? 'resurrected' : 'blocked',
      blockedReason: health ? null : blockedReason,
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
    await cp(repo.root, context, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules)([/\\]|$)/.test(src.slice(repo.root.length)) });
    const originalManifest = facts.manifest;
    const lockfiles = new Map<string, string>();
    for (const f of LOCKFILES) {
      const text = await readFile(path.join(repo.root, f), 'utf8').catch(() => null);
      if (text !== null) lockfiles.set(f, text);
    }
    const tagBase = `necromancer/${slugFor(source).toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}`;

    let pendingLlmFix: { signature: string; fix: AppliedFix } | null = null;
    const seen = new Map<string, number>();

    try {
      for (let n = 1; n <= maxIterations; n++) {
        await writeContext(context, recipe, originalManifest, lockfiles, options.caFile);
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
              services: services.map((s) => ({ image: s.image, port: SERVICES[s.kind].port, env: serviceEnv(s.kind) })),
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

        const ctx = {
          phase,
          log: tail(step.log, 120),
          recipe,
          dependencies: { ...asRecord(originalManifest.devDependencies), ...asRecord(originalManifest.dependencies) },
          devOnly: new Set(Object.keys(asRecord(originalManifest.devDependencies)).filter((d) => !(d in asRecord(originalManifest.dependencies)))),
        };
        let fix: AppliedFix | null = null;
        const known = findKnownFix(ctx);
        if (known) fix = { source: 'known', id: known.id, description: known.description, ops: known.ops(ctx) };
        if (!fix) {
          const cached = await cache.get(signature);
          if (cached && changesRecipe(recipe, cached.ops)) fix = { source: 'cache', id: `cache:${signature}`, ...cached };
        }
        if (!fix && options.model) {
          let rejected: string | undefined;
          for (let ask = 0; ask < 2 && !fix && !blockedReason; ask++) {
            if (tokens >= budget) {
              blockedReason = `token budget of ${budget} spent; last error at ${phase}: ${firstError(step.log)}`;
              break;
            }
            log(`attempt ${n}: no known fix, asking ${options.model.name}`);
            calls++;
            let answer: Awaited<ReturnType<typeof proposeFix>>;
            try {
              answer = await proposeFix(options.model, {
                phase,
                errorTail: ctx.log,
                recipe,
                dockerfile: renderDockerfile(recipe),
                dependencies: ctx.dependencies,
                history: attempts,
                interview: options.interview ?? null,
                rejected,
              });
            } catch (err) {
              blockedReason = `could not ask ${options.model.name} for a fix (${err instanceof Error ? err.message : String(err)}); last error at ${phase}: ${firstError(step.log)}`;
              break;
            }
            const { proposal, tokens: used } = answer;
            tokens += used;
            if (proposal.decision === 'blocked') {
              blockedReason = proposal.blockedReason?.trim() || proposal.diagnosis;
              break;
            }
            try {
              if (!changesRecipe(recipe, proposal.ops)) {
                applyOps(recipe, proposal.ops); // surfaces validation errors
                throw new Error('it changes nothing that was not already tried');
              }
              fix = { source: 'llm', id: `llm:${signature}`, description: proposal.diagnosis, ops: proposal.ops };
            } catch (err) {
              rejected = err instanceof Error ? err.message : String(err);
              warnings.push(`attempt ${n}: rejected a proposed fix (${rejected})`);
            }
          }
          if (!fix && !blockedReason) blockedReason = `the model proposed no usable fix for: ${firstError(step.log)}`;
        }
        if (blockedReason) break;
        if (!fix) {
          blockedReason = `${phase} failed and no known fix matches${options.model ? '' : ' (no model configured)'}: ${firstError(step.log)}`;
          break;
        }
        log(`attempt ${n}: applying ${fix.source} fix: ${fix.description}`);
        attempt.fix = fix;
        recipe = applyOps(recipe, fix.ops);
        if (fix.source === 'llm') pendingLlmFix = { signature, fix };
      }
    } finally {
      if (!options.keepImages) await sandbox.cleanup();
    }
    if (!health && !blockedReason) blockedReason = 'no attempts were made';
    if (!health) log(`BLOCKED: ${blockedReason}`);
    return report();
  } finally {
    await rm(context, { recursive: true, force: true });
    await repo.cleanup();
  }
}

async function writeContext(
  dir: string,
  recipe: BuildRecipe,
  manifest: Record<string, unknown>,
  lockfiles: Map<string, string>,
  caFile: string | undefined,
): Promise<void> {
  await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(patchManifest(manifest, recipe), null, 2)}\n`);
  for (const [name, text] of lockfiles) {
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

export type { ProjectFacts };
