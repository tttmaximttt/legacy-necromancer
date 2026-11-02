import type {
  ExhumeReport,
  GraveyardReport,
  InterviewReport,
  PlanCheck,
  PlanReport,
  PlanStep,
  ResurrectReport,
  Tombstone,
  WitnessReport,
} from '@necromancer/core';
import { shellArg } from '@necromancer/core';

/** The saved reports a plan is built from. Only graveyard is required. */
export interface PlanInputs {
  exhume: ExhumeReport | null;
  graveyard: GraveyardReport | null;
  interview: InterviewReport | null;
  resurrect: ResurrectReport | null;
  witness: WitnessReport | null;
}

export interface PlanOptions {
  /** Source to name in check commands; defaults to the graveyard report's. */
  source?: string;
  now?: Date;
}

/** The Node major the plan ends on. */
export const TARGET_NODE = '24';
const TARGET_WHY = `Node ${TARGET_NODE} is an LTS line with security fixes into 2028, so the app lands on a runtime that stays supported.`;

/** Steps run in bucket order; see buildPlan. */
type Bucket = 'code-fix' | 'remove' | 'same-major' | 'replace' | 'major' | 'dev' | 'node';
const BUCKETS: Bucket[] = ['code-fix', 'remove', 'same-major', 'replace', 'major', 'dev', 'node'];

interface Draft {
  step: Omit<PlanStep, 'n' | 'after' | 'check' | 'goals'>;
  bucket: Bucket;
  /** Sort key inside the bucket: importers for replacements, majors for upgrades. */
  weight: number;
  security: boolean;
}

/**
 * Goal keywords and the steps they map to. A goal also maps to any step whose packages it names.
 * Matching is case-insensitive on the goal text.
 */
const GOAL_RULES: Array<{ pattern: RegExp; matches: (d: Draft) => boolean }> = [
  { pattern: /secur|vulnerab|cve|advisor|audit/i, matches: (d) => d.security },
  { pattern: /\bnode\b|runtime|\blts\b|platform/i, matches: (d) => d.step.kind === 'upgrade-node' || d.step.kind === 'code-fix' },
  {
    pattern: /depend|deprecat|unmaintain|abandon|dead|outdated/i,
    matches: (d) => d.step.kind === 'replace-dependency' || d.step.kind === 'remove-dependency' || d.step.kind === 'upgrade-dependency',
  },
  { pattern: /\blinux\b|case[- ]sensitiv|portab/i, matches: (d) => d.step.kind === 'code-fix' },
];

const BUILT_IN = /built[ -]?in|native|no longer needed/i;
const COMPATIBLE = /compatible|drop-in/i;

/** What exhume knows about one package: how many files import it, which ones, and which npm scripts name it. */
interface Usage {
  /** null when unknown: no exhume report, or a package exhume never saw declared. */
  importedBy: number | null;
  importers: string[];
  /** The first npm script that names the package, if any. */
  script: string | null;
}

/** Ordering by UTF-16 code units, so plans come out the same under any locale. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Builds the modernization plan from the saved reports. Deterministic: no network, no model, no files.
 *
 * Order, low risk first so the app stays runnable after every step: code fixes, removal of unused dead packages,
 * upgrades within the same major, replacements of dead packages (fewest importers first), major upgrades
 * (fewest majors first), dev-dependency majors, and the Node upgrade last.
 */
