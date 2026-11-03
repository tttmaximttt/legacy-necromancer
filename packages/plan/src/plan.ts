import type {
  ExhumeReport,
  PlanCheck,
  PlanReport,
  PlanStep,
  ResurrectReport,
  StoredReports,
  Tombstone,
  WitnessReport,
} from '@necromancer/core';
import { nodeLine, shellArg } from '@necromancer/core';

/** The saved reports a plan is built from. Only graveyard is required. */
export type PlanInputs = Omit<StoredReports, 'plan'>;

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

/**
 * What exhume knows about one package: how many files import it, which ones, which files name it in a string
 * (`app.set('view engine', 'jade')`), and which npm scripts name it.
 */
interface Usage {
  /** null when unknown: no exhume report, or a package exhume never saw declared. */
  importedBy: number | null;
  importers: string[];
  /** Files that name the package in a string literal outside an import; 0 and [] when none or unknown. */
  referenceCount: number;
  referencedBy: string[];
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
  const scriptCommand = unexplainedScriptCommand(exhume, graveyard.tombstones);
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
    const draft = draftFor(t, usage(t.name), evidence.get(t.name) ?? [], scriptCommand, leftAlone);
    if (draft) drafts.push(draft);
  }
  for (const dep of graveyard.nonRegistry) {
    leftAlone.push({ name: dep.name, reason: `Not on the npm registry (${dep.spec}); check its source by hand.` });
  }

  const eraNode = nodeLine(resurrect?.recipe.nodeImage) ?? nodeLine(graveyard.era.node?.release);
  // A 0.x release line (0.10, 0.12) predates io.js and the 4.x line, so counting majors from 0 would mislead.
  const preFour = eraNode !== null && /^0(\.|$)/.test(eraNode);
  const jump = eraNode === null || preFour ? null : Number(TARGET_NODE) - Number(eraNode);
  const nodeWhy = [TARGET_WHY];
  if (eraNode !== null) {
    const distance = preFour ? `this starts from Node ${eraNode}, before the 4.x line` : `this is a jump of ${jump} major${jump === 1 ? '' : 's'}`;
    nodeWhy.push(
      resurrect?.outcome === 'resurrected'
        ? `Resurrect booted the app on Node ${eraNode} (${resurrect.recipe.nodeImage}); ${distance}.`
        : resurrect
          ? `Resurrect tried Node ${eraNode} (${resurrect.recipe.nodeImage}) but has not booted the app yet; ${distance}.`
          : `The project targets Node ${eraNode}; ${distance}.`,
    );
  }
  nodeWhy.push('Last, so the packages above are already on their new versions when the runtime changes.');
  const behind = graveyard.tombstones.filter(majorBehindButAlive).map((t) => t.name).sort(compare);
  if (behind.length) {
    nodeWhy.push(
      `${behind.join(', ')} ${behind.length === 1 ? 'stays' : 'stay'} a major behind (see Left alone); check ${behind.length === 1 ? 'it supports' : 'they support'} Node ${TARGET_NODE} before this step.`,
    );
  }
  if (eraNode === null || preFour || jump! > 0) {
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

  const baseline = checkFor(source, exhume, resurrect, witness);
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
  if (witness?.tests && !witness.tests.ok) {
    const how = witness.tests.summary ? `"${witness.tests.summary}"` : `\`${witness.tests.command}\` failed`;
    warnings.push(`The project's tests already failed when witnessed (${how}), so they can't be used to check steps until they're fixed.`);
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

/** A maintained package with no advisories that is behind by a major: left alone rather than upgraded. */
function majorBehindButAlive(t: Tombstone): boolean {
  return t.status === 'alive' && t.advisories.length === 0 && (t.majorsBehind ?? 0) > 0;
}

function draftFor(t: Tombstone, use: Usage, fixes: string[], scriptCommand: string | null, leftAlone: PlanReport['leftAlone']): Draft | null {
  const current = t.resolved ?? t.declared;
  const why = [...t.causes.map((c) => c.detail), ...t.advisories.map(advisoryLine), ...fixes];
  const security = t.advisories.length > 0;
  const { importedBy } = use;
  const touches = [...new Set([...use.importers, ...use.referencedBy])].sort(compare);
  // Exact when neither list was capped; otherwise files on both lists beyond the cap may be counted twice.
  const touchCount =
    use.importers.length === (importedBy ?? 0) && use.referencedBy.length === use.referenceCount
      ? touches.length
      : (importedBy ?? 0) + use.referenceCount - (use.importers.length + use.referencedBy.length - touches.length);

  if (t.status === 'unknown') {
    leftAlone.push({ name: t.name, reason: 'Its status is unknown (the registry lookup gave nothing); check it by hand.' });
    return null;
  }
  if (majorBehindButAlive(t)) {
    const majors = t.majorsBehind!;
    leftAlone.push({ name: t.name, reason: `${majors} major${majors === 1 ? '' : 's'} behind; maintained, upgrade when convenient.` });
    return null;
  }
  if (t.status === 'alive' && !security) return null;

  if ((t.status === 'dead' || t.status === 'dying') && importedBy === 0 && !t.dev && !use.script) {
    if (use.referenceCount > 0) {
      leftAlone.push({ name: t.name, reason: `Nothing imports it, but it is loaded by name in ${fileList(use.referencedBy, use.referenceCount)}; check before removing it.` });
      return null;
    }
    if (scriptCommand) {
      leftAlone.push({ name: t.name, reason: `Nothing imports it, but a script runs \`${scriptCommand}\`, which may come from it; check before removing it.` });
      return null;
    }
    return {
      step: {
        id: `remove:${t.name}`,
        kind: 'remove-dependency',
        title: `Remove ${t.name}`,
        change: [{ name: t.name, from: current, to: null }],
        why: [
          ...why,
          'Nothing imports it, but it may still be used from config files or the command line; search for its name before removing it.',
          ...(t.replacement ? [`If something still needs it, ${t.replacement.name} replaces it (${t.replacement.reason}).`] : []),
        ],
        touches,
        touchCount,
        risk: 'medium',
      },
      bucket: 'remove',
      weight: 0,
      security,
    };
  }

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
        why: [...why, `Suggested replacement: ${r.name}, ${r.reason}.`, ...usageLines(use)],
        touches,
        touchCount,
        risk: COMPATIBLE.test(r.reason) ? 'medium' : 'high',
      },
      bucket: 'replace',
      weight: importedBy ?? Number.MAX_SAFE_INTEGER,
      security,
    };
  }

  if (!t.latest || t.latest === (t.resolved ?? declaredVersion(t.declared)) || t.latest === current) {
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
      why: [...why, ...(majors ? [`${majors} major${majors === 1 ? '' : 's'} behind.`] : []), ...usageLines(use)],
      touches,
      touchCount,
      risk: majors === null ? 'medium' : majors >= 2 ? 'high' : majors === 1 ? 'medium' : 'low',
    },
    bucket: sameMajor ? 'same-major' : t.dev ? 'dev' : 'major',
    weight: majors ?? Number.MAX_SAFE_INTEGER,
    security,
  };
}

