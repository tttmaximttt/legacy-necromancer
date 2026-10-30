import type { Citation, ExhumeReport, IntentClaim, IntentProposal, InterviewGoal, InterviewReport } from '@necromancer/core';
import { checkout, exhume, headCommit, listRepoFiles, type ExhumeOptions } from '@necromancer/excavate';
import type { Effort, StructuredModel } from '@necromancer/llm';
import { z } from 'zod';
import { gatherEvidence, renderEvidence, verifyCitation, type EvidencePack, type GatherOptions } from './evidence.js';

const CitationSchema = z.object({
  file: z.string().describe('Path exactly as given in the <file path="…"> tag'),
  startLine: z.number().describe('First cited line, from the numbered listing'),
  endLine: z.number().describe('Last cited line, inclusive'),
  quote: z.string().describe('A short excerpt copied verbatim from those lines, under 120 characters'),
});

const ClaimSchema = z.object({
  claim: z.string(),
  evidence: z.array(CitationSchema).describe('One to three citations that back the claim'),
});

/** The shape the model (or an MCP host) fills in. Citations are checked against the repo afterwards. */
export const ProposalSchema = z.object({
  summary: z.string().describe('One or two sentences: what the project is and who it is for'),
  capabilities: z.array(ClaimSchema).describe('What the project does, most important first'),
  constraints: z
    .array(ClaimSchema)
    .describe('What a revival must not break: public API, CLI flags, file or wire formats, supported runtimes'),
  suggestedGoals: z.array(z.string()).describe('Three to six concrete goals for reviving it'),
  openQuestions: z.array(z.string()).describe('What the evidence does not settle, worth asking the owner'),
  confidence: z.enum(['high', 'medium', 'low']),
});

export type RawProposal = z.infer<typeof ProposalSchema>;

export const SYSTEM_PROMPT = `You are reading an abandoned JavaScript or TypeScript repository to work out what it is for, before anyone tries to revive it. The user will confirm or correct what you say, and later stages plan the revival from it, so accuracy matters more than coverage.

Ground every claim in the files you are shown. For each citation give the path exactly as it appears in the <file path="…"> tag, line numbers from that file's numbered listing, and a short quote copied verbatim from those lines (without the line-number prefix). A claim you cannot cite does not belong in the answer; put the doubt in openQuestions instead.

Where the README and the code disagree, believe the code and mention the disagreement in openQuestions. Constraints are what a revival must keep working: exported API, CLI commands and flags, file or wire formats, documented runtimes or browsers. Suggested goals should be specific to this project (for example "keep the v2 query-builder API stable while replacing the request library"), not generic advice.`;

export interface ProposeOptions extends GatherOptions {
  model: StructuredModel;
  effort?: Effort;
  /** Reuse a saved exhume report instead of running the excavator again; ignored if it is for another commit. */
  exhume?: ExhumeReport | null;
  exhumeOptions?: Omit<ExhumeOptions, 'onProgress' | 'keep' | 'workdir'>;
  workdir?: string;
  onProgress?: (message: string) => void;
}

export interface Proposed {
  interview: InterviewReport;
  /** The exhume report the evidence was picked from; new unless one was passed in. */
  exhume: ExhumeReport;
}

/** Phase 4, step 1: show the model the most telling files and ask what the project is for. */
export async function proposeIntent(source: string, options: ProposeOptions): Promise<Proposed> {
  const log = options.onProgress ?? (() => {});
  return withRepo(source, options, async (root, report, pack) => {
    log(`asking ${options.model.name} what the project is for (${pack.files.length} files as evidence)`);
    const result = await options.model.generate({
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(report, pack),
      schema: ProposalSchema,
      effort: options.effort ?? 'medium',
    });
    log('checking citations against the repo');
    const interview = await assemble(root, report, pack, result.output, {
      kind: 'claude-api',
      model: result.model,
      fellBack: result.fellBack,
    });
    if (result.fellBack) interview.warnings.push(`${options.model.name} declined; ${result.model} answered instead`);
    return { interview, exhume: report };
  });
}

export interface Brief {
  /** System prompt plus evidence, for an agent that proposes the intent itself. */
  instructions: string;
  evidence: string;
  exhume: ExhumeReport;
}

/** The same evidence, for an MCP host (an agent that is itself a model) to propose the intent without an API key. */
export async function interviewBrief(source: string, options: Omit<ProposeOptions, 'model' | 'effort'>): Promise<Brief> {
  return withRepo(source, options, async (_root, report, pack) => ({
    instructions: SYSTEM_PROMPT,
    evidence: buildPrompt(report, pack),
    exhume: report,
  }));
}

/** Checks and records a proposal an MCP host wrote from `interviewBrief`. */
export async function recordProposal(
  source: string,
  proposal: RawProposal,
  host: string,
  options: Omit<ProposeOptions, 'model' | 'effort'>,
): Promise<Proposed> {
  return withRepo(source, options, async (root, report, pack) => ({
    interview: await assemble(root, report, pack, proposal, { kind: 'host', name: host }),
    exhume: report,
  }));
}

async function withRepo<T>(
  source: string,
  options: Omit<ProposeOptions, 'model' | 'effort'>,
  fn: (root: string, report: ExhumeReport, pack: EvidencePack) => Promise<T>,
): Promise<T> {
  const log = options.onProgress ?? (() => {});
  log(`checking out ${source}`);
  const repo = await checkout(source, { workdir: options.workdir });
  try {
    let report = options.exhume ?? null;
    if (report && report.repo.commit !== (await headCommit(repo.root))) report = null;
    if (!report) {
      const local = await exhume(repo.root, { ...options.exhumeOptions, onProgress: log });
      report = { ...local, repo: { ...local.repo, source } };
    }
    const pack = await gatherEvidence(repo.root, report, await listRepoFiles(repo.root), options);
    if (!pack.files.length) throw new Error(`found nothing to read in ${source}: no README, manifest or source files`);
    return await fn(repo.root, report, pack);
  } finally {
    await repo.cleanup();
  }
}

