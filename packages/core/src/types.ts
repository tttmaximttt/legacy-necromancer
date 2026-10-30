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
  externalPackages: Array<{ name: string; importedBy: number }>;
  /** Imports whose casing doesn't match the file on disk; they break on Linux. */
  caseMismatches: Array<{ from: string; specifier: string; line: number; target: string }>;
  manifests: DependencySummary[];
  installScripts: InstallScriptFinding[];
  /** The whole import graph, for the UI. Left out of MCP summaries. */
  graph: ImportGraphData;
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

export interface ResurrectReport {
  repo: { source: string; commit: string | null };
  generatedAt: string;
  outcome: 'resurrected' | 'blocked';
  /** Set when blocked: the "BLOCKED: <reason>" line, without the prefix. */
  blockedReason: string | null;
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
