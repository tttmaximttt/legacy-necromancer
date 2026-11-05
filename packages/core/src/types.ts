/** Languages Excavate can parse. */
export type SourceLanguage = 'javascript' | 'typescript' | 'tsx';

/** How an import specifier was written in the source. */
export type ImportKind = 'import' | 'export-from' | 'require' | 'dynamic-import' | 'import-equals';

export interface RawImport {
  specifier: string;
  kind: ImportKind;
  /** 1-based line of the import in the source file. */
  line: number;
}

/** An HTTP route registration found in source, e.g. `router.get('/users/:id', …)`. */
export interface RawRoute {
  method: string;
  path: string;
  line: number;
}

/** `app.use('/api', target)`: routes registered in `specifier` are served under `prefix`. */
export interface RawMount {
  prefix: string;
  specifier: string;
  line: number;
}

/** A route with any mount prefixes applied. `method` is upper-case, or ALL. */
export interface HttpRoute {
  method: string;
  path: string;
  file: string;
  line: number;
}

export type ResolvedImport =
  /** `caseMismatch`: only resolves on a case-insensitive filesystem (macOS, Windows). */
  | { type: 'internal'; target: string; raw: RawImport; caseMismatch?: boolean }
  | { type: 'external'; packageName: string; raw: RawImport }
  | { type: 'builtin'; module: string; raw: RawImport }
  | { type: 'unresolved'; raw: RawImport };

export interface SourceFile {
  /** Repo-relative POSIX path. */
  path: string;
  language: SourceLanguage;
  loc: number;
  /** Number of ERROR/MISSING nodes tree-sitter produced; non-zero means the parse was partial. */
  parseErrors: number;
  /** Lives under test/, __tests__/ etc. or is named *.test.* / *.spec.*. */
  isTest: boolean;
  imports: ResolvedImport[];
}

export interface FileChurn {
  commits: number;
  authors: number;
  /** ISO date of the most recent commit touching the file. */
  lastTouched: string;
}

export interface RepoHistory {
  commits: number;
  authors: number;
  firstCommit: string | null;
  lastCommit: string | null;
  files: Record<string, FileChurn>;
}

export interface ModuleCluster {
  id: number;
  /** Most common directory among members, used as a human label. */
  label: string;
  size: number;
  files: string[];
  /** Edges between members / all edges touching members. 1.0 means fully self-contained. */
  cohesion: number;
}

export interface LoadBearingFile {
  path: string;
  /** Composite 0..1 score; see the `excavate` README for the weighting. */
  score: number;
  betweenness: number;
  /** Files that depend on this one directly or transitively: what breaks if it breaks. */
  blastRadius: number;
  fanIn: number;
  fanOut: number;
  churn: number;
  cluster: number;
}

export type Severity = 'info' | 'warn' | 'high';

export interface InstallScriptFinding {
  /** Repo-relative path of the package.json, or the lockfile for dependency findings. */
  manifest: string;
  /** Package that owns the script: the manifest's own name, or a dependency's. */
  packageName: string;
  hook: string;
  command: string;
  severity: Severity;
  reasons: string[];
}

export interface DependencySummary {
  manifest: string;
  name: string | null;
  engines: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  /** The manifest's npm scripts. Missing in reports from before scripts were recorded. */
  scripts?: Record<string, string>;
}

