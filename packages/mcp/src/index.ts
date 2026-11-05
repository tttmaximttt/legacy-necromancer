import { createRequire } from 'node:module';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  errorMessage,
  ReportStore,
  slugFor,
  type ExhumeReport,
  type GraveyardReport,
  type InterviewReport,
  type PendingDecision,
  type ReportKind,
  type ResurrectReport,
  type SurgeonReport,
} from '@necromancer/core';
import { exhume as runExhume, type ExhumeOptions } from '@necromancer/excavate';
import { graveyard as runGraveyard, type GraveyardOptions } from '@necromancer/graveyard';
import { buildPlan, renderPlanMarkdown } from '@necromancer/plan';
import { answerInterview, interviewBrief, proposeIntent, ProposalSchema, recordProposal } from '@necromancer/interview';
import { ClaudeModel, credentialsHint, hasCredentials, type StructuredModel } from '@necromancer/llm';
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TOKEN_BUDGET,
  checkResumable,
  DockerSandbox,
  FixCache,
  prepareResume,
  ResumeError,
  resumeSettings,
  resurrect,
  type ResumableRun,
  type ResumeInput,
  type ResurrectOptions,
  type Sandbox,
} from '@necromancer/resurrect';
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_STEPS, loadSurgeonInputs, runSurgeon } from '@necromancer/surgeon';
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
const SUMMARY_ORPHANS = 20;
const SUMMARY_EXTERNAL_PACKAGES = 30;
const MAX_PLAN_STEPS = 30;
const SUMMARY_REASON_CHARS = 200;
const SUMMARY_WARNINGS = 10;