export function buildPrompt(report: ExhumeReport, pack: EvidencePack): string {
  const h = report.history;
  const engines = report.manifests.find((m) => m.manifest === 'package.json')?.engines ?? {};
  const facts = [
    `Repository: ${report.repo.source}${report.repo.commit ? ` at ${report.repo.commit.slice(0, 12)}` : ''}`,
    h.firstCommit && h.lastCommit ? `History: ${h.commits} commits by ${h.authors} authors, ${h.firstCommit.slice(0, 10)} to ${h.lastCommit.slice(0, 10)}` : null,
    `Size: ${report.stats.files} source files, ${report.stats.loc} lines of code, ${report.stats.testFiles} test files`,
    `Module clusters (from the import graph): ${report.clusters.map((c) => `${c.label} (${c.size})`).join(', ') || 'none'}`,
    `Most-imported packages: ${report.externalPackages.slice(0, 15).map((p) => p.name).join(', ') || 'none'}`,
    Object.keys(engines).length ? `engines: ${JSON.stringify(engines)}` : null,
  ].filter(Boolean);
  return `${facts.join('\n')}\n\n${renderEvidence(pack)}\n\nWhat is this project for? Answer in the requested format, citing the files above.`;
}

async function assemble(
  root: string,
  report: ExhumeReport,
  pack: EvidencePack,
  raw: RawProposal,
  proposedBy: InterviewReport['proposedBy'],
): Promise<InterviewReport> {
  const cache = new Map<string, string[] | null>();
  let total = 0;
  let unverified = 0;
  let moved = 0;
  const claims = async (list: RawProposal['capabilities']): Promise<IntentClaim[]> => {
    const out: IntentClaim[] = [];
    for (const c of list) {
      const evidence: Citation[] = [];
      for (const e of c.evidence) {
        const check = await verifyCitation(root, e, cache);
        total++;
        if (!check.citation.verified) unverified++;
        if (check.moved) moved++;
        evidence.push(check.citation);
      }
      out.push({ claim: c.claim.trim(), evidence });
    }
    return out;
  };
  const proposal: IntentProposal = {
    summary: raw.summary.trim(),
    capabilities: await claims(raw.capabilities),
    constraints: await claims(raw.constraints),
    suggestedGoals: raw.suggestedGoals.map((g) => g.trim()).filter(Boolean),
    openQuestions: raw.openQuestions.map((q) => q.trim()).filter(Boolean),
    confidence: raw.confidence,
  };
  const warnings: string[] = [];
  if (unverified) warnings.push(`${unverified} of ${total} citations could not be found in the repo; treat those claims with suspicion`);
  if (moved) warnings.push(`${moved} citations pointed at the wrong lines and were corrected`);
  const uncited = [...proposal.capabilities, ...proposal.constraints].filter((c) => !c.evidence.some((e) => e.verified)).length;
  if (uncited) warnings.push(`${uncited} claims have no verified evidence`);

  return {
    repo: { source: report.repo.source, commit: report.repo.commit },
    generatedAt: new Date().toISOString(),
    proposedBy,
    evidence: pack.files.map((f) => ({ path: f.path, lines: f.lines.length, truncated: f.lines.length < f.totalLines })),
    proposal,
    status: 'proposed',
    intent: proposal.summary,
    corrections: null,
    goals: [],
    answeredAt: null,
    warnings,
  };
}

export interface InterviewAnswer {
  /** The user agrees with the proposed summary. Ignored when a correction is given. */
  confirm?: boolean;
  /** The user's own description of what the project is for; replaces the summary. */
  correction?: string | null;
  /** Indexes (0-based) into the proposal's suggested goals, or "all". */
  acceptSuggested?: number[] | 'all';
  /** Goals in the user's own words. */
  goals?: string[];
}

/** Phase 4, step 2: record what the user said. Pure; save the result with ReportStore. */
export function answerInterview(report: InterviewReport, answer: InterviewAnswer): InterviewReport {
  const correction = answer.correction?.trim() || null;
  if (!correction && !answer.confirm) throw new Error('confirm the proposed intent or give a correction');

  const suggested = report.proposal.suggestedGoals;
  const picked = answer.acceptSuggested === 'all' ? suggested.map((_, i) => i) : (answer.acceptSuggested ?? []);
  for (const i of picked) {
    if (!Number.isInteger(i) || i < 0 || i >= suggested.length) throw new Error(`no suggested goal #${i + 1}; there are ${suggested.length}`);
  }
  const goals: InterviewGoal[] = [];
  const add = (text: string, origin: InterviewGoal['origin']) => {
    const t = text.trim();
    if (t && !goals.some((g) => g.text.toLowerCase() === t.toLowerCase())) goals.push({ text: t, origin });
  };
  for (const i of picked) add(suggested[i]!, 'suggested');
  for (const g of answer.goals ?? []) add(g, 'user');

  return {
    ...report,
    status: correction ? 'corrected' : 'confirmed',
    intent: correction ?? report.proposal.summary,
    corrections: correction,
    goals,
    answeredAt: new Date().toISOString(),
  };
}
