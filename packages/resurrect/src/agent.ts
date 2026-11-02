import type { BuildRecipe, InterviewReport, RecipeOp, ResurrectAttempt, ResurrectPhase } from '@necromancer/core';
import type { StructuredModel } from '@necromancer/llm';
import { z } from 'zod';
import { RecipeOpSchema } from './recipe.js';

export const FixProposalSchema = z.object({
  diagnosis: z.string().describe('What went wrong, in one or two sentences, quoting the decisive log line'),
  decision: z.enum(['fix', 'blocked']),
  ops: z.array(RecipeOpSchema).describe('The recipe changes to try next; empty when blocked'),
  blockedReason: z
    .string()
    .nullable()
    .describe('When blocked: why no recipe change can fix this, specific enough to act on, e.g. "needs a private npm registry (@acme/*)"'),
});

export type FixProposal = z.infer<typeof FixProposalSchema>;

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

Make the smallest change that addresses the actual error in the log, not a guess at the next one. Do not repeat a fix that was already tried. If no recipe change can fix it (the code itself is broken, it needs a private registry or a paid service, a required binary no longer exists anywhere), answer "blocked" with a reason someone can act on.`;

export interface ProposeInput {
  phase: ResurrectPhase;
  errorTail: string;
  recipe: BuildRecipe;
  dockerfile: string;
  dependencies: Record<string, string>;
  history: ResurrectAttempt[];
  interview: InterviewReport | null;
  /** Why the previous proposal was rejected, when asking again in the same attempt. */
  rejected?: string;
}

export function buildFixPrompt(input: ProposeInput): string {
  const tried = input.history
    .filter((a) => a.fix)
    .map((a) => `- attempt ${a.n} failed at ${a.phase}; applied ${a.fix!.id} (${a.fix!.source}): ${a.fix!.description}`);
  const goals = input.interview
    ? `\nWhat the project is for: ${input.interview.intent}${input.interview.goals.length ? `\nOwner's goals: ${input.interview.goals.map((g) => g.text).join('; ')}` : ''}\n`
    : '';
  return [
    goals,
    `Failed step: ${input.phase}`,
    tried.length ? `Already tried:\n${tried.join('\n')}` : 'Nothing tried yet.',
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
  const result = await model.generate({ system: FIX_SYSTEM_PROMPT, prompt: buildFixPrompt(input), schema: FixProposalSchema, effort: 'medium', maxTokens: 8000 });
  return {
    proposal: result.output as FixProposal & { ops: RecipeOp[] },
    tokens: result.usage.inputTokens + result.usage.outputTokens,
  };
}
