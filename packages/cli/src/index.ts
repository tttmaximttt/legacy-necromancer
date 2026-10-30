import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { exhume } from '@necromancer/excavate';
import { graveyard } from '@necromancer/graveyard';

export function createProgram(): Command {
  const program = new Command('necromancer')
    .description('An AI archaeologist for abandoned JavaScript/TypeScript projects.')
    .version('0.0.0');

  program
    .command('exhume')
    .description('Reconstruct a repo’s architecture: module clusters, load-bearing files, churn, install-script audit.')
    .argument('<source>', 'git URL or local path')
    .option('-t, --top <n>', 'number of load-bearing files to report', (v) => Number.parseInt(v, 10), 5)
    .option('-s, --seed <n>', 'clustering seed', (v) => Number.parseInt(v, 10), 42)
    .option('-o, --out <file>', 'write the JSON report to a file instead of stdout')
    .option('-w, --workdir <dir>', 'where to clone remote repos')
    .option('-k, --keep', 'keep the clone after the run')
    .option('--include-tests', 'rank test files as load-bearing too')
    .option('-q, --quiet', 'no progress output on stderr')
    .action(async (source: string, opts: { top: number; seed: number; out?: string; workdir?: string; keep?: boolean; includeTests?: boolean; quiet?: boolean }) => {
      const report = await exhume(source, {
        top: opts.top,
        seed: opts.seed,
        workdir: opts.workdir,
        keep: opts.keep,
        includeTests: opts.includeTests,
        onProgress: opts.quiet ? undefined : (m) => process.stderr.write(`☠ ${m}\n`),
      });
      const json = `${JSON.stringify(report, null, 2)}\n`;
      if (opts.out) await writeFile(opts.out, json);
      else process.stdout.write(json);
    });

  program
    .command('graveyard')
    .description('Date the project and put a tombstone on every dependency: deprecated, archived, abandoned, vulnerable, outdated.')
    .argument('<source>', 'git URL or local path')
    .option('-a, --advisories <provider>', 'npm (same data as npm audit), osv, or none', 'npm')
    .option('--no-github', 'skip the GitHub archived check (set GITHUB_TOKEN to check every package)')
    .option('-o, --out <file>', 'write the JSON report to a file instead of stdout')
    .option('-w, --workdir <dir>', 'where to clone remote repos')
    .option('-q, --quiet', 'no progress output on stderr')
    .action(async (source: string, opts: { advisories: string; github: boolean; out?: string; workdir?: string; quiet?: boolean }) => {
      if (!['npm', 'osv', 'none'].includes(opts.advisories)) throw new Error(`unknown advisory provider: ${opts.advisories}`);
      const report = await graveyard(source, {
        advisories: opts.advisories as 'npm' | 'osv' | 'none',
        noGithub: !opts.github,
        workdir: opts.workdir,
        onProgress: opts.quiet ? undefined : (m) => process.stderr.write(`⚰ ${m}\n`),
      });
      const json = `${JSON.stringify(report, null, 2)}\n`;
      if (opts.out) await writeFile(opts.out, json);
      else process.stdout.write(json);
    });

  return program;
}
