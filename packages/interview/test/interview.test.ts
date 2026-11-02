import { describe, expect, it } from 'vitest';
import type { InterviewReport } from '@necromancer/core';
import { answerInterview, proposeIntent, verifyCitation, type RawProposal } from '@necromancer/interview';
import { ScriptedModel, type StructuredRequest } from '@necromancer/llm';
import { fixtureRepo, goodProposal } from './fixtures.js';

describe('proposeIntent', () => {
  it('shows the model the README, manifest, entry points and load-bearing files, and checks its citations', async () => {
    const root = await fixtureRepo();
    const model = new ScriptedModel(goodProposal);
    const { interview, exhume } = await proposeIntent(root, { model, effort: 'low' });

    const request = model.requests[0] as StructuredRequest<RawProposal>;
    expect(request.effort).toBe('low');
    expect(request.system).toContain('cite');
    for (const file of ['README.md', 'package.json', 'lib/index.js', 'bin/tq.js', 'lib/escape.js']) {
      expect(request.prompt).toContain(`<file path="${file}"`);
    }
    expect(request.prompt).toContain(' 7| Builder.prototype.where = function (clause) {');
    expect(request.prompt).toContain('engines: {"node":">=0.10"}');

    expect(exhume.stats.files).toBe(4);
    expect(interview.status).toBe('proposed');
    expect(interview.intent).toBe(goodProposal.summary);
    expect(interview.proposedBy).toEqual({ kind: 'claude-api', model: 'scripted', fellBack: false });
    expect(interview.evidence.map((e) => e.path)).toContain('README.md');

    const [chain, escape] = interview.proposal.capabilities;
    expect(chain!.evidence[0]).toMatchObject({ verified: true, startLine: 7, endLine: 10 });
    expect(escape!.evidence[0]).toMatchObject({ verified: true, startLine: 2, endLine: 2 });
    const [bin, missing] = interview.proposal.constraints[0]!.evidence;
    expect(bin!.verified).toBe(true);
    expect(missing!.verified).toBe(false);
    expect(interview.warnings).toEqual([
      '1 of 4 citations could not be found in the repo; treat those claims with suspicion',
      '1 citations pointed at the wrong lines and were corrected',
    ]);
  });

  it('reuses a saved exhume report for the same commit', async () => {
    const root = await fixtureRepo();
    const first = await proposeIntent(root, { model: new ScriptedModel(goodProposal) });
    const again = await proposeIntent(root, { model: new ScriptedModel(goodProposal), exhume: first.exhume });
    expect(again.exhume).toBe(first.exhume);
  });

  it('passes model errors through', async () => {
    const root = await fixtureRepo();
    await expect(proposeIntent(root, { model: new ScriptedModel(new Error('declined')) })).rejects.toThrow('declined');
  });
});

describe('verifyCitation', () => {
  it('refuses paths outside the repo', async () => {
    const root = await fixtureRepo();
    const check = await verifyCitation(root, { file: '../../../etc/passwd', startLine: 1, endLine: 1, quote: 'root:x:0:0' });
    expect(check.citation.verified).toBe(false);
  });

  it('accepts quotes that keep the line-number prefix or span lines', async () => {
    const root = await fixtureRepo();
    const check = await verifyCitation(root, {
      file: './lib/index.js',
      startLine: 3,
      endLine: 4,
      quote: '3| module.exports = function tq(table) {\n4|   return new Builder(table);',
    });
    expect(check.citation).toMatchObject({ file: 'lib/index.js', verified: true });
  });

  it('does not guess when a quote appears more than once', async () => {
    const root = await fixtureRepo();
    const check = await verifyCitation(root, { file: 'lib/builder.js', startLine: 30, endLine: 30, quote: 'this' });
    expect(check.citation.verified).toBe(false);
  });
});

describe('answerInterview', () => {
  const proposed = async (): Promise<InterviewReport> => (await proposeIntent(await fixtureRepo(), { model: new ScriptedModel(goodProposal) })).interview;

  it('confirms the summary and keeps picked goals in order, without duplicates', async () => {
    const answered = answerInterview(await proposed(), { confirm: true, acceptSuggested: [1, 0], goals: ['support node 22', 'Drop the CLI'] });
    expect(answered.status).toBe('confirmed');
    expect(answered.intent).toBe(goodProposal.summary);
    expect(answered.goals).toEqual([
      { text: 'Support Node 22', origin: 'suggested' },
      { text: 'Keep the where() API stable', origin: 'suggested' },
      { text: 'Drop the CLI', origin: 'user' },
    ]);
    expect(answered.answeredAt).not.toBeNull();
  });

  it('lets a correction replace the summary but keeps the proposal', async () => {
    const report = await proposed();
    const answered = answerInterview(report, { confirm: true, correction: '  An internal reporting tool.  ', acceptSuggested: 'all' });
    expect(answered).toMatchObject({ status: 'corrected', intent: 'An internal reporting tool.', corrections: 'An internal reporting tool.' });
    expect(answered.proposal).toEqual(report.proposal);
    expect(answered.goals).toHaveLength(3);
  });

  it('needs a confirmation or a correction, and real goal numbers', async () => {
    const report = await proposed();
    expect(() => answerInterview(report, { goals: ['x'] })).toThrow(/confirm/);
    expect(() => answerInterview(report, { confirm: true, acceptSuggested: [3] })).toThrow(/#4/);
  });
});
