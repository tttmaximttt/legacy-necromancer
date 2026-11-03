import { createInterface } from 'node:readline/promises';
import { ReportStore, slugFor, type Citation, type IntentClaim, type InterviewReport } from '@necromancer/core';
import { answerInterview, proposeIntent, type InterviewAnswer } from '@necromancer/interview';
import { ClaudeModel, type Effort, type StructuredModel } from '@necromancer/llm';

export interface InterviewOptions {
  model: string;
  effort: Effort;
  fallbacks: boolean;
  yes?: boolean;
  correct?: string;
  acceptGoals?: string;
  goal?: string[];
  reuse?: boolean;
  reports?: string;
  workdir?: string;
  quiet?: boolean;
}

export interface InterviewIo {
  write: (text: string) => void;
  /** Asks the user a question; null when there is nobody to ask (no TTY). */
  ask: ((question: string) => Promise<string>) | null;
  /** Injected in tests; defaults to Claude via the Anthropic API. */
  model?: StructuredModel;
  close?: () => void;
}

/** Proposes the intent (or reuses the saved proposal), shows it, and records the user's answer from flags or prompts. */
export async function runInterview(source: string, opts: InterviewOptions, io: InterviewIo): Promise<{ report: InterviewReport; file: string }> {
  const store = new ReportStore(opts.reports);
  const saved = await store.load(slugFor(source));
  let report: InterviewReport;
  if (opts.reuse) {
    if (!saved?.interview) throw new Error(`no saved interview for ${source}; run without --reuse first`);
    report = saved.interview;
  } else {
    const model = io.model ?? new ClaudeModel({ model: opts.model, fallbacks: opts.fallbacks });
    const proposed = await proposeIntent(source, {
      model,
      effort: opts.effort,
      exhume: saved?.exhume,
      workdir: opts.workdir,
      onProgress: opts.quiet ? undefined : (m) => io.write(`☉ ${m}\n`),
    });
    if (proposed.exhume !== saved?.exhume) await store.save('exhume', proposed.exhume);
    report = proposed.interview;
    await store.save('interview', report);
  }

  io.write(formatProposal(report));

  const fromFlags = opts.yes || opts.correct !== undefined || opts.acceptGoals !== undefined || (opts.goal?.length ?? 0) > 0;
  let answer: InterviewAnswer | null = null;
  if (fromFlags) {
    answer = {
      confirm: opts.yes,
      correction: opts.correct,
      acceptSuggested: parseGoalPicks(opts.acceptGoals, report.proposal.suggestedGoals.length),
      goals: opts.goal,
    };
  } else if (io.ask) {
    answer = await askUser(report, io.ask, io.write);
  }

  if (answer) report = answerInterview(report, answer);
  const file = await store.save('interview', report);
  if (report.status === 'proposed') {
    io.write(
      `\nSaved the proposal, unanswered. Confirm or correct it with:\n` +
        `  necromancer interview --reuse ${source} --yes --accept-goals all\n` +
        `  necromancer interview --reuse ${source} --correct "what it is really for" --goal "…"\n`,
    );
  } else {
    io.write(`\n${report.status === 'confirmed' ? 'Confirmed' : 'Corrected'}: ${report.intent}\n`);
    if (report.goals.length) io.write(`Goals:\n${report.goals.map((g) => `  - ${g.text}`).join('\n')}\n`);
    io.write(`saved ${file}\n`);
  }
  return { report, file };
}

async function askUser(report: InterviewReport, ask: (q: string) => Promise<string>, write: (t: string) => void): Promise<InterviewAnswer> {
  const answer: InterviewAnswer = {};
  for (;;) {
    const reply = (await ask('\nIs that what the project is for? [Y]es / [n]o, let me correct it: ')).trim().toLowerCase();
    if (reply === '' || reply === 'y' || reply === 'yes') {
      answer.confirm = true;
      break;
    }
    if (reply === 'n' || reply === 'no') {
      const correction = (await ask('In a sentence or two, what is it for? ')).trim();
      if (correction) {
        answer.correction = correction;
        break;
      }
    }
    write('Please answer y or n.\n');
  }

  const count = report.proposal.suggestedGoals.length;
  if (count) {
    for (;;) {
      const picks = await ask(`Which suggested goals do you want? (e.g. 1,3, "all", or Enter for none): `);
      try {
        answer.acceptSuggested = parseGoalPicks(picks, count);
        break;
      } catch (err) {
        write(`${(err as Error).message}\n`);
      }
    }
  }

  answer.goals = [];
  write('Any goals of your own? One per line, empty line to finish.\n');
  for (;;) {
    const goal = (await ask('> ')).trim();
    if (!goal) break;
    answer.goals.push(goal);
  }
  return answer;
}

