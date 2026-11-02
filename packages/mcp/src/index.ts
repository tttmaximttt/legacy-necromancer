import { createRequire } from 'node:module';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ReportStore, slugFor, type ExhumeReport, type GraveyardReport, type InterviewReport, type ReportKind } from '@necromancer/core';
import { exhume as runExhume, type ExhumeOptions } from '@necromancer/excavate';
import { graveyard as runGraveyard, type GraveyardOptions } from '@necromancer/graveyard';
import { answerInterview, interviewBrief, proposeIntent, ProposalSchema, recordProposal } from '@necromancer/interview';
import { ClaudeModel, credentialsHint, hasCredentials, type StructuredModel } from '@necromancer/llm';
import { DEFAULT_MAX_ITERATIONS, DEFAULT_TOKEN_BUDGET, DockerSandbox, FixCache, resurrect, type Sandbox } from '@necromancer/resurrect';
import { compareWitness, witness } from '@necromancer/witness';

export interface ServerOptions {
  /** Injected in tests; defaults to the real excavator. */
  exhume?: (source: string, options: ExhumeOptions) => Promise<ExhumeReport>;
  graveyard?: (source: string, options: GraveyardOptions) => Promise<GraveyardReport>;
  /** Where remote repos are cloned. */
  workdir?: string;
  /** Where reports are saved for `necromancer ui`. Defaults to ~/.necromancer/reports. */
  store?: ReportStore;
  /** Model for the interview, Resurrect's fixes and Witness inputs. Defaults to Claude when an Anthropic API key is set. */
  model?: StructuredModel;
  /** Where Resurrect runs containers. Defaults to the local Docker daemon. */
  sandbox?: Sandbox;
}

/** Per-cluster file lists and lockfile notes get long on big repos; summaries keep the agent's context small. */
const SUMMARY_FILES_PER_CLUSTER = 8;
const SUMMARY_INFO_FINDINGS = 10;