export interface ExhumeReport {
  repo: {
    source: string;
    commit: string | null;
    packageManager: 'npm' | 'yarn' | 'pnpm' | 'bower' | 'unknown';
  };
  stats: {
    files: number;
    loc: number;
    internalEdges: number;
    externalPackages: number;
    unresolvedImports: number;
    caseMismatchedImports: number;
    testFiles: number;
    filesWithParseErrors: number;
    durationMs: number;
  };
  history: Omit<RepoHistory, 'files'>;
  clusters: ModuleCluster[];
  loadBearing: LoadBearingFile[];
  /** Files with no internal imports in either direction: dead code, scripts, or entrypoints. */
  orphans: string[];
  /**
   * `importers`: the files that import the package, sorted, at most 20. Missing in older reports.
   * `referencedBy`/`referenceCount`: the files whose code names a declared dependency in a string literal outside an
   * import (`app.set('view engine', 'jade')`), sorted, at most 20, and their full count. Set only when there are some.
   * A declared dependency that is only named, never imported, is listed with `importedBy` 0.
   */
  externalPackages: Array<{ name: string; importedBy: number; importers?: string[]; referencedBy?: string[]; referenceCount?: number }>;
  /** Imports whose casing doesn't match the file on disk; they break on Linux. */
  caseMismatches: Array<{ from: string; specifier: string; line: number; target: string }>;
  manifests: DependencySummary[];
  installScripts: InstallScriptFinding[];
  /** The whole import graph, for the UI. Left out of MCP summaries. */
  graph: ImportGraphData;
  /** HTTP routes registered with Express-style or Hapi-style calls. Missing in reports from before phase 6. */
  routes?: HttpRoute[];
}

export interface GraphNode {
  id: string;
  /** -1 for files left out of clustering (tests, orphans). */
  cluster: number;
  loc: number;
  isTest: boolean;
  fanIn: number;
  fanOut: number;
  /** Load-bearing score; null for files that weren't ranked (tests by default). */
  score: number | null;
  blastRadius: number | null;
  churn: number;
}

export interface ImportGraphData {
  nodes: GraphNode[];
  /** [importer, imported] */
  edges: Array<[string, string]>;
}

// ── Phase 2: Date & Graveyard ────────────────────────────────────────────

export interface EraEstimate {
  /** First commit, if there is history. */
  born: string | null;
  /** Last commit: when the project stopped moving. */
  died: string | null;
  /**
   * Earliest date the manifest as written could exist: the newest publish
   * date among the minimum versions its ranges allow.
   */
  dependencyFloor: { date: string; package: string; version: string } | null;
  /** The Node release the `engines.node` range targets. */
  node: { range: string; release: string; released: string } | null;
  /** Best guess at the year–month the code is from. */
  estimate: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  summary: string;
}

/** dead: deprecated, archived or gone. dying: unmaintained. ailing: works but vulnerable or far behind. */
export type TombstoneStatus = 'dead' | 'dying' | 'ailing' | 'alive' | 'unknown';

export type CauseKind = 'deprecated' | 'archived' | 'missing' | 'abandoned' | 'vulnerable' | 'outdated';

export interface Cause {
  kind: CauseKind;
  detail: string;
}

export interface Advisory {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'moderate' | 'low' | 'unknown';
  url: string | null;
  /** Affected range when the source provides one. */
  vulnerableVersions: string | null;
}

export interface Replacement {
  name: string;
  reason: string;
  /** Where the suggestion came from: our curated table, or the deprecation message itself. */
  source: 'known' | 'deprecation-message';
}

export interface Tombstone {
  name: string;
  /** Range from package.json. */
  declared: string;
  dev: boolean;
  /** Version the project actually used, best effort. */
  resolved: string | null;
  /** lockfile: pinned. era: newest matching version published before the last commit. latest: newest matching version today. */
  resolvedFrom: 'lockfile' | 'era' | 'latest' | null;
  latest: string | null;
  /** Majors between resolved and latest. */
  majorsBehind: number | null;
  lastPublished: string | null;
  repository: string | null;
  status: TombstoneStatus;
  causes: Cause[];
  advisories: Advisory[];
  replacement: Replacement | null;
  /** One line, for the UI. */
  epitaph: string;
}

export type SourceStatus = 'ok' | 'partial' | 'failed' | 'skipped';