/** "1,3" → [0, 2]; "all" → "all"; "" → []. 1-based, as printed. */
export function parseGoalPicks(value: string | undefined, count: number): number[] | 'all' | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (!v || v === 'none') return [];
  if (v === 'all') return 'all';
  return v.split(/[\s,]+/).map((part) => {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > count) throw new Error(`"${part}" is not a goal number between 1 and ${count}`);
    return n - 1;
  });
}

export function formatProposal(report: InterviewReport): string {
  const p = report.proposal;
  const by = report.proposedBy.kind === 'claude-api' ? report.proposedBy.model : report.proposedBy.name;
  const cite = (c: Citation) => `${c.file}:${c.startLine}${c.endLine > c.startLine ? `-${c.endLine}` : ''}${c.verified ? '' : ' (not found)'}`;
  const claims = (list: IntentClaim[], bullet: (i: number) => string) =>
    list.map((c, i) => `  ${bullet(i)} ${c.claim}\n      ${c.evidence.map(cite).join(', ') || 'no evidence'}`).join('\n');
  const parts = [
    `\nWhat it seems to be for (${p.confidence} confidence, proposed by ${by}):`,
    `  ${p.summary}`,
    p.capabilities.length ? `\nWhat it does:\n${claims(p.capabilities, (i) => `${i + 1}.`)}` : '',
    p.constraints.length ? `\nWhat a revival must keep working:\n${claims(p.constraints, () => '-')}` : '',
    p.openQuestions.length ? `\nOpen questions:\n${p.openQuestions.map((q) => `  - ${q}`).join('\n')}` : '',
    p.suggestedGoals.length ? `\nSuggested goals:\n${p.suggestedGoals.map((g, i) => `  ${i + 1}. ${g}`).join('\n')}` : '',
    report.warnings.length ? `\n${report.warnings.map((w) => `⚠ ${w}`).join('\n')}` : '',
    report.status !== 'proposed' ? `\nAlready ${report.status}: ${report.intent}` : '',
  ];
  return `${parts.filter(Boolean).join('\n')}\n`;
}

/** What `ask` rejects with once the input has ended (Ctrl-D, or a closed pipe): nobody is left to answer. */
export class InputClosed extends Error {
  constructor() {
    super('the input ended before an answer was given');
    this.name = 'InputClosed';
  }
}

/**
 * Asks on the terminal when stdin and stderr are TTYs; `streams` (for tests) count as one. Once the input ends, a
 * pending question and every later one reject with `InputClosed`, where readline alone would never settle.
 */
export function terminalIo(streams?: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }): InterviewIo {
  const interactive = streams !== undefined || Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const { input, output } = streams ?? { input: process.stdin, output: process.stderr };
  let rl: ReturnType<typeof createInterface> | null = null;
  let closed = false;
  return {
    write: (t) => process.stderr.write(t),
    ask: interactive
      ? (q) => {
          if (closed) return Promise.reject(new InputClosed());
          rl ??= createInterface({ input, output }).once('close', () => (closed = true));
          const rli = rl;
          return new Promise<string>((resolve, reject) => {
            const onClose = () => reject(new InputClosed());
            rli.once('close', onClose);
            rli.question(q).then(
              (answer) => {
                rli.off('close', onClose);
                resolve(answer);
              },
              (err: unknown) => {
                rli.off('close', onClose);
                reject(closed ? new InputClosed() : err);
              },
            );
          });
        }
      : null,
    close: () => rl?.close(),
  };
}