export function createServer(options: ServerOptions = {}): McpServer {
  const exhume = options.exhume ?? runExhume;
  const graveyard = options.graveyard ?? runGraveyard;
  const store = options.store ?? new ReportStore();
  const saveNote = async (kind: ReportKind, report: Parameters<ReportStore['save']>[1]) => {
    try {
      return { savedTo: await store.save(kind, report), view: 'Run `necromancer ui` to browse it.' };
    } catch (err) {
      return { savedTo: null, saveError: err instanceof Error ? err.message : String(err) };
    }
  };
  const server = new McpServer({ name: 'necromancer', version: serverVersion() });

  server.registerTool(
    'exhume',
    {
      title: 'Exhume a repository',
      description:
        'Reconstruct the architecture of a JavaScript/TypeScript repository: module clusters, the most ' +
        'load-bearing files (blast radius, betweenness, git churn), external packages, git history span, ' +
        'install-time scripts that look suspicious, and imports that only work on case-insensitive filesystems. ' +
        'Read-only: clones the repo and parses it, never installs or runs anything. Takes seconds for most repos.',
      inputSchema: {
        source: z.string().min(1).describe('Git URL (https or ssh) or a local directory path'),
        top: z.number().int().min(1).max(50).default(5).describe('How many load-bearing files to return'),
        includeTests: z.boolean().default(false).describe('Treat test files as architecture too'),
        detail: z
          .enum(['summary', 'full'])
          .default('summary')
          .describe('"summary" trims cluster file lists and low-severity findings; "full" returns everything'),
        save: z.boolean().default(true).describe('Save the report so the user can browse it with `necromancer ui`'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ source, top, includeTests, detail, save }, extra) => {
      try {
        const report = await exhume(source, { top, includeTests, workdir: options.workdir, onProgress: progressReporter(extra) });
        const body = { ...(detail === 'full' ? report : summarize(report)), ...(save && (await saveNote('exhume', report))) };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return failure('exhume', err);
      }
    },
  );

  server.registerTool(
    'graveyard',
    {
      title: 'Dig the dependency graveyard',
      description:
        'Date a JavaScript/TypeScript project (git history, dependency publish dates, engines.node) and check every ' +
        'dependency against the npm registry, security advisories and GitHub: which are dead (deprecated, archived, ' +
        'unpublished), dying (no release in 3+ years) or ailing (vulnerable, far behind), the version the project ' +
        'actually used, and a suggested successor. Read-only. Check `sources` before concluding a package is healthy: ' +
        'a failed lookup means missing evidence.',
      inputSchema: {
        source: z.string().min(1).describe('Git URL (https or ssh) or a local directory path'),
        advisories: z.enum(['npm', 'osv', 'none']).default('npm').describe('Advisory database: npm (as npm audit), osv, or none'),
        github: z.boolean().default(true).describe('Check whether source repos are archived (uses GITHUB_TOKEN if set)'),
        detail: z
          .enum(['summary', 'full'])
          .default('summary')
          .describe('"summary" lists healthy dependencies by name only; "full" returns every tombstone in full'),
        save: z.boolean().default(true).describe('Save the report so the user can browse it with `necromancer ui`'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ source, advisories, github, detail, save }, extra) => {
      try {
        const report = await graveyard(source, {
          advisories,
          noGithub: !github,
          workdir: options.workdir,
          onProgress: progressReporter(extra),
        });
        const body = { ...(detail === 'full' ? report : summarizeGraveyard(report)), ...(save && (await saveNote('graveyard', report))) };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return failure('graveyard', err);
      }
    },
  );

  server.registerTool(
    'interview',
    {
      title: 'Propose what a repository is for',
      description:
        'Phase 4, step 1. Reads the README, manifest, entry points and load-bearing files of a JavaScript/TypeScript repo ' +
        'and proposes what the project is for: a summary, capabilities and constraints, each citing file:line evidence ' +
        'that is checked against the repo, plus suggested revival goals and open questions. With an Anthropic API key ' +
        'Claude writes the proposal; without one (proposer "host") the tool returns the evidence and you write it. Either ' +
        'way, show the proposal to the user, ask whether it is right and what their goals are, then call record_interview.',
      inputSchema: {
        source: z.string().min(1).describe('Git URL (https or ssh) or a local directory path'),
        proposer: z
          .enum(['auto', 'claude-api', 'host'])
          .default('auto')
          .describe('"claude-api" calls Claude; "host" returns the evidence for you to propose from; "auto" picks claude-api when a key is set'),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium').describe('How hard Claude thinks (claude-api only)'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ source, proposer, effort }, extra) => {
      try {
        const saved = await store.load(slugFor(source)).catch(() => null);
        const common = { exhume: saved?.exhume, workdir: options.workdir, onProgress: progressReporter(extra) };
        const useApi = proposer === 'claude-api' || (proposer === 'auto' && (options.model !== undefined || hasCredentials()));
        if (!useApi) {
          const brief = await interviewBrief(source, common);
          if (brief.exhume !== saved?.exhume) await saveNote('exhume', brief.exhume);
          return text({
            proposer: 'host',
            next:
              'Read the evidence and write a proposal in the record_interview `proposal` shape, citing files and line ' +
              'numbers from the numbered listings and quoting the lines verbatim. Show it to the user, ask whether it ' +
              'describes the project and which goals they want, then call record_interview with the proposal and their answer.',
            instructions: brief.instructions,
            evidence: brief.evidence,
          });
        }
        const model = options.model ?? new ClaudeModel();
        const { interview, exhume: report } = await proposeIntent(source, { ...common, model, effort });
        if (report !== saved?.exhume) await saveNote('exhume', report);
        return text({
          ...interview,
          ...(await saveNote('interview', interview)),
          next:
            'Show the user the summary, the capabilities and constraints with their citations (flag any that are not ' +
            'verified), the open questions and the numbered suggested goals. Ask whether the summary is right and which ' +
            'goals they want, then call record_interview with their answer. Do not answer for them.',
        });
      } catch (err) {
        return failure('interview', err);
      }
    },
  );

  server.registerTool(
    'record_interview',
    {
      title: 'Record what the user said the repository is for',
      description:
        'Phase 4, step 2. Records the user\'s answer to the interview: confirm the proposed intent or correct it in their ' +
        'own words, pick suggested goals by number, and add goals of their own. Later stages plan the revival from this. ' +
        'Pass `proposal` only if you wrote it yourself (proposer "host"); its citations are checked against the repo. ' +
        'Only call this with what the user actually said.',
      inputSchema: {
        source: z.string().min(1).describe('The same source given to interview'),
        confirm: z.boolean().default(false).describe('The user agrees with the proposed summary'),
        correction: z.string().optional().describe('What the user says the project is for, replacing the summary'),
        acceptGoals: z
          .union([z.array(z.number().int().min(1)), z.literal('all')])
          .optional()
          .describe('Suggested goals the user picked, by their 1-based number, or "all"'),
        goals: z.array(z.string()).default([]).describe('Goals in the user\'s own words'),
        proposal: ProposalSchema.optional().describe('Your own proposal, when interview returned evidence instead of one'),
        host: z.string().default('mcp-host').describe('Who wrote `proposal`, for the record'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ source, confirm, correction, acceptGoals, goals, proposal, host }, extra) => {
      try {
        let interview: InterviewReport;
        if (proposal) {
          const saved = await store.load(slugFor(source)).catch(() => null);
          interview = (await recordProposal(source, proposal, host, { exhume: saved?.exhume, workdir: options.workdir, onProgress: progressReporter(extra) }))
            .interview;
        } else {
          const saved = (await store.load(slugFor(source)))?.interview;
          if (!saved) throw new Error(`no interview saved for ${source}; call interview first`);
          interview = saved;
        }
        const answered = answerInterview(interview, {
          confirm,
          correction,
          acceptSuggested: acceptGoals === 'all' ? 'all' : acceptGoals?.map((n) => n - 1),
          goals,
        });
        const { savedTo, saveError } = await saveNote('interview', answered);
        return text({
          status: answered.status,
          intent: answered.intent,
          goals: answered.goals,
          warnings: answered.warnings,
          savedTo,
          ...(saveError && { saveError }),
        });
      } catch (err) {
        return failure('record_interview', err);
      }
    },
  );

  server.registerTool(
    'resurrect',
    {
      title: 'Bring a repository back to life in a sandbox',
      description:
        'Phase 5. Builds the project in Docker on the Node version of its era, with its databases (Mongo, Redis, Postgres, ' +
        'MySQL…) as sidecars, and boots it until a port answers. Failures are fixed from a table of known fixes, then by ' +
        'Claude if an Anthropic API key is set, for at most maxIterations attempts and tokenBudget tokens; otherwise it ends ' +
        'with BLOCKED and a reason. Sandbox: network only while installing dependencies, no host mounts, no credentials, ' +
        'CPU/memory/process/time limits. Takes minutes. Needs Docker on the machine running this server.',
      inputSchema: {
        source: z.string().min(1).describe('Git URL (https or ssh) or a local directory path'),
        maxIterations: z.number().int().min(1).max(DEFAULT_MAX_ITERATIONS).default(DEFAULT_MAX_ITERATIONS),
        tokenBudget: z.number().int().min(0).default(DEFAULT_TOKEN_BUDGET).describe('Tokens Claude may spend on fixes; 0 for known fixes only'),
        save: z.boolean().default(true).describe('Save the report so the user can browse it with `necromancer ui`'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ source, maxIterations, tokenBudget, save }, extra) => {
      try {
        const saved = await store.load(slugFor(source)).catch(() => null);
        const model = tokenBudget > 0 ? (options.model ?? (hasCredentials() ? new ClaudeModel() : null)) : null;
        const report = await resurrect(source, {
          sandbox: options.sandbox ?? new DockerSandbox(),
          model,
          maxIterations,
          tokenBudget,
          exhume: saved?.exhume,
          graveyard: saved?.graveyard,
          interview: saved?.interview,
          fixCache: new FixCache(path.join(path.dirname(store.dir), 'fix-cache.json')),
          workdir: options.workdir,
          onProgress: progressReporter(extra),
        });
        return text({
          outcome: report.outcome === 'resurrected' ? 'RESURRECTED' : `BLOCKED: ${report.blockedReason}`,
          health: report.health,
          era: report.era,
          services: report.services,
          attempts: report.attempts.map(({ errorExcerpt, ...a }) => ({
            ...a,
            ...(errorExcerpt && { errorExcerpt: errorExcerpt.split('\n').slice(-12).join('\n') }),
          })),
          llm: report.llm,
          warnings: report.warnings,
          dockerfile: report.dockerfile,
          compose: report.compose,
          ...(!model && tokenBudget > 0 && { note: `No Anthropic API key, so only known fixes were tried. To add one, ${credentialsHint()}.` }),
          ...(save && (await saveNote('resurrect', report))),
        });
      } catch (err) {
        return failure('resurrect', err);
      }
    },
  );

  server.registerTool(
    'witness',
    {
      title: 'Record how the revived app behaves',
      description:
        'Phase 6. Boots the app the way `resurrect` got it running, sends every route Exhume found one to three requests ' +
        '(written by Claude from the handler code when an Anthropic API key is set, placeholders otherwise), and records the ' +
        "responses as golden snapshots with timestamps, IDs, tokens and other volatile values blanked. Runs the project's " +
        'own tests next to it. With check: true, re-sends the saved golden requests and reports what changed instead of ' +
        'saving. Needs a prior `resurrect` and Docker; takes minutes.',
      inputSchema: {
        source: z.string().min(1).describe('Git URL (https or ssh) or a local directory path'),
        check: z.boolean().default(false).describe('Compare against the saved golden snapshots instead of replacing them'),
        runTests: z.boolean().default(true).describe("Run the project's test script"),
        save: z.boolean().default(true).describe('Save the snapshots as the new golden run (ignored with check)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ source, check, runTests, save }, extra) => {
      try {
        const saved = await store.load(slugFor(source)).catch(() => null);
        if (!saved?.resurrect) throw new Error('No resurrect report for this source; run the `resurrect` tool first.');
        if (check && !saved.witness) throw new Error('No golden snapshots to check against; run `witness` without check first.');
        const model = check ? null : (options.model ?? (hasCredentials() ? new ClaudeModel() : null));
        const report = await witness(source, {
          sandbox: options.sandbox ?? new DockerSandbox(),
          resurrect: saved.resurrect,
          exhume: saved.exhume,
          interview: saved.interview,
          model,
          cases: check ? saved.witness!.snapshots.map((s) => s.case) : undefined,
          runTests,
          workdir: options.workdir,
          onProgress: progressReporter(extra),
        });
        const summary = {
          routes: report.routes,
          inputs: report.inputs,
          tests: report.tests && { ...report.tests, logTail: report.tests.logTail.split('\n').slice(-15).join('\n') },
          warnings: report.warnings,
        };
        if (check) {
          const differences = compareWitness(saved.witness!, report);
          return text({ ...summary, unchanged: differences.length === 0, differences });
        }
        return text({
          ...summary,
          snapshots: report.snapshots.map((s) => ({
            request: `${s.case.method} ${s.case.path}`,
            name: s.case.name,
            status: s.response.status,
            error: s.response.error,
            body: truncate(JSON.stringify(s.response.body) ?? 'null', 400),
          })),
          ...(!model && { note: `No Anthropic API key, so each route got one placeholder request. To add one, ${credentialsHint()}.` }),
          ...(save && (await saveNote('witness', report))),
        });
      } catch (err) {
        return failure('witness', err);
      }
    },
  );

  server.registerPrompt(
    'autopsy',
    {
      title: 'Autopsy an abandoned repo',
      description: 'Exhume a repository and judge whether it is worth reviving.',
      argsSchema: { source: z.string().describe('Git URL or local path') },
    },
    ({ source }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Run the necromancer \`exhume\` and \`graveyard\` tools on ${source}. From the reports, tell me: what the project ` +
              'is and how it is structured (name the clusters by what they do, not by folder), which files are load-bearing ' +
              'and why, when it was alive, which dependencies are dead or dangerous and what replaces them, anything risky ' +
              'in its install scripts or imports, and whether it looks worth reviving. ' +
              'Quote numbers from the report; do not guess beyond it.',
          },
        },
      ],
    }),
  );

  return server;
}

/** Runs the server over stdin/stdout until the client disconnects. */
export async function runStdio(options: ServerOptions = {}): Promise<void> {
  // stdout carries the MCP protocol, so nothing else may write to it.
  await createServer(options).connect(new StdioServerTransport());
}

/** The version of the package this file was installed from: the npm package once bundled, else the workspace's. */
export function serverVersion(): string {
  return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function text(body: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
}

/** Forwards excavator progress as MCP progress notifications when the client asked for them. */
function progressReporter(extra: ToolExtra): ((message: string) => void) | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  let step = 0;
  return (message) => {
    void extra
      .sendNotification({ method: 'notifications/progress', params: { progressToken, progress: ++step, message } })
      .catch(() => {});
  };
}

function failure(tool: string, err: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `${tool} failed: ${err instanceof Error ? err.message : String(err)}` }],
  };
}