export function createServer(options: ServerOptions = {}): McpServer {
  const exhume = options.exhume ?? runExhume;
  const graveyard = options.graveyard ?? runGraveyard;
  const store = options.store ?? new ReportStore();
  const saveNote = async (kind: ReportKind, report: Parameters<ReportStore['save']>[1]) => {
    try {
      return { savedTo: await store.save(kind, report), view: 'Run `necromancer ui` to browse it.' };
    } catch (err) {
      return { savedTo: null, saveError: errorMessage(err) };
    }
  };
  /** Earlier reports for this source, or null when there are none or the store can't be read. */
  const loadSaved = (source: string) => store.load(slugFor(source)).catch(() => null);
  const defaultSandbox = () => options.sandbox ?? new DockerSandbox();
  const defaultModel = (name?: string) => options.model ?? (hasCredentials() ? new ClaudeModel({ model: name }) : null);
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
        return text(body);
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
        return text(body);
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
        const saved = await loadSaved(source);
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
          const saved = await loadSaved(source);
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
        'with BLOCKED and a reason. Built-in known fixes apply without asking and are listed in decisions. With approvals ' +
        '"ask", a cache or Claude fix that changes dependencies, the Node version or base image, system packages, install ' +
        'flags or environment variables (beyond a short allow-list of harmless ones), or what runs pauses the run with ' +
        'outcome NEEDS YOU, and so does a question only the user can answer: ask the user, ' +
        'then call resurrect again with resume: true and approve or answer. A paused run is always saved, since resume reads it, ' +
        'and so is any run that replaces a paused one (even with save: false), so resume never carries on a superseded run. ' +
        'Sandbox: network only while installing dependencies, no host mounts, no credentials, CPU/memory/process/time ' +
        'limits. Takes minutes. Needs Docker on the machine running this server.',
      inputSchema: {
        source: z.string().min(1).describe('Git URL (https or ssh) or a local directory path'),
        maxIterations: z
          .number()
          .int()
          .min(1)
          .max(DEFAULT_MAX_ITERATIONS)
          .optional()
          .describe(`Build attempts in total; default ${DEFAULT_MAX_ITERATIONS}, or the paused run's limit with resume`),
        tokenBudget: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(`Tokens Claude may spend on fixes, 0 for known fixes only; default ${DEFAULT_TOKEN_BUDGET}, or the paused run's budget with resume`),
        approvals: z
          .enum(['ask', 'all'])
          .default('ask')
          .describe('"ask" pauses on risky cache and Claude fixes so you can ask the user (built-in known fixes never wait); "all" applies them without asking, except that with resume the pending fix still needs approve'),
        resume: z.boolean().default(false).describe('Carry on from the saved run that ended NEEDS YOU, with approve or answer'),
        approve: z.boolean().optional().describe('With resume, for a pending fix: true applies it, false declines it and looks for another'),
        answer: z.string().optional().describe("With resume, for a pending question: the user's answer"),
        save: z
          .boolean()
          .default(true)
          .describe('Save the report so the user can browse it with `necromancer ui`; a run that pauses, resumes or replaces a paused run is saved regardless'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ source, maxIterations, tokenBudget, approvals, resume, approve, answer, save }, extra) => {
      try {
        // Without resume the run would start over and replace the paused one the decision was meant for.
        if ((approve !== undefined || answer !== undefined) && !resume) throw new Error('approve and answer go with resume: true; without it the paused run would be replaced by a new one.');
        if (approve !== undefined && answer !== undefined) throw new Error('pass approve for a pending fix or answer for a pending question, not both.');
        const saved = await loadSaved(source);
        const fixCache = new FixCache(path.join(path.dirname(store.dir), 'fix-cache.json'));
        const onProgress = progressReporter(extra);
        const approveFix: ResurrectOptions['approve'] = approvals === 'all' ? async () => 'auto-approve' : async () => 'pause';
        let report: ResurrectReport;
        let model: StructuredModel | null;
        // Whether a model was wanted and there is no key to build it, so only known fixes were tried.
        let noKey = false;
        if (resume) {
          // A blank answer is an empty reply, not the user's answer: say so rather than pausing again.
          if (answer !== undefined && !answer.trim()) throw new Error('answer is empty; pass what the user said, or ask them again.');
          const from = saved?.resurrect;
          if (!from) throw new Error('No resurrect report for this source; call `resurrect` without resume first.');
          // A resumed run asks the model the paused run asked, or none when it asked none; limits the caller did not
          // give stay as the paused run had them.
          const overrides = { maxIterations, tokenBudget };
          let input: ResumeInput;
          try {
            input = prepareResume(from, { model: (name) => defaultModel(name), overrides, approve, answer });
          } catch (err) {
            // Only on this error path: the model the paused run asked, which could not be built without a key.
            const wanted = err instanceof ResumeError && err.code === 'model-null' ? resumeSettings(from, overrides).model : null;
            if (!wanted) throw err;
            throw new Error(
              `the paused run asked ${wanted} for fixes, and there is no Anthropic API key; to add one, ${credentialsHint()}` +
                (from.pending?.kind === 'approval' ? ', or call again with tokenBudget: 0 to carry on with known and cached fixes only.' : '.'),
            );
          }
          model = input.run.model;
          // A resume runs with the paused run's settings, so the fresh-run options are not passed; its sandbox is set
          // up as the paused run's was.
          report = await resurrect(source, {
            sandbox: options.sandbox ?? new DockerSandbox(input.run.settings.sandbox ?? {}),
            model,
            fixCache,
            onProgress,
            approve: approveFix,
            resume: input,
          });
        } else {
          const wanted = (tokenBudget ?? DEFAULT_TOKEN_BUDGET) > 0;
          model = wanted ? defaultModel() : null;
          noKey = wanted && !model;
          report = await resurrect(source, {
            sandbox: defaultSandbox(),
            model,
            maxIterations: maxIterations ?? DEFAULT_MAX_ITERATIONS,
            tokenBudget: tokenBudget ?? DEFAULT_TOKEN_BUDGET,
            exhume: saved?.exhume,
            graveyard: saved?.graveyard,
            interview: saved?.interview,
            fixCache,
            workdir: options.workdir,
            onProgress,
            approve: approveFix,
          });
        }
        const paused = report.outcome === 'needs-you' && report.pending;
        return text({
          outcome: report.outcome === 'resurrected' ? 'RESURRECTED' : paused ? 'NEEDS YOU' : `BLOCKED: ${report.blockedReason}`,
          ...(paused && { pending: pendingSummary(report.pending!), next: nextStep('resurrect', report.pending!) }),
          health: report.health,
          era: report.era,
          services: report.services,
          attempts: report.attempts.map(({ errorExcerpt, ...a }) => ({
            ...a,
            ...(errorExcerpt && { errorExcerpt: errorExcerpt.split('\n').slice(-12).join('\n') }),
          })),
          decisions: (report.decisions ?? []).map(({ risks, ...d }) => ({ ...d, ...(risks && { risks: risks.map((r) => r.reason) }) })),
          llm: report.llm,
          warnings: report.warnings,
          dockerfile: report.dockerfile,
          compose: report.compose,
          ...(noKey && { note: `No Anthropic API key, so only known fixes were tried. To add one, ${credentialsHint()}.` }),
          // A resumed run, or a fresh one after a paused run, replaces the saved needs-you report, which resume would
          // otherwise read again and carry on a run this one superseded.
          ...((save || paused || resume || saved?.resurrect?.outcome === 'needs-you') && (await saveNote('resurrect', report))),
        });
      } catch (err) {
        return failure('resurrect', err, err instanceof ResumeError ? resumeHint('resurrect', err) : '');
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
        const saved = await loadSaved(source);
        if (!saved?.resurrect) throw new Error('No resurrect report for this source; run the `resurrect` tool first.');
        if (check && !saved.witness) throw new Error('No golden snapshots to check against; run `witness` without check first.');
        const model = check ? null : defaultModel();
        const report = await witness(source, {
          sandbox: defaultSandbox(),
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

  server.registerTool(
    'plan',
    {
      title: 'Plan the modernization',
      description:
        'Turns the saved reports for a repository into an ordered modernization plan: code fixes, dependency removals, ' +
        'replacements and upgrades, then the Node upgrade, lowest risk first, each followed by the check that proves ' +
        'nothing broke (the witness replay when there are golden snapshots). Deterministic; no network, no model. Needs a ' +
        'saved graveyard report; exhume, interview, resurrect and witness reports make it sharper. Saves plan.md next to ' +
        'the reports for the full text; the result names it in markdown, or gives markdownError when it could not be saved.',
      inputSchema: {
        source: z.string().min(1).describe('Git URL (https or ssh) or a local directory path, as given to the earlier tools'),
        save: z.boolean().default(true).describe('Save plan.json and plan.md next to the other reports'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ source, save }) => {
      try {
        const saved = await loadSaved(source);
        if (!saved?.graveyard) throw new Error('No graveyard report saved for this source; run the `graveyard` tool first.');
        const plan = buildPlan(saved, { source });
        let saveInfo = {};
        let markdown: string | null = null;
        let markdownError: string | undefined;
        if (save) {
          const note = await saveNote('plan', plan);
          try {
            markdown = await store.saveFile(source, 'plan.md', renderPlanMarkdown(plan));
          } catch (err) {
            markdownError = errorMessage(err);
          }
          saveInfo = { ...note, markdown, ...(markdownError && { markdownError }) };
        }
        const rest = plan.steps.length - MAX_PLAN_STEPS;
        return text({
          target: `Node ${plan.target.node}`,
          steps: [
            ...plan.steps.slice(0, MAX_PLAN_STEPS).map((s) => `${s.n}. ${s.title} (${s.risk}) → ${s.check.command}`),
            ...(rest > 0 ? [`…and ${rest} more; ${markdown ? `see ${markdown}` : markdownError ? 'plan.md could not be saved, as markdownError says' : 'call plan with save: true to write them all to plan.md'}`] : []),
          ],
          leftAlone: plan.leftAlone.length,
          warnings: plan.warnings,
          ...saveInfo,
        });
      } catch (err) {
        return failure('plan', err);
      }
    },
  );

  server.registerTool(
    'surgeon',
    {
      title: 'Upgrade a revived repository one step at a time',
      description:
        'Phase 7. Upgrades the recipe `resurrect` got running, one step at a time: dead, dying and ailing dependencies, then ' +
        'the Node version. It first checks that the unmodified recipe still matches the golden `witness` snapshots. Each ' +
        'step is built and booted in Docker with at most one fix, then the golden requests are replayed; the step is kept ' +
        'only when nothing differs, and rolled back otherwise. Stops BLOCKED when the maxSteps, maxAttempts or tokenBudget ' +
        'budget runs out. Risky fixes pause the run with status NEEDS YOU, as in resurrect: ask the user, then call surgeon ' +
        'again with resume: true and approve or answer. Returns a summary; the full report is saved. Needs saved graveyard, ' +
        'resurrect and witness reports, and Docker; takes minutes per step.',
      inputSchema: {
        source: z.string().min(1).describe('Git URL (https or ssh) or a local directory path, as given to the earlier tools'),
        maxSteps: z.number().int().min(0).optional().describe(`Steps that may run; default ${DEFAULT_MAX_STEPS}. Not with resume`),
        maxAttempts: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`Resurrect attempts in total, the baseline included; default ${DEFAULT_MAX_ATTEMPTS}. Not with resume`),
        tokenBudget: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(`Tokens Claude may spend on fixes across every step, 0 for known fixes only; default ${DEFAULT_TOKEN_BUDGET}. Not with resume`),
        targetNode: z.string().min(1).optional().describe('The Node release to end on, e.g. "24"; default the one `plan` targets. Not with resume'),
        approvals: z
          .enum(['ask', 'all'])
          .default('ask')
          .describe('"ask" pauses on risky cache and Claude fixes so you can ask the user; "all" applies them without asking, except that with resume the pending fix still needs approve'),
        resume: z.boolean().default(false).describe('Carry on from the saved run that ended NEEDS YOU, with approve or answer; its budgets stand'),
        approve: z.boolean().optional().describe('With resume, for a pending fix: true applies it, false declines it'),
        answer: z.string().optional().describe("With resume, for a pending question: the user's answer"),
        save: z
          .boolean()
          .default(true)
          .describe('Save the report so the user can browse it with `necromancer ui`; a run that pauses, resumes or replaces a paused run is saved regardless'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ source, maxSteps, maxAttempts, tokenBudget, targetNode, approvals, resume, approve, answer, save }, extra) => {
      try {
        if ((approve !== undefined || answer !== undefined) && !resume) throw new Error('approve and answer go with resume: true; without it the paused run would be replaced by a new one.');
        if (approve !== undefined && answer !== undefined) throw new Error('pass approve for a pending fix or answer for a pending question, not both.');
        const saved = await loadSurgeonInputs(store, source);
        const fixCache = new FixCache(path.join(path.dirname(store.dir), 'fix-cache.json'));
        const onProgress = progressReporter(extra);
        const approveFix: ResurrectOptions['approve'] = approvals === 'all' ? async () => 'auto-approve' : async () => 'pause';
        let report: SurgeonReport;
        let noKey = false;
        if (resume) {
          const fresh = Object.entries({ maxSteps, maxAttempts, tokenBudget, targetNode }).filter(([, v]) => v !== undefined).map(([k]) => k);
          if (fresh.length) throw new Error(`${fresh.join(', ')} ${fresh.length === 1 ? 'goes' : 'go'} with a new run; a resumed run keeps the paused run's budgets and settings.`);
          if (answer !== undefined && !answer.trim()) throw new Error('answer is empty; pass what the user said, or ask them again.');
          const inner = saved.surgeon?.status === 'needs-you' ? saved.surgeon.resume?.inner : undefined;
          if (!inner) throw new Error('No surgeon run is waiting on the user for this source; call `surgeon` without resume to start one.');
          let run: ResumableRun;
          try {
            // The model the paused step asked, or none when it asked none.
            run = checkResumable(inner, { model: (name) => defaultModel(name) });
          } catch (err) {
            if (!(err instanceof ResumeError && err.code === 'model-null')) throw err;
            throw new Error(
              `the paused run asked ${resumeSettings(inner).model} for fixes, and there is no Anthropic API key; to add one, ${credentialsHint()}, ` +
                'or call surgeon without resume to start a new run with tokenBudget: 0.',
            );
          }
          report = await runSurgeon(
            { source },
            { sandbox: options.sandbox ?? new DockerSandbox(run.settings.sandbox ?? {}), store, model: run.model, fixCache, approve: approveFix, onProgress },
            { save: false, resume: { approve, answer } },
          );
        } else {
          const wanted = (tokenBudget ?? DEFAULT_TOKEN_BUDGET) > 0;
          const model = wanted ? defaultModel() : null;
          noKey = wanted && !model;
          report = await runSurgeon(
            { source },
            { sandbox: defaultSandbox(), store, model, fixCache, approve: approveFix, onProgress },
            { save: false, maxSteps, maxAttempts, tokenBudget, targetNode, workdir: options.workdir },
          );
        }
        const paused = report.status === 'needs-you';
        return text({
          ...summarizeSurgeon(report),
          ...(noKey && { note: `No Anthropic API key, so only known fixes were tried. To add one, ${credentialsHint()}.` }),
          // As for resurrect: a paused run is saved for resume, and a later run replaces a saved paused one.
          ...((save || paused || resume || saved.surgeon?.status === 'needs-you') && (await saveNote('surgeon', report))),
        });
      } catch (err) {
        return failure('surgeon', err, err instanceof ResumeError ? resumeHint('surgeon', err) : '');
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

/** What a paused run waits on, without the full fix ops' noise. */
function pendingSummary(pending: PendingDecision) {
  if (pending.kind === 'question') return { kind: pending.kind, question: pending.question, context: pending.context, choices: pending.choices };
  const { fix, risks } = pending;
  return { kind: pending.kind, fix: { source: fix.source, id: fix.id, description: fix.description }, risks: risks.map((r) => r.reason) };
}

function nextStep(tool: 'resurrect' | 'surgeon', pending: PendingDecision): string {
  return pending.kind === 'question'
    ? `Ask the user this question in their own words, offering the choices but accepting any answer. Then call ${tool} ` +
        'again with the same source, resume: true and answer set to what they said (for a choice, its text, not its number). ' +
        'Do not answer for them, and do not ' +
        'ask them for passwords, keys or other secrets.'
    : `Show the user the fix and what it would change (risks), and ask whether to apply it. Then call ${tool} again ` +
        'with the same source, resume: true and approve: true to apply it, or approve: false to decline it and look for ' +
        'another. Do not decide for them.';
}

function failure(tool: string, err: unknown, hint = '') {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `${tool} failed: ${errorMessage(err)}${hint && ` ${hint}`}` }],
  };
}

/** What the host can do about a refused resume, by the `ResumeError` code; empty where the message already says it. */
function resumeHint(tool: 'resurrect' | 'surgeon', err: ResumeError): string {
  switch (err.code) {
    case 'not-paused':
    case 'no-state':
      return `Call ${tool} without resume to start a new run.`;
    case 'budget-spent':
    case 'model-without-budget':
      // A surgeon resume keeps the paused run's budgets.
      return tool === 'surgeon' ? 'Call surgeon without resume to start a new run with a larger tokenBudget.' : 'Call again with a larger tokenBudget.';
    case 'no-model':
      return tool === 'surgeon'
        ? 'A pending question needs a model, and the paused run has none: call surgeon without resume to start a new run.'
        : 'A pending question needs a model: call again with a tokenBudget above 0, or, if the paused run used no model, call resurrect without resume to start a new run.';
    case 'needs-approve':
      return 'Ask the user whether to apply the pending fix, then call again with approve: true or false; approvals: "all" does not answer it.';
    case 'needs-answer':
      return 'Ask the user the pending question, then call again with answer set to what they said.';
    case 'wrong-kind':
    case 'model-null':
    case 'model-mismatch':
      return '';
  }
}

/** A surgeon run in brief: the outcome, counts, and each step's id, status and short reason; the full report is saved. */
export function summarizeSurgeon(report: SurgeonReport) {
  const short = (reason: string | null) => reason && truncate(reason, SUMMARY_REASON_CHARS);
  const paused = report.status === 'needs-you' && report.pending;
  return {
    status: report.status === 'complete' ? 'COMPLETE' : paused ? 'NEEDS YOU' : `BLOCKED: ${report.blockedReason}`,
    ...(paused && { pausedAt: report.remaining[0]?.id ?? null, pending: pendingSummary(report.pending!), next: nextStep('surgeon', report.pending!) }),
    target: `Node ${report.target.node}`,
    nodeImage: report.recipe.nodeImage,
    baseline: { ok: report.baseline.ok, reason: short(report.baseline.reason) },
    summary: report.summary,
    steps: report.results.map((r) => ({
      id: r.step.id,
      status: r.status,
      ...(r.reason && { reason: short(r.reason) }),
      ...(r.failedAt && { failedAt: r.failedAt }),
      ...(r.fix && { fix: r.fix.description }),
      ...(r.diff?.total && { differences: r.diff.byKind }),
    })),
    remaining: report.remaining.map((s) => s.id),
    used: report.used,
    budgets: { maxSteps: report.budgets.maxSteps, maxAttempts: report.budgets.maxAttempts, tokenBudget: report.budgets.tokenBudget },
    warnings: report.warnings.slice(0, SUMMARY_WARNINGS),
    ...(report.warnings.length > SUMMARY_WARNINGS && { moreWarnings: report.warnings.length - SUMMARY_WARNINGS }),
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
    orphans: report.orphans.slice(0, SUMMARY_ORPHANS),
    // The file lists are for the plan, which reads the saved report; counts are enough here.
    externalPackages: report.externalPackages
      .slice(0, SUMMARY_EXTERNAL_PACKAGES)
      .map(({ importers: _importers, referencedBy: _referencedBy, ...p }) => p),
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
      orphans: Math.max(0, report.orphans.length - SUMMARY_ORPHANS),
      externalPackages: Math.max(0, report.externalPackages.length - SUMMARY_EXTERNAL_PACKAGES),
      infoInstallScripts: Math.max(0, info.length - SUMMARY_INFO_FINDINGS),
      hint: 'Call exhume again with detail "full" for complete lists and per-manifest dependency versions.',
    },
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