export interface GraveyardReport {
  repo: { source: string; commit: string | null };
  era: EraEstimate;
  summary: Record<TombstoneStatus, number> & { total: number; vulnerable: number };
  tombstones: Tombstone[];
  /** Which lookups worked. A `failed` source means its causes are missing, not absent. */
  sources: { registry: SourceStatus; advisories: SourceStatus; advisoryProvider: string; github: SourceStatus };
  /** Dependencies that aren't on the registry (git, file:, tarball URLs). */
  nonRegistry: Array<{ name: string; spec: string }>;
  warnings: string[];
}

/** A span of a repo file the model points at to back a claim. Line numbers are 1-based and inclusive. */
export interface Citation {
  file: string;
  startLine: number;
  endLine: number;
  /** A short excerpt the model says is on those lines. */
  quote: string;
  /** Whether the quote really is on those lines of that file at the analysed commit. */
  verified: boolean;
}

export interface IntentClaim {
  claim: string;
  evidence: Citation[];
}

/** What the project seems to be for, as proposed by the model (or the agent hosting the MCP server). */
export interface IntentProposal {
  /** One or two sentences: what it is and who it is for. */
  summary: string;
  /** What it does, each backed by citations. */
  capabilities: IntentClaim[];
  /** Constraints a revival must respect: public API, supported runtimes, file formats, protocols. */
  constraints: IntentClaim[];
  suggestedGoals: string[];
  /** What the evidence couldn't settle; worth asking the user. */
  openQuestions: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface InterviewGoal {
  text: string;
  origin: 'suggested' | 'user';
}

/**
 * Phase 4: the repo's intent, proposed from evidence and then confirmed or corrected by the user, plus the goals
 * later stages work towards. `intent` is the version later stages should trust.
 */
export interface InterviewReport {
  repo: { source: string; commit: string | null };
  generatedAt: string;
  proposedBy: { kind: 'claude-api'; model: string; fellBack: boolean } | { kind: 'host'; name: string };
  /** Files shown to the model, and how much of each. */
  evidence: Array<{ path: string; lines: number; truncated: boolean }>;
  proposal: IntentProposal;
  status: 'proposed' | 'confirmed' | 'corrected';
  /** The user's correction when status is "corrected", otherwise the proposal's summary. */
  intent: string;
  corrections: string | null;
  goals: InterviewGoal[];
  answeredAt: string | null;
  warnings: string[];
}

// ── Phase 5: Resurrect ───────────────────────────────────────────────────

export type ServiceKind = 'mongo' | 'redis' | 'postgres' | 'mysql' | 'rabbitmq' | 'elasticsearch' | 'memcached';

export interface DetectedService {
  kind: ServiceKind;
  image: string;
  /** Why we think the app needs it: a package name or a connection string. */
  evidence: string[];
  /** Variables pointing the app at it; services share the app's localhost. */
  env: Record<string, string>;
}

/** Hard limits on every container Resurrect starts. */
export interface SandboxLimits {
  cpus: number;
  memoryMb: number;
  pids: number;
  /** Per build, build-script or boot step. */
  stepTimeoutSec: number;
}

/** How the sandbox itself was set up, beyond the per-container limits; a resume rebuilds it the same way. */
export interface SandboxSettings {
  /** The host's HTTP(S)_PROXY was passed to the install step. */
  buildProxy: boolean;
  /** How long boot waited for a health signal. */
  healthTimeoutSec: number;
}

/** One change to the build recipe. Fixes, known or proposed by the model, are lists of these. */
export type RecipeOp =
  | { op: 'setNodeImage'; tag: string }
  | { op: 'aptInstall'; packages: string[] }
  | { op: 'useDebianArchive' }
  | { op: 'setEnv'; name: string; value: string }
  | { op: 'setDependency'; name: string; version: string; dev?: boolean }
  | { op: 'removeDependency'; name: string }
  | { op: 'addInstallFlags'; flags: string[] }
  | { op: 'dropLockfile' }
  | { op: 'globalInstall'; spec: string }
  | { op: 'runBeforeInstall'; command: string }
  | { op: 'setBuildCommand'; command: string | null }
  | { op: 'setStartCommand'; command: string | null }
  | { op: 'setPort'; port: number | null };

/** Everything the generated Dockerfile is rendered from. The repo itself is never edited. */
export interface BuildRecipe {
  nodeImage: string;
  packageManager: 'npm' | 'yarn' | 'pnpm';
  debianArchive: boolean;
  aptPackages: string[];
  env: Record<string, string>;
  globalInstalls: string[];
  beforeInstall: string[];
  /** Run `bower install` after npm, for front ends from the bower era. */
  bower: boolean;
  installFlags: string[];
  dropLockfile: boolean;
  /** Edits to package.json in the build context. null removes the dependency. */
  dependencyPatches: Record<string, { version: string | null; dev: boolean }>;
  buildCommand: string | null;
  startCommand: string | null;
  port: number | null;
}

export type ResurrectPhase = 'install' | 'build' | 'boot';

export interface AppliedFix {
  source: 'known' | 'cache' | 'llm';
  id: string;
  description: string;
  ops: RecipeOp[];
}

export interface ResurrectAttempt {
  n: number;
  /** Where it got to: the phase that failed, or "boot" on success. */
  phase: ResurrectPhase;
  ok: boolean;
  durationMs: number;
  /** Stable hash of the error, for caching fixes and spotting loops. */
  signature: string | null;
  /** The last lines of the failing step's log. */
  errorExcerpt: string | null;
  /** The fix applied after this attempt failed. */
  fix: AppliedFix | null;
}

/** Why a fix waits for the owner's OK. Empty means the fix is safe to apply without asking. */
export interface FixRisk {
  op: RecipeOp['op'];
  reason: string;
}

/** A fix the run stopped on because it needs the owner's approval. */
export interface PendingApproval {
  kind: 'approval';
  fix: AppliedFix;
  risks: FixRisk[];
}

/** A question the run stopped on because only the owner can answer it. */
export interface PendingQuestion {
  kind: 'question';
  question: string;
  /** Why it is asking: what was tried and what the model could not settle. */
  context: string;
  /** Suggested answers, possibly empty; any free-text answer is accepted. */
  choices: string[];
}

export type PendingDecision = PendingApproval | PendingQuestion;

/** A decision on a risky fix or a question during a run, kept so the history shows who chose what. */
export interface OwnerDecision {
  /** The attempt whose failure the decision was about. */
  attempt: number;
  kind: 'approval' | 'question';
  /**
   * "owner" when the owner answered; "auto" when a risky fix was applied without asking: a built-in known fix, a
   * blanket approval such as `--yes`, or a run with nobody set up to approve. Reports from before this field are read as "owner".
   */
  by: 'owner' | 'auto';
  /** For approvals: the fix id. For questions: the question. */
  subject: string;
  /** "approved", "rejected", or the owner's answer. */
  answer: string;
  /** For approvals: what the fix does. */
  description?: string;
  /** For approvals: why the fix needed an OK (`fixRisks`). Missing in reports from before this field. */
  risks?: FixRisk[];
  at: string;
}

/** Everything `resurrect --resume` needs to carry on where a paused run stopped. */
export interface ResurrectRunState {
  /** The attempt number the resumed run starts with. */
  nextAttempt: number;
  /** The failure the pending decision is about. */
  failure: { attempt: number; phase: ResurrectPhase; signature: string; log: string };
  /** How often each error signature has been seen, for loop detection. */
  seen: Record<string, number>;
  tokens: number;
  calls: number;
  /**
   * Every fix the owner declined in this run, from any source, by `opsKey` of its ops; none is offered again. Reports
   * from before this rule may also hold known-fix ids, which are ignored.
   */
  declinedFixes: string[];
  /** The fixes declined for the pending failure, as shown in the blocked message. */
  declined: string[];
  /** The owner's latest answer about this failure. */
  answer: string | null;
  /** Questions the owner answered about this failure so far. */
  questions: number;
  /** Fixes the owner declined for this failure so far. */
  declines: number;
  /**
   * What the model is told about the project, from the interview the run started with: its intent and the owner's goals,
   * or null for none. A resume tells the model this, not what the resuming call's interview says.
   */
  interview: { intent: string; goals: string[] } | null;
  /** Everything that defined the run; a resume restores all of it, and only overrides the caller gives explicitly change it. */
  settings: ResurrectRunSettings;
}

/** The settings a paused run was started with. The sandbox limits are the report's own `limits`. */
export interface ResurrectRunSettings {
  maxIterations: number;
  tokenBudget: number;
  /** The model asked for fixes, or null when the run used known and cached fixes only (no key, no model, or a budget of 0). */
  model: string | null;
  /** The CA certificate the install step trusted, as an absolute path, or null for none. */
  caFile: string | null;
  /** How the sandbox was set up, or null when the sandbox did not say. */
  sandbox: SandboxSettings | null;
  /** Whether the built images were kept after the run. */
  keepImages: boolean;
  /** Where remote repos were cloned, or null for the default temp directory. */
  workdir: string | null;
}

export interface ResurrectReport {
  repo: { source: string; commit: string | null };
  generatedAt: string;
  /** needs-you: paused on `pending`; continue with `resurrect --resume`. */
  outcome: 'resurrected' | 'blocked' | 'needs-you';
  /** Set when blocked: the "BLOCKED: <reason>" line, without the prefix. */
  blockedReason: string | null;
  /** Set when the outcome is needs-you. Missing in reports from before approvals existed. */
  pending?: PendingDecision | null;
  /** Set when the outcome is needs-you: the run state to resume from. */
  resume?: ResurrectRunState | null;
  /** Approvals and answers the owner gave during this run, oldest first. */
  decisions?: OwnerDecision[];
  /** How it was judged alive: a port answering, a log line, or (for libraries) a clean install and build. */
  health: { kind: 'port' | 'log' | 'library'; detail: string } | null;
  era: { date: string | null; node: string; why: string };
  services: DetectedService[];
  recipe: BuildRecipe;
  dockerfile: string;
  compose: string;
  limits: SandboxLimits;
  attempts: ResurrectAttempt[];
  llm: { model: string | null; calls: number; tokens: number; budget: number };
  warnings: string[];
}

// ── Phase 6: Witness ─────────────────────────────────────────────────────

/** One request to send to the revived app. `route` is the pattern it exercises, e.g. "GET /users/:id". */
export interface WitnessCase {
  route: string;
  name: string;
  method: string;
  /** Concrete path with parameters filled in, and any query string. */
  path: string;
  headers: Record<string, string>;
  /** Raw request body, usually JSON. */
  body: string | null;
}

export interface WitnessResponse {
  status: number | null;
  /** Only headers whose value is behaviour, normalized: content-type, location, cache-control, set-cookie names… */
  headers: Record<string, string>;
  /** JSON bodies are parsed and normalized; anything else is normalized text. */
  body: unknown;
  /** Set when the request never got a response: connection refused, timeout. */
  error: string | null;
}

export interface WitnessSnapshot {
  case: WitnessCase;
  response: WitnessResponse;
  /** JSON paths that changed between two identical requests and were blanked as `<volatile>`. */
  volatile: string[];
}

export interface WitnessTestRun {
  command: string;
  ok: boolean;
  /** e.g. "42 passing, 1 failing" when the runner's summary line is recognised. */
  summary: string | null;
  durationMs: number;
  logTail: string;
}

/**
 * Phase 6: golden snapshots of how the revived app answers every route found by Exhume, plus the result of
 * its own tests. Later upgrades must reproduce these.
 */
export interface WitnessReport {
  repo: { source: string; commit: string | null };
  generatedAt: string;
  /** The image and start command the snapshots were taken against. */
  target: { nodeImage: string; startCommand: string | null; services: string[] };
  routes: { found: number; exercised: number; skipped: Array<{ route: string; reason: string }> };
  /** `replay` when a check re-sent a golden run's requests. */
  inputs: { source: 'claude-api' | 'default' | 'replay'; model: string | null; tokens: number };
  snapshots: WitnessSnapshot[];
  tests: WitnessTestRun | null;
  warnings: string[];
}

// ── Plan ─────────────────────────────────────────────────────────────────

export type PlanStepKind =
  /** Swap a dead or dying package for its successor. */
  | 'replace-dependency'
  /** Move a package to a newer version, usually to clear advisories or catch up majors. */
  | 'upgrade-dependency'
  /** Drop a package nothing imports, or one the platform now provides. */
  | 'remove-dependency'
  /** Move the app to a newer Node release. */
  | 'upgrade-node'
  /** Fix something in the code that breaks on modern platforms, e.g. case-mismatched imports. */
  | 'code-fix';

export interface PlanCheck {
  /** witness: replay the golden snapshots. tests: the project's own test script. resurrect: it still installs and boots. */
  kind: 'witness' | 'tests' | 'resurrect';
  /** The command to run after the step, e.g. "necromancer witness <source> --check". */
  command: string;
  /** What passing means, in a sentence. */
  passes: string;
}

export interface PlanStep {
  /** 1-based order. Steps are meant to be done one at a time, in order. */
  n: number;
  /** Stable id, e.g. "replace:request" or "upgrade-node:18". */
  id: string;
  kind: PlanStepKind;
  /** One line, imperative, e.g. "Replace request with node-fetch". */
  title: string;
  /** The change itself: packages and versions, or what to edit. */
  change: Array<{ name: string; from: string | null; to: string | null }>;
  /** Why this step, with evidence: tombstone causes, advisories, Resurrect fixes. */
  why: string[];
  /** Repo files that import or name the packages involved, so the change can be scoped. At most 20 per package. */
  touches: string[];
  /** How many files import or name the packages involved; more than `touches` lists when it is capped. Missing in older plans. */
  touchCount?: number;
  risk: 'low' | 'medium' | 'high';
  /** The owner's goals (from the interview) this step serves. */
  goals: string[];
  /** Ids of steps that must be done first. */
  after: string[];
  /** Run after the step; the step is done only when it passes. */
  check: PlanCheck;
}

/**
 * The modernization plan: ordered dependency and runtime steps, each followed by a behaviour check, built from the
 * saved reports for one repo. Meant to be followed one step at a time, by a person or a later agent.
 */
export interface PlanReport {
  repo: { source: string; commit: string | null };
  generatedAt: string;
  /** Which saved reports the plan was built from. */
  basedOn: Record<'exhume' | 'graveyard' | 'interview' | 'resurrect' | 'witness', boolean>;
  intent: string | null;
  goals: string[];
  /** The Node release to end on, and why. */
  target: { node: string; why: string };
  /** The check used when a step does not need a more specific one. */
  baseline: PlanCheck;
  steps: PlanStep[];
  /** Packages the plan leaves alone, and why. */
  leftAlone: Array<{ name: string; reason: string }>;
  warnings: string[];
}

// ── Surgeon ──────────────────────────────────────────────────────────────

/** One way a witness check differs from the golden snapshots. */
export interface WitnessDifference {
  case: string;
  what: 'missing' | 'new' | 'status' | 'headers' | 'body' | 'error' | 'tests';
  detail: string;
}

/** What a witness check found: counts by kind and the first few differences. */
export interface WitnessDiffSummary {
  total: number;
  byKind: Partial<Record<WitnessDifference['what'], number>>;
  /** At most 10, in compareWitness order. */
  examples: WitnessDifference[];
}

export type SurgeonStepKind = 'upgrade-node' | 'upgrade-dependency';

export interface SurgeonStep {
  /** 1-based position in the plan. */
  n: number;
  /** Stable: "node:24", "dep:express". */
  id: string;
  kind: SurgeonStepKind;
  /** e.g. "Move to Node 24", "Upgrade express from 3.21.2 to 5.1.0". */
  title: string;
  /** Exactly one op: setNodeImage for the Node step, setDependency for a dependency. */
  op: Extract<RecipeOp, { op: 'setNodeImage' } | { op: 'setDependency' }>;
  change: { name: string; from: string | null; to: string };
  /** The tombstone's status; null for the Node step. */
  status: Exclude<TombstoneStatus, 'alive' | 'unknown'> | null;
  dev: boolean;
  why: string[];
  /** Set when the plan already knows the step can't be done; the loop records it as skipped without running it. */
  skip: string | null;
}

export type SurgeonStepStatus = 'kept' | 'rolled_back' | 'skipped';

export interface SurgeonStepResult {
  step: SurgeonStep;
  status: SurgeonStepStatus;
  /** Why it was rolled back or skipped; null when kept. */
  reason: string | null;
  /** Where it failed: the inner resurrect (install/build/boot), or the witness run or its comparison. null when kept or skipped. */
  failedAt: 'resurrect' | 'witness' | null;
  /** The one fix resurrect applied on top of the step's op, when it tried one. */
  fix: AppliedFix | null;
  /** The witness check, when one ran. null when the build failed first or the step was skipped. */
  diff: WitnessDiffSummary | null;
  /** Resurrect attempts this step used: 0 when skipped, 1 or 2 otherwise. */
  attempts: number;
  tokens: number;
  durationMs: number;
}

export interface SurgeonBudgets {
  /** Steps that may run (skipped-at-plan steps don't count). */
  maxSteps: number;
  /** Resurrect attempts in total, the baseline included. */
  maxAttempts: number;
  /** Input plus output tokens across every inner resurrect run. */
  tokenBudget: number;
  limits: SandboxLimits;
}

/** A bounded upgrade run: planned steps applied one at a time to the build recipe, each kept only if the witness snapshots still match. */
export interface SurgeonReport {
  repo: { source: string; commit: string | null };
  generatedAt: string;
  /**
   * complete: every step was kept, rolled back or skipped. blocked: stopped early, see blockedReason. needs-you: paused
   * on `pending` (a step's fix waits on the owner); continue with a resume.
   */
  status: 'complete' | 'blocked' | 'needs-you';
  blockedReason: string | null;
  /** Set when the status is needs-you: what the owner is asked, as in the paused inner run (`resume.inner.pending`). */
  pending?: PendingDecision | null;
  /** Set when the status is needs-you: the state to resume from. */
  resume?: SurgeonRunState | null;
  /** generatedAt of each report the run started from. The graveyard report has none, so it is null. */
  basedOn: { graveyard: string | null; resurrect: string; witness: string };
  target: { node: string };
  /** The unmodified recipe checked against the golden snapshots before any step. */
  baseline: { ok: boolean; reason: string | null; diff: WitnessDiffSummary | null };
  budgets: SurgeonBudgets;
  used: { steps: number; attempts: number; tokens: number; calls: number; model: string | null };
  summary: { kept: number; rolledBack: number; skipped: number; remaining: number };
  results: SurgeonStepResult[];
  /**
   * Planned steps the run never reached because it stopped or paused, in plan order; when paused, the first is the
   * paused step. Skip-marked steps are always in results.
   */
  remaining: SurgeonStep[];
  /** The starting recipe with every kept step (and its fix) applied, and its Dockerfile. */
  recipe: BuildRecipe;
  dockerfile: string;
  warnings: string[];
}

/** Everything a surgeon resume needs beyond the report itself. */
export interface SurgeonRunState {
  /** n of the paused step (remaining[0]). */
  step: number;
  /** Time already spent on that step. */
  elapsedMs: number;
  /** Totals before the paused step; the report's `used` includes its inner run so far. */
  used: SurgeonReport['used'];
  /** The paused inner resurrect run, outcome needs-you, with its own pending decision and ResurrectRunState. */
  inner: ResurrectReport;
}