/** The version a declared range starts from when it names one exact version ("^1.2.3", "~1.2.3", "=v1.2.3", "1.2.3"), else null. */
function declaredVersion(range: string): string | null {
  const m = range.trim().match(/^(?:[\^~]|=)?\s*v?(\d+\.\d+\.\d+(?:-[\w.]+)?)$/);
  return m?.[1] ?? null;
}

function advisoryLine(a: Tombstone['advisories'][number]): string {
  return `Advisory ${a.id} (${a.severity}): ${a.title}${a.vulnerableVersions ? `, affects ${a.vulnerableVersions}` : ''}.`;
}

const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

function usageLines(use: Usage): string[] {
  return [
    ...(use.importedBy ? [`Imported by ${files(use.importedBy)}.`] : []),
    ...(use.referenceCount ? [`Loaded by name (a string literal, not an import) in ${files(use.referenceCount)}.`] : []),
  ];
}

/** "a.js", "a.js and b.js", "a.js, b.js, c.js and 4 more". */
function fileList(listed: string[], total: number): string {
  const shown = listed.slice(0, 3);
  const rest = total - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown.join('');
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

/** Looks up what exhume knows about a package. Without exhume, or for a package it never saw declared, nothing is known. */
function usageOf(exhume: ExhumeReport | null): (name: string) => Usage {
  if (!exhume) return () => ({ importedBy: null, importers: [], referenceCount: 0, referencedBy: [], script: null });
  const imported = new Map(exhume.externalPackages.map((p) => [p.name, p]));
  const declared = new Set(exhume.manifests.flatMap((m) => [...Object.keys(m.dependencies), ...Object.keys(m.devDependencies)]));
  const scripts = exhume.manifests.flatMap((m) => Object.entries(m.scripts ?? {}));
  return (name) => {
    const p = imported.get(name);
    const names = new RegExp(`(^|[^\\w@/.-])${escape(name)}($|[^\\w/.-])`);
    return {
      importedBy: p ? p.importedBy : declared.has(name) ? 0 : null,
      importers: [...(p?.importers ?? [])].sort(compare),
      referenceCount: p?.referenceCount ?? p?.referencedBy?.length ?? 0,
      referencedBy: [...(p?.referencedBy ?? [])].sort(compare),
      script: scripts.find(([, command]) => names.test(command))?.[0] ?? null,
    };
  };
}

/** Commands a script may run that need no package: shell keywords and builtins, common utilities, and Node's own tools. */
const KNOWN_COMMANDS = new Set([
  ...['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'function', '!'],
  ...['[', '[[', ']]', 'test', 'true', 'false', ':', '.', 'source', 'export', 'set', 'unset', 'exit', 'return', 'cd'],
  ...['echo', 'printf', 'eval', 'exec', 'shift', 'trap', 'wait', 'read', 'sleep', 'env'],
  ...['sh', 'bash', 'rm', 'cp', 'mv', 'mkdir', 'cat', 'ls', 'touch', 'chmod', 'ln', 'find', 'grep', 'sed', 'tar', 'git', 'make'],
  ...['node', 'npm', 'yarn', 'pnpm', 'npx'],
]);

/**
 * The first command a manifest script runs that is neither known (see KNOWN_COMMANDS) nor the name of a dependency,
 * else null. No saved report records which binaries a package installs, so a command like `coffee` (from
 * coffee-script) cannot be tied to its package. While such a command exists, any unimported runtime dependency may be
 * the one providing it, so none is proposed for removal. See scriptCommands for how a script is split.
 */
function unexplainedScriptCommand(exhume: ExhumeReport | null, tombstones: Tombstone[]): string | null {
  if (!exhume) return null;
  const packages = new Set([
    ...tombstones.map((t) => t.name),
    ...exhume.manifests.flatMap((m) => [...Object.keys(m.dependencies), ...Object.keys(m.devDependencies)]),
  ]);
  for (const m of exhume.manifests) {
    for (const command of Object.values(m.scripts ?? {})) {
      for (const cmd of scriptCommands(command)) {
        if (!KNOWN_COMMANDS.has(cmd) && !packages.has(cmd)) return cmd;
      }
    }
  }
  return null;
}

/** Shell words that start a command list rather than name a command: `if cmd`, `then cmd`, `! cmd`. */
const LEADING_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', 'time']);

/**
 * The command names an npm script runs, roughly as a POSIX shell would split it: quoted text is dropped, the script is
 * cut at `;`, `&&`, `||`, `|`, `&`, newlines, parentheses and braces, and each simple command's name is its first word
 * after any `NAME=value` prefixes (a quoted value stays part of its word, as in the shell) and leading keywords (`if`, `then`, ...). `npx <cmd>` runs `<cmd>`,
 * `node_modules/.bin/<cmd>` is `<cmd>`, and other paths are the repo's own files, so they are left out, as are words
 * the shell expands (`$x`, backquotes).
 */
function scriptCommands(script: string): string[] {
  const unquoted = script
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'Q')
    // Redirections such as `2>&1` and `&>file` are not command separators.
    .replace(/\d*[<>]+&\d*-?|&>>?/g, ' ');
  const out: string[] = [];
  for (const part of unquoted.split(/&&|\|\||[;&|\n(){}]/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    while (words.length && (/^\w+=/.test(words[0]!) || (words.length > 1 && LEADING_KEYWORDS.has(words[0]!)))) words.shift();
    let cmd = words[0] === 'npx' ? words.slice(1).find((w) => !w.startsWith('-')) : words[0];
    if (cmd?.startsWith('node_modules/.bin/')) cmd = cmd.slice('node_modules/.bin/'.length);
    if (cmd && cmd !== 'Q' && !cmd.includes('/') && !/[$`\\]/.test(cmd)) out.push(cmd);
  }
  return out;
}

/** npm's placeholder for a package without tests, which always fails. */
const NO_TEST_SCRIPT = 'echo "Error: no test specified" && exit 1';

function checkFor(source: string, exhume: ExhumeReport | null, resurrect: ResurrectReport | null, witness: WitnessReport | null): PlanCheck {
  if (witness && witness.snapshots.length > 0) {
    return {
      kind: 'witness',
      command: `necromancer witness ${shellArg(source)} --check`,
      passes: 'Every recorded route answers the same as the golden snapshots.',
    };
  }
  // Tests that already failed when witnessed can never pass a step's check.
  if (witness?.tests?.ok) {
    return { kind: 'tests', command: witness.tests.command, passes: 'The project\'s own tests pass, as they did when witnessed.' };
  }
  // `<pm> test` runs the root manifest's script, so only that one counts.
  const test = exhume?.manifests.find((m) => m.manifest === 'package.json')?.scripts?.test?.trim();
  if (!witness?.tests && test && test !== NO_TEST_SCRIPT) {
    const pm = resurrect?.recipe.packageManager ?? exhume!.repo.packageManager;
    return { kind: 'tests', command: `${pm === 'yarn' || pm === 'pnpm' ? pm : 'npm'} test`, passes: 'The test script passes.' };
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