export function buildPlan(reports: PlanInputs, options: PlanOptions = {}): PlanReport {
  const { exhume, graveyard, interview, resurrect, witness } = reports;
  if (!graveyard) throw new Error('A plan needs a saved graveyard report. Run `necromancer graveyard <source>` first.');
  const source = options.source ?? graveyard.repo.source;
  const warnings: string[] = [];
  const leftAlone: PlanReport['leftAlone'] = [];

  const usage = usageOf(exhume);
  const evidence = resurrectEvidence(resurrect);
  const drafts: Draft[] = [];

  if (exhume?.caseMismatches.length) {
    const files = [...new Set(exhume.caseMismatches.map((m) => m.from))].sort(compare);
    drafts.push({
      step: {
        id: 'code-fix:import-case',
        kind: 'code-fix',
        title: `Fix the casing of ${exhume.caseMismatches.length} import${exhume.caseMismatches.length === 1 ? '' : 's'}`,
        change: exhume.caseMismatches.map((m) => ({ name: `${m.from}:${m.line}`, from: m.specifier, to: m.target })),
        why: ['These imports only resolve on a case-insensitive filesystem; they break on Linux and in Docker.'],
        touches: files,
        risk: 'low',
      },
      bucket: 'code-fix',
      weight: 0,
      security: false,
    });
  }

  for (const t of [...graveyard.tombstones].sort((a, b) => compare(a.name, b.name))) {
    const draft = draftFor(t, usage(t.name), evidence.get(t.name) ?? [], leftAlone);
    if (draft) drafts.push(draft);
  }
  for (const dep of graveyard.nonRegistry) {
    leftAlone.push({ name: dep.name, reason: `Not on the npm registry (${dep.spec}); check its source by hand.` });
  }

  const eraNode = nodeMajor(resurrect?.recipe.nodeImage) ?? nodeMajor(graveyard.era.node?.release);
  const nodeWhy = [TARGET_WHY];
  if (eraNode !== null) {
    const jump = Number(TARGET_NODE) - Number(eraNode);
    const majors = `this is a jump of ${jump} major${jump === 1 ? '' : 's'}`;
    nodeWhy.push(
      resurrect?.outcome === 'resurrected'
        ? `Resurrect booted the app on Node ${eraNode} (${resurrect.recipe.nodeImage}); ${majors}.`
        : resurrect
          ? `Resurrect tried Node ${eraNode} (${resurrect.recipe.nodeImage}) but has not booted the app yet; ${majors}.`
          : `The project targets Node ${eraNode}; ${majors}.`,
    );
  }
  nodeWhy.push('Last, so every package is already on a version that supports the new runtime.');
  if (eraNode === null || Number(eraNode) < Number(TARGET_NODE)) {
    const jump = eraNode === null ? null : Number(TARGET_NODE) - Number(eraNode);
    drafts.push({
      step: {
        id: `upgrade-node:${TARGET_NODE}`,
        kind: 'upgrade-node',
        title: `Move to Node ${TARGET_NODE}`,
        change: [{ name: 'node', from: eraNode, to: TARGET_NODE }],
        why: nodeWhy,
        touches: [],
        risk: jump !== null && jump < 4 ? 'medium' : 'high',
      },
      bucket: 'node',
      weight: 0,
      security: false,
    });
  }

  drafts.sort((a, b) => BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket) || a.weight - b.weight || compare(a.step.id, b.step.id));

  const baseline = checkFor(source, exhume, witness);
  const goals = interview?.goals.map((g) => g.text) ?? [];
  const codeFixes = drafts.filter((d) => d.bucket === 'code-fix').map((d) => d.step.id);
  const steps: PlanStep[] = drafts.map((d, i) => ({
    n: i + 1,
    ...d.step,
    goals: goals.filter((g) => goalMatches(g, d)),
    after:
      d.bucket === 'node'
        ? drafts.slice(0, i).map((p) => p.step.id)
        : d.bucket === 'code-fix'
          ? []
          : codeFixes,
    check: baseline,
  }));

  if (!witness) {
    warnings.push(`No witness report: run \`necromancer witness ${shellArg(source)}\` first so each step can be checked against recorded behaviour.`);
  }
  if (!exhume) warnings.push('No exhume report: the plan cannot tell which packages are unused or how widely each is imported.');
  if (!interview) warnings.push('No interview report: steps are not tied to the owner\'s goals.');
  if (!resurrect) warnings.push('No resurrect report: the app has not been booted yet, so the starting Node version is a guess.');
  else if (resurrect.outcome !== 'resurrected') {
    warnings.push(`Resurrect did not boot the app (${resurrect.outcome}); get it running before following the plan.`);
  }
  for (const [name, status] of Object.entries(graveyard.sources)) {
    if (status === 'failed') warnings.push(`The ${name} lookup failed during graveyard, so some causes may be missing.`);
  }

  return {
    repo: { source, commit: exhume?.repo.commit ?? graveyard.repo.commit },
    generatedAt: (options.now ?? new Date()).toISOString(),
    basedOn: { exhume: !!exhume, graveyard: true, interview: !!interview, resurrect: !!resurrect, witness: !!witness },
    intent: interview?.intent ?? null,
    goals,
    target: { node: TARGET_NODE, why: TARGET_WHY },
    baseline,
    steps,
    leftAlone,
    warnings,
  };
}

