import semver from 'semver';
import { compare, nodeLine, type GraveyardReport, type ResurrectReport, type SurgeonStep, type Tombstone } from '@necromancer/core';
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

const isUpgradeable = (t: Tombstone): t is Tombstone & { status: UpgradeStatus } => t.status in STATUS_RANK;

/**
 * The upgrade steps surgeon tries, in order: dead, dying and ailing dependencies, then the Node bump,
 * one op per step. Steps the plan already knows can't be done carry a `skip` reason.
 * Pure and deterministic: no network, no model, no files, no clock.
 */
export function planSteps(inputs: PlanStepsInputs, options: PlanStepsOptions = {}): SurgeonStep[] {
  const target = options.targetNode ?? TARGET_NODE;
  const recipe = inputs.resurrect.recipe;
  const steps: Array<Omit<SurgeonStep, 'n'>> = [];

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
      title: version === current || onNewest(t) ? `Keep ${t.name} at ${current}` : `Upgrade ${t.name} from ${current} to ${version}`,
      op,
      change: { name: t.name, from: current, to: version },
      status: t.status,
      dev: t.dev,
      why,
      skip: skipReason(t, op),
    });
  }

  // Last, so the dependencies are already on releases that support the new runtime.
  const from = nodeLine(recipe.nodeImage);
  const to = nodeLine(target);
  if (from === null || to === null || Number(from) < Number(to)) {
    // The plain major: the era's variant (e.g. "stretch") doesn't exist for new majors.
    const op = { op: 'setNodeImage' as const, tag: target };
    steps.push({
      id: `node:${target}`,
      kind: 'upgrade-node',
      title: `Move to Node ${target}`,
      op,
      change: { name: 'node', from, to: target },
      status: null,
      dev: false,
      why: [`The recipe boots on ${recipe.nodeImage}${from === null ? '' : ` (Node ${from})`}; Node ${target} is the target release.`],
      // An unparsable tag (lts, current, latest) may already be newer than the target: never risk a downgrade.
      skip: from === null ? `can't tell which Node ${recipe.nodeImage} is, so not moving it` : invalidOp(op),
    });
  }

  return steps.map((s, i) => ({ n: i + 1, ...s }));
}

/** True when there is nothing newer: latest is what's installed, or, with no resolved version, the declared range already takes it. */
function onNewest(t: Tombstone): boolean {
  if (t.latest === null) return false;
  if (t.latest === (t.resolved ?? t.declared)) return true;
  // Loose, as graveyard parses ranges and resolves versions.
  return t.resolved === null && semver.satisfies(t.latest, t.declared, { loose: true });
}

/** The first rule that rules a dependency step out before it runs, or null. A pin resurrect added is no reason: rollback restores it. */
function skipReason(t: Tombstone, op: SurgeonStep['op']): string | null {
  if (t.latest === null) return 'no release found on the registry';
  if (onNewest(t)) return t.replacement ? `needs a code change: replace with ${t.replacement.name}` : 'already on the newest release and no replacement is known';
  return invalidOp(op);
}

/** Why the recipe would reject the op, or null when it accepts it. */
function invalidOp(op: SurgeonStep['op']): string | null {
  try {
    validateOp(op);
  } catch (err) {
    return `invalid ${op.op === 'setNodeImage' ? 'Node tag' : 'version'}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}
