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
}
