import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExhumeReport, HttpRoute, InterviewReport, ResurrectReport, SandboxLimits, WitnessCase, WitnessReport, WitnessSnapshot, WitnessTestRun } from '@necromancer/core';
import { slugFor } from '@necromancer/core';
import { checkout, exhume as runExhume, headCommit } from '@necromancer/excavate';
import type { StructuredModel } from '@necromancer/llm';
import { BuildContext, DEFAULT_LIMITS, SERVICES, firstError, tail, type Sandbox } from '@necromancer/resurrect';
import { defaultCases, generateCases } from './inputs.js';
import { blank, differingPaths, normalizeBody, normalizeHeaders } from './normalize.js';
import { parseRunnerOutput, RUNNER, runnerEnv } from './runner.js';

export const MAX_ROUTES = 80;
const DEFAULT_TEST = /no test specified/;

export interface WitnessOptions {
  sandbox: Sandbox;
  /** How the app was brought back; Witness rebuilds and boots it from this recipe. */
  resurrect: ResurrectReport;
  /** Routes come from here; Exhume runs again if it's missing or predates route extraction. */
  exhume?: ExhumeReport | null;
  interview?: InterviewReport | null;
  /** Writes request inputs from the handler code; without it every route gets one placeholder request. */
  model?: StructuredModel | null;
  /** Send exactly these requests instead, e.g. a golden run's, to check behaviour hasn't changed. */
  cases?: WitnessCase[];
  runTests?: boolean;
  limits?: Partial<SandboxLimits>;
  caFile?: string;
  workdir?: string;
  onProgress?: (message: string) => void;
}

/**
 * Phase 6: boot the revived app from Resurrect's recipe, send every route a request (twice for safe methods, to
 * spot volatile fields), record normalized golden snapshots, and run the project's own tests next to it.
 */
