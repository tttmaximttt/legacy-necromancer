import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Command } from 'commander';
import { ReportStore, type ReportKind } from '@necromancer/core';
import { exhume } from '@necromancer/excavate';
import { graveyard } from '@necromancer/graveyard';
import { DEFAULT_MODEL, type Effort, type StructuredModel } from '@necromancer/llm';
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
