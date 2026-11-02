# @necromancer/interview

Phase 4. Works out what an abandoned repo is for, with evidence, and records
what the user says about it, so later stages revive the right thing.

## How it works

1. **Evidence.** From the repo and its `exhume` report it picks, in order:
   the README, `package.json`, entry points (`main`, `module`, `bin`,
   `exports`), the load-bearing files, one file per remaining cluster, and
   the first doc, example and changelog. Each is shown with line numbers,
   up to 220 lines per file and 2,400 in total, after a short fact sheet
   (history span, clusters, most-imported packages, `engines`) and the
   source tree.
2. **Proposal.** One call to Claude through
   [`@necromancer/llm`](../llm) with a zod schema as the structured output
   format: a `summary`, `capabilities` and `constraints` (each a claim with
   citations), `suggestedGoals`, `openQuestions` and a `confidence`.
3. **Checking.** Each citation's quote is looked up in the file at the
   analysed commit, ignoring whitespace and allowing `...` between
   fragments. A quote on the cited lines (give or take two) is verified. A
   quote that appears exactly once elsewhere in the file is verified and its
   lines corrected. Anything else stays in the report with
   `verified: false`, and the report's `warnings` count it.
4. **Answer.** `answerInterview` records a confirmation or a correction,
   picked suggested goals and the user's own goals. `intent` is the summary
   or the correction; `status` is `proposed`, `confirmed` or `corrected`.

The result is saved as `interview.json` next to the other reports.

## API

```ts
import { proposeIntent, answerInterview } from '@necromancer/interview';
import { ClaudeModel } from '@necromancer/llm';

const { interview } = await proposeIntent('https://github.com/owner/repo', { model: new ClaudeModel(), effort: 'medium' });
const answered = answerInterview(interview, { confirm: true, acceptSuggested: [0, 2], goals: ['Run on Node 22'] });
```

`interviewBrief` returns the same evidence and system prompt without calling
a model, and `recordProposal` checks a proposal someone else wrote. The MCP
server uses them when the agent hosting it writes the proposal.

## Testing

Tests use `ScriptedModel` from `@necromancer/llm`, which replays canned
answers and validates them against the request's schema. No API key or
network is needed.