export async function witness(source: string, options: WitnessOptions): Promise<WitnessReport> {
  const log = options.onProgress ?? (() => {});
  const { sandbox, resurrect } = options;
  if (resurrect.outcome !== 'resurrected') throw new Error(`Resurrect did not get this project running (BLOCKED: ${resurrect.blockedReason}); nothing to witness`);
  const limits: SandboxLimits = { ...DEFAULT_LIMITS, ...resurrect.limits, ...options.limits };
  const recipe = resurrect.recipe;
  const warnings: string[] = [];

  await sandbox.ping();
  log(`checking out ${source}`);
  const repo = await checkout(source, { workdir: options.workdir });
  const contextDir = await mkdtemp(path.join(options.workdir ?? os.tmpdir(), 'necromancer-witness-'));
  try {
    const commit = await headCommit(repo.root);
    if (resurrect.repo.commit && commit && resurrect.repo.commit !== commit) {
      warnings.push(`resurrected at ${resurrect.repo.commit.slice(0, 12)}, witnessing ${commit.slice(0, 12)}; re-run resurrect if the build fails`);
    }
    let report = options.exhume ?? null;
    if (!report?.routes || report.repo.commit !== commit) {
      log('finding routes');
      report = await runExhume(repo.root);
    }
    const allRoutes = report.routes ?? [];
    const routes = allRoutes.slice(0, MAX_ROUTES);
    const skipped = allRoutes.slice(MAX_ROUTES).map((r) => ({ route: `${r.method} ${r.path}`, reason: `more than ${MAX_ROUTES} routes` }));

    const manifest = JSON.parse(await readFile(path.join(repo.root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const build = await BuildContext.copy(repo.root, contextDir, manifest);
    await build.write(recipe, options.caFile);
    const tag = `necromancer/${slugFor(source).toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}:witness`;

    try {
      log(`installing on ${recipe.nodeImage}`);
      const installed = await sandbox.install(contextDir, tag, limits);
      if (!installed.ok) throw new Error(`the resurrected recipe no longer installs: ${firstError(installed.log)}`);
      let image = tag;
      if (recipe.buildCommand) {
        image = `${tag}-built`;
        const built = await sandbox.run(tag, recipe.buildCommand, recipe.env, limits, image);
        if (!built.ok) throw new Error(`the build script failed: ${firstError(built.log)}`);
      }

      let snapshots: WitnessSnapshot[] = [];
      let inputs: WitnessReport['inputs'] = { source: 'default', model: null, tokens: 0 };
      let namespace: string | null = null;
      if (recipe.startCommand && (routes.length || options.cases?.length)) {
        if (!recipe.port) warnings.push('no port is known for this app, so its routes could not be called');
        log(`booting \`${recipe.startCommand}\``);
        const boot = await sandbox.boot(image, {
          command: recipe.startCommand,
          env: recipe.env,
          port: recipe.port,
          services: resurrect.services.map((s) => ({ image: s.image, port: SERVICES[s.kind].port, env: SERVICES[s.kind].serviceEnv })),
          limits,
        });
        if (!boot.ok || !boot.namespace) throw new Error(`the app did not boot: ${firstError(boot.log)}`);
        namespace = boot.namespace;

        if (recipe.port) {
          let cases = defaultCases(routes);
          if (options.cases) {
            cases = options.cases;
            inputs = { source: 'replay', model: null, tokens: 0 };
          } else if (options.model) {
            log(`asking ${options.model.name} for request inputs for ${routes.length} routes`);
            try {
              const generated = await generateCases({ model: options.model, routes, snippets: await snippets(repo.root, routes), interview: options.interview });
              cases = generated.cases;
              inputs = { source: 'claude-api', model: options.model.name, tokens: generated.tokens };
            } catch (err) {
              warnings.push(`could not generate inputs (${err instanceof Error ? err.message : String(err)}); used one placeholder request per route`);
            }
          }
          log(`sending ${cases.length} requests`);
          const sent = await sandbox.exec(image, namespace, ['node', '-e', RUNNER], runnerEnv(cases, recipe.port), limits);
          const raw = parseRunnerOutput(sent.log);
          if (!raw.length) warnings.push(`the request runner produced no responses: ${firstError(sent.log)}`);
          snapshots = cases.map((c, i) => {
            const first = raw.find((r) => r.i === i && r.repeat === 0);
            const again = raw.find((r) => r.i === i && r.repeat === 1);
            if (!first) return { case: c, response: { status: null, headers: {}, body: null, error: 'no response recorded' }, volatile: [] };
            const contentType = typeof first.headers['content-type'] === 'string' ? first.headers['content-type'] : undefined;
            const body = normalizeBody(first.body, contentType);
            const volatile = again && again.status === first.status ? differingPaths(body, normalizeBody(again.body, contentType)) : [];
            return {
              case: c,
              response: { status: first.status, headers: normalizeHeaders(first.headers), body: blank(body, volatile), error: first.error },
              volatile,
            };
          });
        }
      } else if (!recipe.startCommand) {
        warnings.push('no start command: this is a library, so only its own tests are witnessed');
      }

      const tests = options.runTests === false ? null : await runTests(sandbox, image, namespace, manifest.scripts ?? {}, recipe, limits, log);
      const exercised = new Set(snapshots.map((s) => s.case.route)).size;
      return {
        repo: { source, commit },
        generatedAt: new Date().toISOString(),
        target: { nodeImage: recipe.nodeImage, startCommand: recipe.startCommand, services: resurrect.services.map((s) => s.image) },
        routes: { found: allRoutes.length, exercised, skipped },
        inputs,
        snapshots,
        tests,
        warnings,
      };
    } finally {
      await sandbox.cleanup();
    }
  } finally {
    await rm(contextDir, { recursive: true, force: true });
    await repo.cleanup();
  }
}

async function runTests(
  sandbox: Sandbox,
  image: string,
  namespace: string | null,
  scripts: Record<string, string>,
  recipe: ResurrectReport['recipe'],
  limits: SandboxLimits,
  log: (m: string) => void,
): Promise<WitnessTestRun | null> {
  if (!scripts.test || DEFAULT_TEST.test(scripts.test)) return null;
  const command = recipe.packageManager === 'npm' ? 'npm test' : `${recipe.packageManager} test`;
  log(`running the project's tests: ${command}`);
  // Next to the running app when there is one, so tests that expect its databases on localhost find them.
  const result = namespace
    ? await sandbox.exec(image, namespace, ['sh', '-c', command], { ...recipe.env, NODE_ENV: 'test', CI: 'true' }, limits)
    : await sandbox.run(image, command, { ...recipe.env, NODE_ENV: 'test', CI: 'true' }, limits);
  return { command, ok: result.ok, summary: testSummary(result.log), durationMs: result.durationMs, logTail: tail(result.log, 40) };
}

/** Mocha, Jest, Vitest, tap and AVA summary lines. */
export function testSummary(log: string): string | null {
  const text = tail(log, 200);
  const mocha = [/(\d+) passing/, /(\d+) failing/, /(\d+) pending/].map((r) => r.exec(text)?.[0]).filter(Boolean);
  if (mocha.length) return mocha.join(', ');
  const jest = /Tests:\s+(.+total)/.exec(text)?.[1];
  if (jest) return jest.trim();
  const vitest = /Tests\s+(\d+ (?:passed|failed).*?)\s*$/m.exec(text)?.[1];
  if (vitest) return vitest.trim();
  const tap = [/# pass\s+(\d+)/, /# fail\s+(\d+)/].map((r, i) => (r.exec(text) ? `${r.exec(text)![1]} ${i ? 'failing' : 'passing'}` : null)).filter(Boolean);
  if (tap.length) return tap.join(', ');
  const ava = /(\d+ tests? (passed|failed))/.exec(text)?.[1];
  return ava ?? null;
}

/** About 30 lines from each route's registration, where its handler usually is. */
async function snippets(root: string, routes: HttpRoute[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const files = new Map<string, string[] | null>();
  let budget = 3000;
  for (const r of routes) {
    if (budget <= 0) break;
    if (!files.has(r.file)) files.set(r.file, (await readFile(path.join(root, r.file), 'utf8').catch(() => null))?.split('\n') ?? null);
    const lines = files.get(r.file);
    if (!lines) continue;
    const from = Math.max(0, r.line - 3);
    const chunk = lines.slice(from, from + 30);
    budget -= chunk.length;
    out.set(`${r.file}:${r.line}`, chunk.map((l, i) => `${from + i + 1}| ${l}`).join('\n'));
  }
  return out;
}
