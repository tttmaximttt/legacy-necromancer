import { nodeLine, type GraveyardReport, type ResurrectReport, type SurgeonStep, type Tombstone } from '@necromancer/core';
import { TARGET_NODE } from '@necromancer/plan';
import { validateOp } from '@necromancer/resurrect';

export interface PlanStepsInputs {
  graveyard: GraveyardReport;
  resurrect: ResurrectReport;
}

export interface PlanStepsOptions {
  /** Defaults to TARGET_NODE from @necromancer/plan. */
  targetNode?: string;
}

type UpgradeStatus = 'dead' | 'dying' | 'ailing';

const STATUS_RANK: Record<UpgradeStatus, number> = { dead: 0, dying: 1, ailing: 2 };

// Code-unit order, not localeCompare, so the plan is the same on every machine.
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isUpgradeable = (t: Tombstone): t is Tombstone & { status: UpgradeStatus } => t.status in STATUS_RANK;

/**
 * The upgrade steps surgeon tries, in order: the Node bump first, then dead, dying and ailing dependencies,
 * one op per step. Steps the plan already knows can't be done carry a `skip` reason.
 * Pure and deterministic: no network, no model, no files, no clock.
 */
export function planSteps(inputs: PlanStepsInputs, options: PlanStepsOptions = {}): SurgeonStep[] {
  const target = options.targetNode ?? TARGET_NODE;
  const recipe = inputs.resurrect.recipe;
  const steps: Array<Omit<SurgeonStep, 'n'>> = [];

  const from = nodeLine(recipe.nodeImage);
  if (from === null || from.startsWith('0.') || Number(from) < Number(target)) {
    steps.push({
      id: `node:${target}`,
      kind: 'upgrade-node',
      title: `Move to Node ${target}`,
      // The plain major: the era's variant (e.g. "stretch") doesn't exist for new majors.
      op: { op: 'setNodeImage', tag: target },
      change: { name: 'node', from, to: target },
      status: null,
      dev: false,
      why: [`The recipe boots on ${recipe.nodeImage}${from === null ? '' : ` (Node ${from})`}; Node ${target} is the target release.`],
      skip: null,
    });
  }

  const deps = inputs.graveyard.tombstones.filter(isUpgradeable).sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      Number(a.dev) - Number(b.dev) ||
      (a.majorsBehind ?? Infinity) - (b.majorsBehind ?? Infinity) ||
      compare(a.name, b.name),
  );
  for (const t of deps) {
    const current = t.resolved ?? t.declared;
    const version = t.latest ?? current;
    const op = { op: 'setDependency' as const, name: t.name, version, dev: t.dev };
    const why = t.causes.map((c) => c.detail);
    if (t.advisories.length) why.push(`Advisories: ${t.advisories.map((a) => a.id).join(', ')}`);
    steps.push({
      id: `dep:${t.name}`,
      kind: 'upgrade-dependency',
      title: version === current ? `Keep ${t.name} at ${current}` : `Upgrade ${t.name} from ${current} to ${version}`,
      op,
      change: { name: t.name, from: current, to: version },
      status: t.status,
      dev: t.dev,
      why,
      skip: skipReason(t, op, recipe.dependencyPatches),
    });
  }

  return steps.map((s, i) => ({ n: i + 1, ...s }));
}

/** The first rule that rules a dependency step out before it runs, or null. */
function skipReason(t: Tombstone, op: SurgeonStep['op'], patches: ResurrectReport['recipe']['dependencyPatches']): string | null {
  const pinned = Object.hasOwn(patches, t.name) ? patches[t.name] : undefined;
  if (pinned) return pinned.version === null ? 'resurrect removed it to boot' : `resurrect pinned it to ${pinned.version} to boot`;
  if (t.latest === null) return 'no release found on the registry';
  if (t.latest === (t.resolved ?? t.declared)) {
    return t.replacement ? `needs a code change: replace with ${t.replacement.name}` : 'already on the newest release and no replacement is known';
  }
  try {
    validateOp(op);
  } catch (err) {
    return `invalid version: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}
