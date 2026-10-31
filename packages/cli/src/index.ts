import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Command } from 'commander';
import { ReportStore, slugFor, type ReportKind } from '@necromancer/core';
import { exhume } from '@necromancer/excavate';
import { graveyard } from '@necromancer/graveyard';
import { ClaudeModel, DEFAULT_MODEL, hasCredentials, type Effort, type StructuredModel } from '@necromancer/llm';
import { DEFAULT_LIMITS, DEFAULT_MAX_ITERATIONS, DEFAULT_TOKEN_BUDGET, DockerSandbox, FixCache, resurrect, type Sandbox } from '@necromancer/resurrect';
import { compareWitness, witness } from '@necromancer/witness';
import { runInterview, terminalIo, type InterviewOptions } from './interview.js';
import { createUiServer } from './server.js';

interface OutputOptions {
  out?: string;
  save?: boolean;
  reports?: string;
  quiet?: boolean;
}

export interface ProgramDeps {
  /** Injected in tests; defaults to Claude via the Anthropic API. */
  model?: StructuredModel;
  /** Injected in tests; defaults to the local Docker daemon. */
  sandbox?: Sandbox;
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function createProgram(deps: ProgramDeps = {}): Command {
  const program = new Command('necromancer')
    .description('An AI archaeologist for abandoned JavaScript/TypeScript projects.')
    .version('0.0.0');

  const withOutput = (cmd: Command) =>
    cmd
      .option('-o, --out <file>', 'write the JSON report to a file instead of stdout')
      .option('--save', 'save the report for `necromancer ui` instead of printing it')
      .option('--reports <dir>', 'report store directory (default ~/.necromancer/reports, or $NECROMANCER_REPORTS)')
      .option('-w, --workdir <dir>', 'where to clone remote repos')
      .option('-q, --quiet', 'no progress output on stderr');

  withOutput(
    program
      .command('exhume')
      .description('Reconstruct a repo’s architecture: module clusters, load-bearing files, churn, install-script audit.')
      .argument('<source>', 'git URL or local path')
      .option('-t, --top <n>', 'number of load-bearing files to report', (v) => Number.parseInt(v, 10), 5)
      .option('-s, --seed <n>', 'clustering seed', (v) => Number.parseInt(v, 10), 42)
      .option('-k, --keep', 'keep the clone after the run')
      .option('--include-tests', 'rank test files as load-bearing too'),
  ).action(
    async (source: string, opts: OutputOptions & { top: number; seed: number; workdir?: string; keep?: boolean; includeTests?: boolean }) => {
      const report = await exhume(source, {
        top: opts.top,
        seed: opts.seed,
        workdir: opts.workdir,
        keep: opts.keep,
        includeTests: opts.includeTests,
        onProgress: progress(opts, '☠'),
      });
      await emit('exhume', report, opts);
    },
  );

  withOutput(
    program
      .command('graveyard')
      .description('Date the project and put a tombstone on every dependency: deprecated, archived, abandoned, vulnerable, outdated.')
      .argument('<source>', 'git URL or local path')
      .option('-a, --advisories <provider>', 'npm (same data as npm audit), osv, or none', 'npm')
      .option('--no-github', 'skip the GitHub archived check (set GITHUB_TOKEN to check every package)'),
  ).action(async (source: string, opts: OutputOptions & { advisories: string; github: boolean; workdir?: string }) => {
    const report = await graveyard(source, {
      advisories: advisoryProvider(opts.advisories),
      noGithub: !opts.github,
      workdir: opts.workdir,
      onProgress: progress(opts, '⚰'),
    });
    await emit('graveyard', report, opts);
  });

  program
    .command('autopsy')
    .description('Exhume and dig the graveyard of a repo, save both reports, and optionally open them in the UI.')
    .argument('<source>', 'git URL or local path')
    .option('-a, --advisories <provider>', 'npm, osv, or none', 'npm')
    .option('--no-github', 'skip the GitHub archived check')
    .option('--reports <dir>', 'report store directory')
    .option('-w, --workdir <dir>', 'where to clone remote repos')
    .option('--open', 'start the UI and open it in a browser afterwards')
    .option('-p, --port <n>', 'UI port when --open is given', (v) => Number.parseInt(v, 10), 4173)
    .option('-q, --quiet', 'no progress output on stderr')
    .action(
      async (
        source: string,
        opts: { advisories: string; github: boolean; reports?: string; workdir?: string; open?: boolean; port: number; quiet?: boolean },
      ) => {
        const store = new ReportStore(opts.reports);
        const ex = await exhume(source, { workdir: opts.workdir, onProgress: progress(opts, '☠') });
        await store.save('exhume', ex);
        const gy = await graveyard(source, {
          advisories: advisoryProvider(opts.advisories),
          noGithub: !opts.github,
          workdir: opts.workdir,
          onProgress: progress(opts, '⚰'),
        });
        const saved = await store.save('graveyard', gy);
        const s = gy.summary;
        process.stderr.write(
          `\n${gy.era.summary}\n` +
            `${ex.stats.files} files in ${ex.clusters.length} clusters; most load-bearing: ${ex.loadBearing[0]?.path ?? 'n/a'}\n` +
            `${s.total} dependencies: ${s.dead} dead, ${s.dying} dying, ${s.ailing} ailing, ${s.alive} alive; ${s.vulnerable} with advisories\n` +
            `saved to ${path.dirname(saved)}\n`,
        );
        if (opts.open) await serve({ port: opts.port, reports: opts.reports, open: true, slug: path.basename(path.dirname(saved)) });
      },
    );

  program
    .command('interview')
    .description(
      'Ask Claude what the project is for, with file:line evidence, then confirm or correct it and set goals for the revival. ' +
        'Needs ANTHROPIC_API_KEY. Without answer flags it asks interactively.',
    )
    .argument('<source>', 'git URL or local path')
    .option('-m, --model <id>', 'Claude model', DEFAULT_MODEL)
    .option('-e, --effort <level>', `how hard the model thinks: ${EFFORTS.join(', ')}`, 'medium')
    .option('--no-fallbacks', 'do not retry a declined request on the fallback model')
    .option('-y, --yes', 'confirm the proposed intent')
    .option('-c, --correct <text>', 'replace the proposed intent with your own description')
    .option('-g, --accept-goals <list>', 'suggested goals to keep, by number (1,3) or "all"')
    .option('--goal <text>', 'a goal in your own words (repeatable)', (v: string, all: string[] = []) => [...all, v])
    .option('-r, --reuse', 'answer the saved proposal instead of asking the model again')
    .option('--reports <dir>', 'report store directory')
    .option('-w, --workdir <dir>', 'where to clone remote repos')
    .option('-q, --quiet', 'no progress output on stderr')
    .action(async (source: string, opts: InterviewOptions) => {
      if (!EFFORTS.includes(opts.effort)) throw new Error(`unknown effort: ${opts.effort}`);
      const io = { ...terminalIo(), model: deps.model };
      try {
        await runInterview(source, opts, io);
      } finally {
        io.close?.();
      }
    });

  const int = (v: string) => Number.parseInt(v, 10);
  program
    .command('resurrect')
    .description(
      'Get the project installing, building and booting in a Docker sandbox pinned to its era. Known fixes first, then ' +
        'Claude (if ANTHROPIC_API_KEY is set); stops with BLOCKED: <reason> when it cannot get further. Needs Docker.',
    )
    .argument('<source>', 'git URL or local path')
    .option('-n, --max-iterations <n>', 'build attempts before giving up', int, DEFAULT_MAX_ITERATIONS)
    .option('--token-budget <n>', 'input + output tokens the model may spend', int, DEFAULT_TOKEN_BUDGET)
    .option('--no-llm', 'known fixes and cached fixes only')
    .option('-m, --model <id>', 'Claude model', DEFAULT_MODEL)
    .option('--cpus <n>', 'CPUs per container', Number, DEFAULT_LIMITS.cpus)
    .option('--memory <mb>', 'memory per container, in MB', int, DEFAULT_LIMITS.memoryMb)
    .option('--step-timeout <sec>', 'time limit for each install, build or boot step', int, DEFAULT_LIMITS.stepTimeoutSec)
    .option('--health-timeout <sec>', 'how long to wait for the app to answer', int, 90)
    .option('--out-dir <dir>', 'also write Dockerfile.necromancer and docker-compose.necromancer.yml here')
    .option('--ca-file <file>', 'extra CA certificate for a TLS-intercepting proxy during install')
    .option('--build-proxy', "pass this machine's HTTP(S)_PROXY to the install step")
    .option('--keep-images', 'keep the built images')
    .option('--reports <dir>', 'report store directory')
    .option('-w, --workdir <dir>', 'where to clone remote repos')
    .option('-q, --quiet', 'no progress output on stderr')
    .action(
      async (
        source: string,
        opts: {
          maxIterations: number;
          tokenBudget: number;
          llm: boolean;
          model: string;
          cpus: number;
          memory: number;
          stepTimeout: number;
          healthTimeout: number;
          outDir?: string;
          caFile?: string;
          buildProxy?: boolean;
          keepImages?: boolean;
          reports?: string;
          workdir?: string;
          quiet?: boolean;
        },
      ) => {
        const store = new ReportStore(opts.reports);
        const saved = await store.load(slugFor(source));
        const say = progress(opts, '☥');
        let model: StructuredModel | null = null;
        if (opts.llm) {
          if (deps.model) model = deps.model;
          else if (hasCredentials()) model = new ClaudeModel({ model: opts.model });
          else say?.('no ANTHROPIC_API_KEY, so only known fixes will be tried');
        }
        const report = await resurrect(source, {
          sandbox: deps.sandbox ?? new DockerSandbox({ buildProxy: opts.buildProxy, healthTimeoutSec: opts.healthTimeout }),
          model,
          maxIterations: opts.maxIterations,
          tokenBudget: opts.tokenBudget,
          limits: { cpus: opts.cpus, memoryMb: opts.memory, stepTimeoutSec: opts.stepTimeout },
          exhume: saved?.exhume,
          graveyard: saved?.graveyard,
          interview: saved?.interview,
          fixCache: new FixCache(path.join(path.dirname(store.dir), 'fix-cache.json')),
          caFile: opts.caFile,
          workdir: opts.workdir,
          keepImages: opts.keepImages,
          onProgress: say,
        });
        const file = await store.save('resurrect', report);
        if (opts.outDir) {
          await mkdir(opts.outDir, { recursive: true });
          await writeFile(path.join(opts.outDir, 'Dockerfile.necromancer'), report.dockerfile);
          await writeFile(path.join(opts.outDir, 'docker-compose.necromancer.yml'), report.compose);
        }
        if (report.outcome === 'resurrected') {
          process.stderr.write(`
RESURRECTED on ${report.recipe.nodeImage} after ${report.attempts.length} attempt(s): ${report.health!.detail}
`);
        } else {
          process.stderr.write(`
BLOCKED: ${report.blockedReason}
`);
          process.exitCode = 2;
        }
        process.stderr.write(`saved ${file}${opts.outDir ? ` and the Dockerfile and compose file to ${opts.outDir}` : ''}
`);
      },
    );

  program
    .command('witness')
    .description(
      'Boot the resurrected app, call every route Exhume found and record normalized golden snapshots, then run the ' +
        "project's own tests. Claude writes the request inputs if ANTHROPIC_API_KEY is set. Needs a prior `resurrect` and Docker.",
    )
    .argument('<source>', 'git URL or local path')
    .option('--check', 'compare against the saved golden snapshots instead of replacing them; exits 1 on any difference')
    .option('--no-llm', 'one placeholder request per route instead of model-written inputs')
    .option('--no-tests', "don't run the project's test script")
    .option('-m, --model <id>', 'Claude model', DEFAULT_MODEL)
    .option('--step-timeout <sec>', 'time limit for each install, build or test step', int)
    .option('--health-timeout <sec>', 'how long to wait for the app to answer', int, 90)
    .option('--ca-file <file>', 'extra CA certificate for a TLS-intercepting proxy during install')
    .option('--build-proxy', "pass this machine's HTTP(S)_PROXY to the install step")
    .option('--reports <dir>', 'report store directory')
    .option('-w, --workdir <dir>', 'where to clone remote repos')
    .option('-q, --quiet', 'no progress output on stderr')
    .action(
      async (
        source: string,
        opts: {
          check?: boolean;
          llm: boolean;
          tests: boolean;
          model: string;
          stepTimeout?: number;
          healthTimeout: number;
          caFile?: string;
          buildProxy?: boolean;
          reports?: string;
          workdir?: string;
          quiet?: boolean;
        },
      ) => {
        const store = new ReportStore(opts.reports);
        const saved = await store.load(slugFor(source));
        if (!saved?.resurrect) throw new Error(`no resurrect report for ${source}; run \`necromancer resurrect ${source}\` first`);
        if (opts.check && !saved.witness) throw new Error('no golden snapshots to check against; run `necromancer witness` without --check first');
        const say = progress(opts, '👁');
        let model: StructuredModel | null = null;
        if (opts.llm) {
          if (deps.model) model = deps.model;
          else if (hasCredentials()) model = new ClaudeModel({ model: opts.model });
          else say?.('no ANTHROPIC_API_KEY, so every route gets one placeholder request');
        }
        const report = await witness(source, {
          sandbox: deps.sandbox ?? new DockerSandbox({ buildProxy: opts.buildProxy, healthTimeoutSec: opts.healthTimeout }),
          resurrect: saved.resurrect,
          exhume: saved.exhume,
          interview: saved.interview,
          // A check replays the golden run's exact requests, so only behaviour can differ.
          model: opts.check ? null : model,
          cases: opts.check ? saved.witness!.snapshots.map((s) => s.case) : undefined,
          runTests: opts.tests,
          limits: opts.stepTimeout ? { stepTimeoutSec: opts.stepTimeout } : undefined,
          caFile: opts.caFile,
          workdir: opts.workdir,
          onProgress: say,
        });
        for (const w of report.warnings) process.stderr.write(`warning: ${w}\n`);
        const tests = report.tests ? `; tests ${report.tests.ok ? 'passed' : 'failed'}${report.tests.summary ? ` (${report.tests.summary})` : ''}` : '';
        if (opts.check) {
          const diffs = compareWitness(saved.witness!, report);
          if (!diffs.length) {
            process.stderr.write(`\nNo behaviour changes across ${report.snapshots.length} request(s)${tests}\n`);
            return;
          }
          process.stderr.write(`\n${diffs.length} difference(s) from the golden snapshots:\n`);
          for (const d of diffs) process.stderr.write(`  ${d.what.padEnd(7)} ${d.case}: ${d.detail}\n`);
          process.exitCode = 1;
          return;
        }
        const file = await store.save('witness', report);
        process.stderr.write(
          `\nWITNESSED ${report.routes.exercised}/${report.routes.found} route(s) with ${report.snapshots.length} request(s)${tests}\nsaved ${file}\n`,
        );
      },
    );

  program
    .command('ui')
    .description('Browse saved reports: interactive architecture map and dependency graveyard.')
    .option('-p, --port <n>', 'port (falls back to the next free one)', (v) => Number.parseInt(v, 10), 4173)
    .option('--reports <dir>', 'report store directory')
    .option('--open', 'open it in a browser')
    .action((opts: { port: number; reports?: string; open?: boolean }) => serve(opts));

  return program;
}

function advisoryProvider(value: string): 'npm' | 'osv' | 'none' {
  if (value === 'npm' || value === 'osv' || value === 'none') return value;
  throw new Error(`unknown advisory provider: ${value}`);
}

function progress(opts: { quiet?: boolean }, icon: string): ((m: string) => void) | undefined {
  return opts.quiet ? undefined : (m) => process.stderr.write(`${icon} ${m}\n`);
}

async function emit(kind: ReportKind, report: Parameters<ReportStore['save']>[1], opts: OutputOptions): Promise<void> {
  if (opts.save) {
    const file = await new ReportStore(opts.reports).save(kind, report);
    if (!opts.quiet) process.stderr.write(`saved ${file}\n`);
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (opts.out) await writeFile(opts.out, json);
  else if (!opts.save) process.stdout.write(json);
}

/** Built UI assets shipped by @necromancer/ui, or null if it hasn't been built. */
export function uiDistDir(): string | null {
  try {
    const pkg = createRequire(import.meta.url).resolve('@necromancer/ui/package.json');
    const dist = path.join(path.dirname(pkg), 'dist');
    return existsSync(path.join(dist, 'index.html')) ? dist : null;
  } catch {
    return null;
  }
}

async function serve(opts: { port: number; reports?: string; open?: boolean; slug?: string }): Promise<void> {
  const dist = uiDistDir();
  if (!dist) process.stderr.write('warning: UI is not built; run `pnpm build` first. The API still works.\n');
  const server = createUiServer(new ReportStore(opts.reports), dist);
  let port = opts.port;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port > opts.port + 20) throw err;
      port++;
    }
  }
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${opts.slug ? `?repo=${encodeURIComponent(opts.slug)}` : ''}`;
  process.stderr.write(`☠ necromancer ui on ${url}  (Ctrl+C to stop)\n`);
  if (opts.open) openBrowser(url);
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // No browser available; the URL is printed above.
  }
}