/** Healthy dependencies collapse to names; everything with a cause keeps its full tombstone. */
export function summarizeGraveyard(report: GraveyardReport) {
  const alive = report.tombstones.filter((t) => t.status === 'alive');
  return {
    ...report,
    tombstones: report.tombstones
      .filter((t) => t.status !== 'alive')
      .map(({ advisories, ...t }) => ({
        ...t,
        advisories: advisories.slice(0, 3).map(({ id, title, severity }) => ({ id, title, severity })),
        ...(advisories.length > 3 && { moreAdvisories: advisories.length - 3 }),
      })),
    alive: alive.map((t) => `${t.name}@${t.resolved ?? t.declared}`),
  };
}

/** Same shape as the report, with long lists cut and a note of how much was cut. */
export function summarize({ graph: _graph, ...report }: ExhumeReport) {
  const info = report.installScripts.filter((f) => f.severity === 'info');
  return {
    ...report,
    clusters: report.clusters.map(({ files, ...c }) => ({
      ...c,
      files: files.slice(0, SUMMARY_FILES_PER_CLUSTER),
      ...(files.length > SUMMARY_FILES_PER_CLUSTER && { moreFiles: files.length - SUMMARY_FILES_PER_CLUSTER }),
    })),
    orphans: report.orphans.slice(0, 20),
    externalPackages: report.externalPackages.slice(0, 30),
    manifests: report.manifests.map(({ manifest, name, engines, dependencies, devDependencies }) => ({
      manifest,
      name,
      engines,
      dependencies: Object.keys(dependencies).length,
      devDependencies: Object.keys(devDependencies).length,
    })),
    installScripts: [
      ...report.installScripts.filter((f) => f.severity !== 'info'),
      ...info.slice(0, SUMMARY_INFO_FINDINGS),
    ],
    truncated: {
      orphans: Math.max(0, report.orphans.length - 20),
      externalPackages: Math.max(0, report.externalPackages.length - 30),
      infoInstallScripts: Math.max(0, info.length - SUMMARY_INFO_FINDINGS),
      hint: 'Call exhume again with detail "full" for complete lists and per-manifest dependency versions.',
    },
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
