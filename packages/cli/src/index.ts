import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Command } from 'commander';
import { errorMessage, ReportStore, shellArg, shellQuote, slugFor, type PendingDecision, type ReportKind, type ResurrectReport } from '@necromancer/core';
import { exhume } from '@necromancer/excavate';
import { runStdio } from '@necromancer/mcp';
import { graveyard } from '@necromancer/graveyard';
import { buildPlan, renderPlanMarkdown } from '@necromancer/plan';
import { ClaudeModel, credentialsHint, DEFAULT_MODEL, hasCredentials, type Effort, type StructuredModel } from '@necromancer/llm';
import {
  DEFAULT_HEALTH_TIMEOUT_SEC,
  DEFAULT_LIMITS,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TOKEN_BUDGET,
  DockerSandbox,
  checkResumable,
  firstError,
  FixCache,
  resurrect,
  resumeSettings,
  ResumeError,
  type ApprovalAnswer,
  type ApprovalRequest,
  type OwnerQuestion,
  type ResumableRun,
  type ResumeInput,
  type ResumeOverrides,
  type ResurrectOptions,
  type Sandbox,
} from '@necromancer/resurrect';
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
  /** Asks the user a question. Injected in tests; defaults to the terminal when stdin and stderr are a TTY, else null (nobody to ask). */
  prompt?: ((question: string) => Promise<string>) | null;
}

type Prompt = (question: string) => Promise<string>;

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const int = (v: string) => Number.parseInt(v, 10);