function draftFor(t: Tombstone, use: Usage, fixes: string[], leftAlone: PlanReport['leftAlone']): Draft | null {
  const current = t.resolved ?? t.declared;
  const why = [...t.causes.map((c) => c.detail), ...t.advisories.map(advisoryLine), ...fixes];
  const security = t.advisories.length > 0;
  const { importedBy } = use;
  const touches = use.importers;

  if (t.status === 'unknown') {
    leftAlone.push({ name: t.name, reason: 'Its status is unknown (the registry lookup gave nothing); check it by hand.' });
    return null;
  }
  if (t.status === 'alive' && !security) return null;

  if ((t.status === 'dead' || t.status === 'dying') && t.replacement) {
    const r = t.replacement;
    const builtIn = BUILT_IN.test(r.reason);
    const via = builtIn ? ` (${r.reason})` : '';
    return {
      step: {
        id: `replace:${t.name}`,
        kind: 'replace-dependency',
        title: `Replace ${t.name} with ${r.name}${via}`,
        change: [
          { name: t.name, from: current, to: null },
          ...(builtIn ? [] : [{ name: r.name, from: null, to: 'latest' }]),
        ],
        why: [...why, `Suggested replacement: ${r.name}, ${r.reason}.`, ...importersLine(importedBy)],
        touches,
        risk: COMPATIBLE.test(r.reason) ? 'medium' : 'high',
      },
      bucket: 'replace',
      weight: importedBy ?? Number.MAX_SAFE_INTEGER,
      security,
    };
  }

  if ((t.status === 'dead' || t.status === 'dying') && importedBy === 0 && !t.dev && !use.script) {
    return {
      step: {
        id: `remove:${t.name}`,
        kind: 'remove-dependency',
        title: `Remove ${t.name}`,
        change: [{ name: t.name, from: current, to: null }],
        why: [...why, 'Nothing imports it, but it may still be used from config files or the command line; search for its name before removing it.'],
        touches,
        risk: 'medium',
      },
      bucket: 'remove',
      weight: 0,
      security,
    };
  }

  if (!t.latest || t.latest === t.resolved) {
    const reason =
      t.status === 'dead' || t.status === 'dying'
        ? 'Unmaintained, with no known replacement and no newer release; revisit when a successor is chosen.'
        : security
          ? 'It has advisories but no newer release to move to; consider replacing it.'
          : 'Already on the newest release.';
    leftAlone.push({ name: t.name, reason: use.script && importedBy === 0 ? `Used by the ${use.script} script. ${reason}` : reason });
    return null;
  }

  const majors = t.majorsBehind;
  const sameMajor = majors === 0;
  if (t.status === 'dead' || t.status === 'dying') why.push('No replacement is known, so it is upgraded rather than swapped.');
  if (security) why.push(`The first release without the advisor${t.advisories.length === 1 ? 'y' : 'ies'} is not known, so the target is the latest.`);
  return {
    step: {
      id: `upgrade:${t.name}`,
      kind: 'upgrade-dependency',
      title: `Upgrade ${t.name}${t.dev ? ' (dev)' : ''} from ${current} to ${t.latest}`,
      change: [{ name: t.name, from: current, to: t.latest }],
      why: [...why, ...(majors ? [`${majors} major${majors === 1 ? '' : 's'} behind.`] : []), ...importersLine(importedBy)],
      touches,
      risk: majors === null ? 'medium' : majors >= 2 ? 'high' : majors === 1 ? 'medium' : 'low',
    },
    bucket: sameMajor ? 'same-major' : t.dev ? 'dev' : 'major',
    weight: majors ?? Number.MAX_SAFE_INTEGER,
    security,
  };
}

