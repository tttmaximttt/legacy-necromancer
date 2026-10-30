import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReportStore } from '@necromancer/core';
import { ScriptedModel } from '@necromancer/llm';
import { formatProposal, parseGoalPicks, runInterview, type InterviewOptions } from '../src/interview.js';
import { fixtureRepo, goodProposal } from '../../interview/test/fixtures.js';

async function setup() {
  const root = await fixtureRepo();
  const reports = await mkdtemp(path.join(os.tmpdir(), 'necro-cli-store-'));
  const output: string[] = [];
  const opts: InterviewOptions = { model: 'claude-opus-5-5', effort: 'medium', fallbacks: true, reports, quiet: true };
  return { root, reports, output, opts, write: (t: string) => void output.push(t) };
}

describe('necromancer interview', () => {
  it('answers from flags and saves the interview and the exhume report', async () => {
    const { root, reports, output, opts, write } = await setup();
    const { report, file } = await runInterview(
      root,
      { ...opts, yes: true, acceptGoals: '2', goal: ['Add TypeScript types'] },
      { write, ask: null, model: new ScriptedModel(goodProposal) },
    );
    expect(report.status).toBe('confirmed');
    expect(report.goals.map((g) => g.text)).toEqual(['Support Node 22', 'Add TypeScript types']);
    expect(file).toBe(path.join(reports, path.basename(root), 'interview.json'));

    const saved = await new ReportStore(reports).load(path.basename(root));
    expect(saved?.interview?.status).toBe('confirmed');
    expect(saved?.exhume?.stats.files).toBe(4);
    const text = output.join('');
    expect(text).toContain('lib/builder.js:7-10');
    expect(text).toContain('lib/missing.js:1-2 (not found)');
    expect(text).toContain('Confirmed: A chainable SQL query builder');
  });

  it('asks interactively when there are no answer flags', async () => {
    const { root, opts, write } = await setup();
    const replies = ['maybe', 'n', 'An ORM for reporting dashboards', '7', '1,3', 'Remove the CLI', ''];
    const questions: string[] = [];
    const ask = async (q: string) => {
      questions.push(q);
      return replies.shift() ?? '';
    };
    const { report } = await runInterview(root, opts, { write, ask, model: new ScriptedModel(goodProposal) });
    expect(report).toMatchObject({ status: 'corrected', intent: 'An ORM for reporting dashboards' });
    expect(report.goals).toEqual([
      { text: 'Keep the where() API stable', origin: 'suggested' },
      { text: 'Publish ESM types', origin: 'suggested' },
      { text: 'Remove the CLI', origin: 'user' },
    ]);
    expect(questions.filter((q) => q.startsWith('Which suggested goals'))).toHaveLength(2);
  });

  it('saves an unanswered proposal without a TTY, and --reuse answers it later without the model', async () => {
    const { root, output, opts, write } = await setup();
    const first = await runInterview(root, opts, { write, ask: null, model: new ScriptedModel(goodProposal) });
    expect(first.report.status).toBe('proposed');
    expect(output.join('')).toContain('--reuse');

    const second = await runInterview(root, { ...opts, reuse: true, correct: 'A teaching example' }, { write, ask: null, model: new ScriptedModel() });
    expect(second.report).toMatchObject({ status: 'corrected', intent: 'A teaching example' });
    expect(second.report.proposal).toEqual(first.report.proposal);
  });

  it('parses goal picks', () => {
    expect(parseGoalPicks(undefined, 3)).toBeUndefined();
    expect(parseGoalPicks('', 3)).toEqual([]);
    expect(parseGoalPicks('ALL', 3)).toBe('all');
    expect(parseGoalPicks('3, 1', 3)).toEqual([2, 0]);
    expect(() => parseGoalPicks('0', 3)).toThrow(/between 1 and 3/);
  });

  it('formats a proposal for the terminal', async () => {
    const { root, opts, write } = await setup();
    const { report } = await runInterview(root, opts, { write, ask: null, model: new ScriptedModel(goodProposal) });
    const text = formatProposal(report);
    expect(text).toContain('(medium confidence, proposed by scripted)');
    expect(text).toContain('  2. Support Node 22');
    expect(text).toContain('⚠ 1 of 4 citations could not be found');
  });
});