export function createProgram(deps: ProgramDeps = {}): Command {
  const program = new Command('necromancer')
    .description('An AI archaeologist for abandoned JavaScript/TypeScript projects.')
    .version(ownPackage().version);

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
      .option('-t, --top <n>', 'number of load-bearing files to report', int, 5)
      .option('-s, --seed <n>', 'clustering seed', int, 42)
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
    .option('-p, --port <n>', 'UI port when --open is given', int, 4173)
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
        'Needs an Anthropic API key (see "Setting your API key" in the README). Without answer flags it asks interactively.',
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

  program
    .command('resurrect')
    .description(
      'Get the project installing, building and booting in a Docker sandbox pinned to its era. Known fixes first, then ' +
        'Claude (if an Anthropic API key is set); stops with BLOCKED: <reason> when it cannot get further. Built-in known ' +
        'fixes apply without asking and are listed in the report. Cache and Claude fixes that change dependencies, the ' +
        'Node version or base image, system packages, install flags, environment variables or what runs wait for your OK ' +
        '(except a short allow-list of harmless flags and variables), and questions only you can answer ' +
        'are asked; without a terminal to ask on, the run stops with NEEDS YOU (exit code 3) and `--resume` carries on. Needs Docker.',
    )
    .argument('<source>', 'git URL or local path')
    .option('-n, --max-iterations <n>', "build attempts before giving up (with --resume, default: the saved run's)", int, DEFAULT_MAX_ITERATIONS)
    .option('--token-budget <n>', "input + output tokens the model may spend (with --resume, default: the saved run's)", int, DEFAULT_TOKEN_BUDGET)
    .option('--no-llm', 'known fixes and cached fixes only')
    .option('-m, --model <id>', 'Claude model', DEFAULT_MODEL)
    .option('--cpus <n>', 'CPUs per container', Number, DEFAULT_LIMITS.cpus)
    .option('--memory <mb>', 'memory per container, in MB', int, DEFAULT_LIMITS.memoryMb)
    .option('--step-timeout <sec>', 'time limit for each install, build or boot step', int, DEFAULT_LIMITS.stepTimeoutSec)
    .option('--health-timeout <sec>', 'how long to wait for the app to answer', int, DEFAULT_HEALTH_TIMEOUT_SEC)
    .option('--out-dir <dir>', 'also write Dockerfile.necromancer and docker-compose.necromancer.yml here')
    .option('--ca-file <file>', 'extra CA certificate for a TLS-intercepting proxy during install')
    .option('--build-proxy', "pass this machine's HTTP(S)_PROXY to the install step")
    .option('--no-build-proxy', "with --resume: don't pass the proxy, though the saved run did")
    .option('--keep-images', 'keep the built images')
    .option('--no-keep-images', "with --resume: remove the built images, though the saved run kept them")
    .option('-y, --yes', 'apply risky cache and model fixes without asking (with --resume, not the one it is waiting on: pass --approve or --reject)')
    .option('--resume', 'carry on from the saved run that is waiting on you')
    .option('--approve', 'with --resume: apply the fix it is waiting on')
    .option('--reject', 'with --resume: decline that fix and look for another')
    .option('--answer <text>', 'with --resume: your answer to its question, or the number of one of its choices')
    .option('--reports <dir>', 'report store directory')
    .option('-w, --workdir <dir>', 'where to clone remote repos')
    .option('-q, --quiet', 'no progress output on stderr')
    .action(
      async (
        source: string,
        opts: ResumeFlags & {
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
          workdir?: string;
          quiet?: boolean;
        },
        command: Command,
      ) => {
        if ((opts.approve || opts.reject || opts.answer !== undefined) && !opts.resume) throw new Error('--approve, --reject and --answer go with --resume');
        if (opts.approve && opts.reject) throw new Error('pass --approve or --reject, not both');
        // A blank answer would otherwise read as "nobody answered" and exit 3, so a script would loop on it.
        if (opts.answer !== undefined && !opts.answer.trim()) throw new Error('--answer is empty; pass the answer text');
        if (opts.resume && opts.caFile !== undefined) throw new Error("--ca-file does not go with --resume: the paused run's CA file is reused");
        const store = new ReportStore(opts.reports);
        const saved = await store.load(slugFor(source));
        const io = terminalIo();
        const prompt = deps.prompt !== undefined ? deps.prompt : io.ask;
        try {
          const say = progress(opts, '☥');
          const noKey = () => say?.(`no Anthropic API key, so only known fixes will be tried (to add one, ${credentialsHint()})`);
          // On a resume the paused run's settings stand, except for the flags typed again.
          const given = (name: string) => command.getOptionValueSource(name) === 'cli';
          const fixCache = new FixCache(path.join(path.dirname(store.dir), 'fix-cache.json'));
          const approve: ResurrectOptions['approve'] = opts.yes
            ? async () => 'auto-approve'
            : prompt
              ? (request) => askApproval(request, prompt)
              : async () => 'pause';
          const ask: ResurrectOptions['ask'] = prompt ? (question) => askQuestion(question, prompt) : undefined;
          let report: ResurrectReport;
          if (opts.resume) {
            const from = saved?.resurrect;
            if (!from) throw new Error(`no resurrect report for ${source}; run \`necromancer resurrect ${shellArg(source)}\` first`);
            const overrides: ResumeOverrides = {
              maxIterations: given('maxIterations') ? opts.maxIterations : undefined,
              tokenBudget: given('tokenBudget') ? opts.tokenBudget : undefined,
              limits: {
                cpus: given('cpus') ? opts.cpus : undefined,
                memoryMb: given('memory') ? opts.memory : undefined,
                stepTimeoutSec: given('stepTimeout') ? opts.stepTimeout : undefined,
              },
              model: given('llm') && !opts.llm ? null : given('model') ? opts.model : undefined,
              keepImages: given('keepImages') ? !!opts.keepImages : undefined,
              workdir: given('workdir') ? path.resolve(opts.workdir!) : undefined,
              sandbox: {
                buildProxy: given('buildProxy') ? !!opts.buildProxy : undefined,
                healthTimeoutSec: given('healthTimeout') ? opts.healthTimeout : undefined,
              },
            };
            let run: ResumableRun;
            try {
              // The model the paused run asked, or the one named again; none when there is no key, which the check reports.
              run = checkResumable(from, {
                model: (name) => deps.model ?? (hasCredentials() ? new ClaudeModel({ model: name }) : null),
                resume: overrides,
              });
            } catch (err) {
              throw new Error(`${errorMessage(err)}${resumeHint(source, from, overrides, err)}`);
            }
            // The paused run's sandbox, with any --build-proxy or --health-timeout typed again already merged in.
            const sandbox = deps.sandbox ?? new DockerSandbox(run.settings.sandbox ?? {});
            // Docker is checked before the owner is asked, so a typed answer is not lost to it. If the run fails in any
            // way after the answer was given (the clone, say), the error gives the command that passes it again.
            const asking = prompt !== null && !opts.approve && !opts.reject && opts.answer === undefined;
            if (asking) await sandbox.ping();
            const decision = await resumeDecision(run, opts, prompt);
            if (!decision) {
              // Nobody answered (no terminal, or the owner chose to pause): still waiting, so the same exit as a fresh pause.
              process.stderr.write(needsYou(source, run.pending, opts));
              process.exitCode = 3;
              return;
            }
            try {
              // A resume runs with the paused run's settings (the overrides are already in run.settings), so the
              // fresh-run options are not passed.
              report = await resurrect(source, { sandbox, model: run.model, fixCache, onProgress: say, approve, ask, resume: { run, ...decision } });
            } catch (err) {
              if (!asking) throw err;
              throw new Error(`${errorMessage(err)}\nTo carry on with your answer:\n  ${resumeCommand(source, opts)}${overrideFlags(opts, given)} ${decisionFlags(decision)}`);
            }
          } else {
            report = await resurrect(source, {
              sandbox: chooseSandbox(opts, deps),
              model: opts.tokenBudget > 0 ? chooseModel(opts, deps, noKey) : null,
              maxIterations: opts.maxIterations,
              tokenBudget: opts.tokenBudget,
              limits: { cpus: opts.cpus, memoryMb: opts.memory, stepTimeoutSec: opts.stepTimeout },
              exhume: saved?.exhume,
              graveyard: saved?.graveyard,
              interview: saved?.interview,
              fixCache,
              // Saved with the report for a resume, so made absolute.
              caFile: opts.caFile === undefined ? undefined : path.resolve(opts.caFile),
              workdir: opts.workdir,
              keepImages: opts.keepImages,
              onProgress: say,
              approve,
              ask,
            });
          }
          const file = await store.save('resurrect', report);
          if (opts.outDir) {
            await mkdir(opts.outDir, { recursive: true });
            await writeFile(path.join(opts.outDir, 'Dockerfile.necromancer'), report.dockerfile);
            await writeFile(path.join(opts.outDir, 'docker-compose.necromancer.yml'), report.compose);
          }
          if (report.outcome === 'resurrected') {
            process.stderr.write(`\nRESURRECTED on ${report.recipe.nodeImage} after ${report.attempts.length} attempt(s): ${report.health!.detail}\n`);
          } else if (report.outcome === 'needs-you' && report.pending) {
            process.stderr.write(needsYou(source, report.pending, opts));
            process.exitCode = 3;
          } else {
            process.stderr.write(`\nBLOCKED: ${report.blockedReason}\n`);
            process.exitCode = 2;
          }
          process.stderr.write(`saved ${file}${opts.outDir ? ` and the Dockerfile and compose file to ${opts.outDir}` : ''}\n`);
        } finally {
          io.close?.();
        }
      },
    );

  program
    .command('witness')
    .description(
      'Boot the resurrected app, call every route Exhume found and record normalized golden snapshots, then run the ' +
        "project's own tests. Claude writes the request inputs if an Anthropic API key is set. Needs a prior `resurrect` and Docker.",
    )
    .argument('<source>', 'git URL or local path')
    .option('--check', 'compare against the saved golden snapshots instead of replacing them; exits 1 on any difference')
    .option('--no-llm', 'one placeholder request per route instead of model-written inputs')
    .option('--no-tests', "don't run the project's test script")
    .option('-m, --model <id>', 'Claude model', DEFAULT_MODEL)
    .option('--step-timeout <sec>', 'time limit for each install, build or test step', int)
    .option('--health-timeout <sec>', 'how long to wait for the app to answer', int, DEFAULT_HEALTH_TIMEOUT_SEC)
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
        if (!saved?.resurrect) throw new Error(`no resurrect report for ${source}; run \`necromancer resurrect ${shellArg(source)}\` first`);
        if (opts.check && !saved.witness) throw new Error('no golden snapshots to check against; run `necromancer witness` without --check first');
        const say = progress(opts, '👁');
        const model = chooseModel(opts, deps, () => say?.(`no Anthropic API key, so every route gets one placeholder request (to add one, ${credentialsHint()})`));
        const report = await witness(source, {
          sandbox: chooseSandbox(opts, deps),
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
    .command('plan')
    .description(
      'Turn the saved reports into an ordered modernization plan: dependency and Node upgrades, lowest risk first, each ' +
        'followed by the check to run. Prints it as Markdown and saves plan.md and plan.json. Needs a saved graveyard report.',
    )
    .argument('<source>', 'git URL or local path')
    .option('--json', 'print the plan as JSON instead of Markdown')
    .option('-o, --out <file>', 'write the plan to a file instead of stdout')
    .option('--reports <dir>', 'report store directory')
    .action(async (source: string, opts: { json?: boolean; out?: string; reports?: string }) => {
      const store = new ReportStore(opts.reports);
      const saved = await store.load(slugFor(source));
      if (!saved?.graveyard) {
        throw new Error(`no graveyard report saved for ${source}; run \`necromancer autopsy ${shellArg(source)}\` (or \`necromancer graveyard ${shellArg(source)} --save\`) first`);
      }
      const plan = buildPlan(saved, { source });
      const markdown = renderPlanMarkdown(plan);
      const json = await store.save('plan', plan);
      const md = await store.saveFile(source, 'plan.md', markdown);
      const output = opts.json ? `${JSON.stringify(plan, null, 2)}\n` : markdown;
      if (opts.out) await writeFile(opts.out, output);
      else process.stdout.write(output);
      process.stderr.write(`\n${plan.steps.length} step(s); saved ${md} and ${json}\n`);
    });

  program
    .command('mcp')
    .description('Run the MCP server on stdio, for Claude Code or any other MCP client.')
    .option('-w, --workdir <dir>', 'where to clone remote repos', process.env.NECROMANCER_WORKDIR)
    .action((opts: { workdir?: string }) => runStdio({ workdir: opts.workdir }));

  program
    .command('ui')
    .description('Browse saved reports: interactive architecture map and dependency graveyard.')
    .option('-p, --port <n>', 'port (falls back to the next free one)', int, 4173)
    .option('--reports <dir>', 'report store directory')
    .option('--open', 'open it in a browser')
    .action((opts: { port: number; reports?: string; open?: boolean }) => serve(opts));

  return program;
}

interface ResumeFlags {
  resume?: boolean;
  approve?: boolean;
  reject?: boolean;
  answer?: string;
  yes?: boolean;
  reports?: string;
}

/** The owner's answer to the pending decision of a needs-you report, from flags or the terminal; null to stay paused. */
async function resumeDecision(
  { from, pending }: ResumableRun,
  opts: ResumeFlags,
  prompt: Prompt | null,
): Promise<Pick<ResumeInput, 'approve' | 'answer'> | null> {
  if (pending.kind === 'approval') {
    if (opts.answer !== undefined) throw new Error('the saved run is waiting on a fix, not a question; pass --approve or --reject');
    // --yes covers risky fixes found later in the run, never the one the owner is asked about: that takes --approve,
    // --reject or the prompt, so `--resume --reject --yes` declines it.
    if (opts.reject) return { approve: false };
    if (opts.approve) return { approve: true };
    if (!prompt) return null;
    const failed = from.resume?.failure;
    const excerpt = from.attempts.find((a) => a.n === failed?.attempt)?.errorExcerpt ?? failed?.log ?? '';
    const verdict = await askApproval({ attempt: failed?.attempt ?? 0, phase: failed?.phase ?? 'install', fix: pending.fix, risks: pending.risks, errorExcerpt: excerpt }, prompt);
    return verdict === 'pause' ? null : { approve: verdict === 'approve' };
  }
  if (opts.approve || opts.reject) throw new Error('the saved run is waiting on a question, not a fix; pass --answer "…"');
  if (opts.answer !== undefined) return { answer: pickChoice(opts.answer, pending.choices) };
  if (!prompt) return null;
  const answer = await askQuestion({ ...pending, attempt: from.resume?.failure.attempt ?? 0 }, prompt);
  return answer === null ? null : { answer };
}

/** Shows a risky fix and asks whether to apply it. */
async function askApproval(request: ApprovalRequest, prompt: Prompt): Promise<ApprovalAnswer> {
  process.stderr.write(
    `\nAttempt ${request.attempt} failed at ${request.phase}: ${firstError(request.errorExcerpt)}\n` +
      `Proposed fix (${request.fix.source}): ${request.fix.description}\n` +
      `It needs your OK because it:\n${request.risks.map((r) => `  - ${r.reason}`).join('\n')}\n`,
  );
  for (;;) {
    const reply = (await prompt('Apply it? [y]es / [n]o, look for another fix / [p]ause and exit: ')).trim().toLowerCase();
    if (reply === 'y' || reply === 'yes') return 'approve';
    if (reply === 'n' || reply === 'no') return 'reject';
    if (reply === 'p' || reply === 'pause') return 'pause';
    process.stderr.write('Please answer y, n or p.\n');
  }
}

/** Shows a question with numbered choices; a number picks a choice, other text is the answer, empty pauses. */
async function askQuestion(question: OwnerQuestion, prompt: Prompt): Promise<string | null> {
  process.stderr.write(`\n${question.question}\n${question.context ? `  ${question.context}\n` : ''}${question.choices.map((c, i) => `  ${i + 1}. ${c}\n`).join('')}`);
  const reply = (await prompt(question.choices.length ? 'Pick a number or type your answer (Enter to pause and exit): ' : 'Your answer (Enter to pause and exit): ')).trim();
  return reply ? pickChoice(reply, question.choices) : null;
}

/** A reply of 1 to n picks that choice, as NEEDS YOU and the prompt number them; any other reply is the answer. */
function pickChoice(reply: string, choices: string[]): string {
  const digits = reply.trim();
  const n = /^\d+$/.test(digits) ? Number(digits) : 0;
  return n >= 1 && n <= choices.length ? choices[n - 1]! : reply;
}

/** The flags that get past a failed `checkResumable`, by the `ResumeError` code, to add to its message. */
function resumeHint(source: string, from: ResurrectReport, overrides: ResumeOverrides, err: unknown): string {
  if (!(err instanceof ResumeError)) return '';
  const question = from.pending?.kind === 'question';
  switch (err.code) {
    case 'not-paused':
    case 'no-state':
      return ` (\`necromancer resurrect ${shellArg(source)}\` without --resume starts a new run)`;
    case 'budget-spent':
      return '; pass a larger --token-budget';
    case 'no-model':
      return `; drop --no-llm, or pass -m ${DEFAULT_MODEL} (or another model) to ask one`;
    case 'model-null':
      return `; to add an Anthropic API key, ${credentialsHint()}${question ? '' : ', or pass --no-llm to carry on with known and cached fixes only'}`;
    case 'model-mismatch': {
      // Only on this error path: what the resume would run with, to name its model.
      const model = resumeSettings(from, overrides).model;
      return model ? `; pass -m ${model} (or another model)` : '; drop -m to resume without a model';
    }
    case 'model-without-budget':
      return '; pass a larger --token-budget, or drop -m';
    case 'wrong-kind':
      return question ? '; pass --answer "…"' : '; pass --approve or --reject';
    case 'needs-approve':
      return '; pass --approve or --reject';
    case 'needs-answer':
      return '; pass --answer "…"';
  }
}

/** The command that resumes the paused run of `source`. */
function resumeCommand(source: string, opts: { reports?: string }): string {
  return `necromancer resurrect ${shellArg(source)} --resume${opts.reports ? ` --reports ${shellArg(opts.reports)}` : ''}`;
}

/** The flags that pass the owner's decision to `--resume` again. */
function decisionFlags(decision: Pick<ResumeInput, 'approve' | 'answer'>): string {
  // Always quoted, and never read as a path: an answer may start with a dash.
  return decision.answer !== undefined ? `--answer ${shellQuote(decision.answer)}` : decision.approve ? '--approve' : '--reject';
}

/** The overrides typed with `--resume`, as flags to type again; each starts with a space. Mirrors the resume's `overrides`. */
function overrideFlags(
  opts: {
    maxIterations: number;
    tokenBudget: number;
    cpus: number;
    memory: number;
    stepTimeout: number;
    llm: boolean;
    model: string;
    keepImages?: boolean;
    workdir?: string;
    buildProxy?: boolean;
    healthTimeout: number;
  },
  given: (name: string) => boolean,
): string {
  const flags: string[] = [];
  if (given('maxIterations')) flags.push(`-n ${opts.maxIterations}`);
  if (given('tokenBudget')) flags.push(`--token-budget ${opts.tokenBudget}`);
  if (given('cpus')) flags.push(`--cpus ${opts.cpus}`);
  if (given('memory')) flags.push(`--memory ${opts.memory}`);
  if (given('stepTimeout')) flags.push(`--step-timeout ${opts.stepTimeout}`);
  if (given('llm') && !opts.llm) flags.push('--no-llm');
  else if (given('model')) flags.push(`-m ${shellArg(opts.model)}`);
  if (given('keepImages')) flags.push(opts.keepImages ? '--keep-images' : '--no-keep-images');
  if (given('workdir')) flags.push(`--workdir ${shellArg(path.resolve(opts.workdir!))}`);
  if (given('buildProxy')) flags.push(opts.buildProxy ? '--build-proxy' : '--no-build-proxy');
  if (given('healthTimeout')) flags.push(`--health-timeout ${opts.healthTimeout}`);
  return flags.map((f) => ` ${f}`).join('');
}

/** The NEEDS YOU block: what the run is waiting on and the exact commands that carry it on. */
function needsYou(source: string, pending: PendingDecision, opts: { reports?: string }): string {
  const command = resumeCommand(source, opts);
  if (pending.kind === 'question') {
    return (
      `\nNEEDS YOU: ${pending.question}\n` +
      (pending.context ? `  ${pending.context}\n` : '') +
      pending.choices.map((c, i) => `  ${i + 1}. ${c}\n`).join('') +
      `Answer it to continue:\n  ${command} --answer "…"\n`
    );
  }
  return (
    `\nNEEDS YOU: apply this fix? ${pending.fix.description} (${pending.fix.source} fix ${pending.fix.id})\n` +
    `It would:\n${pending.risks.map((r) => `  - ${r.reason}`).join('\n')}\n` +
    `Continue with one of:\n  ${command} --approve\n  ${command} --reject\n`
  );
}

/** The injected model, else Claude when a key is set; `onNoKey` runs when the model was wanted but there is no key. */
function chooseModel(opts: { llm: boolean; model: string }, deps: ProgramDeps, onNoKey: () => void): StructuredModel | null {
  if (!opts.llm) return null;
  if (deps.model) return deps.model;
  if (hasCredentials()) return new ClaudeModel({ model: opts.model });
  onNoKey();
  return null;
}

function chooseSandbox(opts: { buildProxy?: boolean; healthTimeout: number }, deps: ProgramDeps): Sandbox {
  return deps.sandbox ?? new DockerSandbox({ buildProxy: opts.buildProxy, healthTimeoutSec: opts.healthTimeout });
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

/** The name the CLI is published under on npm; the workspace packages are all @necromancer/*. */
export const PUBLISHED_PACKAGE = 'legacy-necromancer';

/** The package this file was installed from: the npm package once bundled, else the workspace's cli package. */
function ownPackage(): { name: string; version: string } {
  return createRequire(import.meta.url)('../package.json') as { name: string; version: string };
}

/** A built UI: an index.html and the assets it loads. */
export function isUiBuild(dir: string): boolean {
  if (!existsSync(path.join(dir, 'index.html'))) return false;
  try {
    return readdirSync(path.join(dir, 'assets')).length > 0;
  } catch {
    return false;
  }
}

/** Built UI assets: the copy next to the npm bundle, else @necromancer/ui's dist, or null if neither is built. */
export function uiDistDir(): string | null {
  // The npm package bundles the CLI into one file with the UI copied next to it.
  const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
  if (isUiBuild(bundled)) return bundled;
  try {
    const pkg = createRequire(import.meta.url).resolve('@necromancer/ui/package.json');
    const dist = path.join(path.dirname(pkg), 'dist');
    return isUiBuild(dist) ? dist : null;
  } catch {
    return null;
  }
}

/** What to tell the user when there is no UI to serve; the fix differs for an npm install and a checkout. */
export function uiMissingWarning(packageName: string = ownPackage().name): string {
  return packageName === PUBLISHED_PACKAGE
    ? `warning: this ${PUBLISHED_PACKAGE} install is missing its UI files; reinstall ${PUBLISHED_PACKAGE}, or report it at ` +
        'https://github.com/tttmaximttt/legacy-necromancer/issues if that does not fix it. The API still works.\n'
    : 'warning: UI is not built; run `pnpm build` first. The API still works.\n';
}

async function serve(opts: { port: number; reports?: string; open?: boolean; slug?: string }): Promise<void> {
  const dist = uiDistDir();
  if (!dist) process.stderr.write(uiMissingWarning());
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
