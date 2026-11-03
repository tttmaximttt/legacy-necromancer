import type { BuildRecipe, OwnerDecision, RecipeOp, ResurrectAttempt, ResurrectPhase, ResurrectRunState } from '@necromancer/core';
import type { StructuredModel } from '@necromancer/llm';
import { z } from 'zod';
import { RecipeOpSchema } from './recipe.js';

export const FixProposalSchema = z.object({
  diagnosis: z.string().describe('What went wrong, in one or two sentences, quoting the decisive log line'),
  decision: z
    .enum(['fix', 'ask', 'blocked'])
    .describe(
      '"fix" to try recipe changes; "ask" only when the owner has information or a choice that would unblock it; "blocked" when nothing anyone could say would fix it',
    ),
  ops: z.array(RecipeOpSchema).describe('The recipe changes to try next; empty when asking or blocked'),
  blockedReason: z
    .string()
    .nullable()
    .describe('When blocked: why no recipe change can fix this, specific enough to act on, e.g. "the code calls a binary that no longer exists anywhere". null otherwise'),
  question: z
    .string()
    .nullable()
    .describe(
      'When asking: one question the owner can answer without reading the log, e.g. "@acme/core is private and not on npm. Replace it with a stub, or drop the feature that uses it?". Never ask for credentials, tokens or other secrets. null when fixing',
    ),
  choices: z
    .array(z.string())
    .describe('When asking: two to four short, concrete answers to pick from, e.g. ["stub @acme/core", "drop the export feature"]; empty when fixing'),
});

export type FixProposal = z.infer<typeof FixProposalSchema>;

/** `FixProposalSchema` for when the owner has answered all the questions they will about this failure: no "ask". */
export const FixProposalNoAskSchema = FixProposalSchema.extend({
  decision: z
    .enum(['fix', 'blocked'])
    .describe('"fix" to try recipe changes; "blocked" when no recipe change can fix this. The owner takes no more questions about this failure'),
});

export const NO_MORE_QUESTIONS =
  'The owner has answered all the questions they will about this failure, so you can no longer ask: propose a fix, or answer "blocked".';

export const FIX_SYSTEM_PROMPT = `You get abandoned Node.js projects installing, building and booting inside a locked-down Docker sandbox. Each attempt failed at one step; you see the tail of that step's log and decide the next change.

You cannot edit the project's source code or the Dockerfile directly. You change a build recipe with ops:
- setNodeImage {tag}: an official node image tag, e.g. "8", "10.24-stretch". Keep the project's era unless the error requires a different Node.
- aptInstall {packages}: Debian packages, e.g. python, make, g++, libcairo2-dev.
- useDebianArchive: for end-of-life Debian releases whose apt mirrors moved.
- setEnv {name, value}: build- and run-time variables. Never credentials; none are available.
- setDependency {name, version, dev?} / removeDependency {name}: edit package.json in the build copy, e.g. pin a sub-dependency that broke, or swap a dead package for a maintained drop-in.
- addInstallFlags {flags}: e.g. --legacy-peer-deps, --ignore-engines, --ignore-scripts (last resort: skips native builds).
- dropLockfile: let the package manager re-resolve when the lockfile is unusable.
- globalInstall {spec}, runBeforeInstall {command}: tools the install needs.
- setBuildCommand / setStartCommand {command|null}, setPort {port|null}: how the app is built, started and health-checked.

Only the install step has network access. The build script and the app run with no network, next to any databases the project uses on localhost.

Make the smallest change that addresses the actual error in the log, not a guess at the next one. Do not repeat a fix that was already tried, or one the owner declined.

Answer "blocked" when nothing anyone could say would fix it: the code itself is broken, a required binary no longer exists anywhere, it needs a paid service. Give a reason someone can act on.

Answer "ask" only when the owner has information or a choice that would unblock it and no recipe change can get past the error without it: which replacement to use for a private or vanished package, whether dropping a feature or a dependency is acceptable, which of two incompatible setups the project really used. Ask one specific question with a few concrete choices. Never ask for credentials, tokens or other secrets; none can enter the sandbox. Use the owner's earlier answers instead of asking again.`;

export interface ProposeInput {
  phase: ResurrectPhase;
  errorTail: string;
  recipe: BuildRecipe;
  dockerfile: string;
  dependencies: Record<string, string>;
  history: ResurrectAttempt[];
  /** The project's intent and the owner's goals, from the interview the run started with. */
  interview: ResurrectRunState['interview'];
  /** Why the previous proposal was rejected, when asking again in the same attempt. */
  rejected?: string;
  /** The decisions so far in this run; only the owner's (by "owner") are shown, as theirs. */
  decisions?: OwnerDecision[];
  /** The owner's answer to the question the model asked about this failure. */
  answer?: string;
  /** false once the owner has answered as many questions about this failure as they will; "ask" is then not offered. */
  canAsk?: boolean;
}

export function buildFixPrompt(input: ProposeInput): string {
  const tried = input.history
    .filter((a) => a.fix)
    .map((a) => `- attempt ${a.n} failed at ${a.phase}; applied ${a.fix!.id} (${a.fix!.source}): ${a.fix!.description}`);
  // Fixes applied without asking are already in "Already tried"; only what the owner chose is shown as theirs.
  const decisions = (input.decisions ?? []).filter((d) => d.by !== 'auto').map((d) =>
    d.kind === 'question'
      ? `- attempt ${d.attempt}: asked "${d.subject}"; the owner answered: ${d.answer}`
      : `- attempt ${d.attempt}: the owner ${d.answer} fix ${d.subject.startsWith('llm:') && d.description ? `"${d.description}"` : d.subject}`,
  );
  const goals = input.interview
    ? `\nWhat the project is for: ${input.interview.intent}${input.interview.goals.length ? `\nOwner's goals: ${input.interview.goals.join('; ')}` : ''}\n`
    : '';
  return [
    goals,
    `Failed step: ${input.phase}`,
    tried.length ? `Already tried:\n${tried.join('\n')}` : 'Nothing tried yet.',
    decisions.length ? `\nThe owner's decisions so far:\n${decisions.join('\n')}` : '',
    input.answer ? `\nThe owner answered your question: ${input.answer}` : '',
    input.canAsk === false ? `\n${NO_MORE_QUESTIONS}` : '',
    input.rejected ? `\nYour previous proposal was rejected: ${input.rejected}. Propose something else.` : '',
    `\nCurrent recipe:\n${JSON.stringify(input.recipe, null, 2)}`,
    `\nDockerfile rendered from it:\n${input.dockerfile}`,
    `\nDependencies:\n${JSON.stringify(input.dependencies)}`,
    `\n<log step="${input.phase}">\n${input.errorTail}\n</log>`,
  ].join('\n');
}

export async function proposeFix(
  model: StructuredModel,
  input: ProposeInput,
): Promise<{ proposal: FixProposal & { ops: RecipeOp[] }; tokens: number }> {
  const schema: z.ZodType<FixProposal> = input.canAsk === false ? FixProposalNoAskSchema : FixProposalSchema;
  const result = await model.generate({ system: FIX_SYSTEM_PROMPT, prompt: buildFixPrompt(input), schema, effort: 'medium', maxTokens: 8000 });
  return {
    proposal: result.output as FixProposal & { ops: RecipeOp[] },
    tokens: result.usage.inputTokens + result.usage.outputTokens,
  };
}