function advisoryLine(a: Tombstone['advisories'][number]): string {
  return `Advisory ${a.id} (${a.severity}): ${a.title}${a.vulnerableVersions ? `, affects ${a.vulnerableVersions}` : ''}.`;
}

function importersLine(importedBy: number | null): string[] {
  return importedBy ? [`Imported by ${importedBy} file${importedBy === 1 ? '' : 's'}.`] : [];
}

/** Lines about packages Resurrect had to pin or remove to boot the app, by package name. */
function resurrectEvidence(resurrect: ResurrectReport | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!resurrect) return out;
  const add = (name: string, line: string) => {
    const lines = out.get(name) ?? [];
    if (!lines.includes(line)) out.set(name, [...lines, line]);
  };
  for (const [name, patch] of Object.entries(resurrect.recipe.dependencyPatches)) {
    add(name, patch.version === null ? 'Resurrect had to remove it to boot the app.' : `Resurrect had to pin it to ${patch.version} to boot the app.`);
  }
  for (const attempt of resurrect.attempts) {
    for (const op of attempt.fix?.ops ?? []) {
      if (op.op === 'setDependency' || op.op === 'removeDependency') add(op.name, `Resurrect fix: ${attempt.fix!.description}`);
    }
  }
  return out;
}

/** The Node major in an image tag, a version or a release name ("node:8-stretch", "registry/v2/node:8", "v8.9.0", "8"), or null. */
function nodeMajor(value: string | null | undefined): string | null {
  const m = value?.match(/(?:^|\bnode:)v?(\d+)/);
  return m?.[1] ?? null;
}

/** Looks up what exhume knows about a package. Without exhume, or for a package it never saw declared, nothing is known. */
function usageOf(exhume: ExhumeReport | null): (name: string) => Usage {
  if (!exhume) return () => ({ importedBy: null, importers: [], script: null });
  const imported = new Map(exhume.externalPackages.map((p) => [p.name, p]));
  const declared = new Set(exhume.manifests.flatMap((m) => [...Object.keys(m.dependencies), ...Object.keys(m.devDependencies)]));
  const scripts = exhume.manifests.flatMap((m) => Object.entries(m.scripts ?? {}));
  return (name) => {
    const p = imported.get(name);
    const names = new RegExp(`(^|[^\\w@/.-])${escape(name)}($|[^\\w/.-])`);
    return {
      importedBy: p ? p.importedBy : declared.has(name) ? 0 : null,
      importers: [...(p?.importers ?? [])].sort(compare),
      script: scripts.find(([, command]) => names.test(command))?.[0] ?? null,
    };
  };
}

function checkFor(source: string, exhume: ExhumeReport | null, witness: WitnessReport | null): PlanCheck {
  if (witness && witness.snapshots.length > 0) {
    return {
      kind: 'witness',
      command: `necromancer witness ${shellArg(source)} --check`,
      passes: 'Every recorded route answers the same as the golden snapshots.',
    };
  }
  if (witness?.tests) {
    return { kind: 'tests', command: witness.tests.command, passes: 'The project\'s own tests pass, as they did when witnessed.' };
  }
  if (exhume && exhume.stats.testFiles > 0) {
    return { kind: 'tests', command: 'npm test', passes: 'The project\'s own tests pass.' };
  }
  return { kind: 'resurrect', command: `necromancer resurrect ${shellArg(source)}`, passes: 'The app still installs, builds and boots.' };
}

function goalMatches(goal: string, draft: Draft): boolean {
  const text = goal.toLowerCase();
  const names = draft.step.change.map((c) => c.name.toLowerCase()).filter((n) => n !== 'node');
  if (names.some((n) => new RegExp(`(^|[^a-z0-9@/._-])${escape(n)}($|[^a-z0-9_-])`).test(text))) return true;
  return GOAL_RULES.some((r) => r.pattern.test(goal) && r.matches(draft));
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
