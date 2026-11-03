import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DependencySummary, InstallScriptFinding, Severity } from '@necromancer/core';

/**
 * Lifecycle hooks that run automatically on `npm install`. `prepublish` is
 * included because npm < 5, which old projects often expect, ran it on
 * every install.
 */
export const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'];

interface Rule {
  pattern: RegExp;
  severity: Severity;
  reason: string;
}

/** Applied to the script command itself. */
const COMMAND_RULES: Rule[] = [
  { pattern: /\b(curl|wget)\b[^|;&]*\|\s*(ba|z)?sh\b/, severity: 'high', reason: 'pipes a download straight into a shell' },
  { pattern: /\b(curl|wget|Invoke-WebRequest|iwr)\b/i, severity: 'warn', reason: 'downloads something at install time' },
  { pattern: /\bpowershell\b|-EncodedCommand\b/i, severity: 'high', reason: 'runs PowerShell' },
  { pattern: /\bnode\s+(-e|--eval|-p|--print)\b/, severity: 'warn', reason: 'runs inline JavaScript' },
  { pattern: /\b(eval|atob)\s*\(|base64\s+(-d|--decode)|['"]base64['"]/, severity: 'high', reason: 'decodes or evaluates hidden code' },
  { pattern: /\.npmrc|\.ssh\b|id_rsa|\.aws\/|\.git-credentials|\bprintenv\b|\benv\s*\|/, severity: 'high', reason: 'touches credentials or dumps the environment' },
  { pattern: /\b\d{1,3}(\.\d{1,3}){3}\b/, severity: 'high', reason: 'contacts a raw IP address' },
  { pattern: /https?:\/\//, severity: 'warn', reason: 'contains a URL' },
  { pattern: /rm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)/, severity: 'high', reason: 'deletes outside the project' },
  { pattern: /\\x[0-9a-f]{2}|[A-Za-z0-9+/]{60,}={0,2}/i, severity: 'warn', reason: 'contains an encoded or obfuscated blob' },
];

/** Applied to a local JS file the script runs (e.g. `node scripts/postinstall.js`). */
const FILE_RULES: Rule[] = [
  { pattern: /\b(eval|new\s+Function)\s*\(/, severity: 'high', reason: 'script file evaluates dynamic code' },
  { pattern: /Buffer\.from\([^)]*['"](base64|hex)['"]|\batob\s*\(/, severity: 'warn', reason: 'script file decodes base64/hex data' },
  { pattern: /\.npmrc|\.ssh|id_rsa|\.aws\/|\.git-credentials/, severity: 'high', reason: 'script file reads credential files' },
  { pattern: /child_process/, severity: 'warn', reason: 'script file spawns processes' },
  { pattern: /\b(https?\.(request|get)|fetch\s*\(|net\.connect|dns\.(lookup|resolve))/, severity: 'warn', reason: 'script file makes network calls' },
  { pattern: /JSON\.stringify\(\s*process\.env\s*\)/, severity: 'high', reason: 'script file serialises the whole environment' },
];

/** Widely used, well-understood install steps. Still reported, but as info. */
const KNOWN_BENIGN = /^(node-gyp rebuild|node-pre-gyp install.*|prebuild-install.*|husky( install)?|patch-package|opencollective(-postinstall)?.*|bower install|tsc|npm run [\w:-]+|yarn [\w:-]+|lerna bootstrap)$/;

const RANK: Record<Severity, number> = { info: 0, warn: 1, high: 2 };

export function auditCommand(command: string, fileSource?: string): { severity: Severity; reasons: string[] } {
  const hits = COMMAND_RULES.filter((r) => r.pattern.test(command));
  if (fileSource) hits.push(...FILE_RULES.filter((r) => r.pattern.test(fileSource)));

  // Network plus process spawning inside the same file is the classic dropper shape.
  const reasons = hits.map((h) => h.reason);
  let severity: Severity = hits.reduce<Severity>((s, h) => (RANK[h.severity] > RANK[s] ? h.severity : s), 'info');
  if (reasons.includes('script file spawns processes') && reasons.includes('script file makes network calls')) {
    severity = 'high';
    reasons.push('script file both downloads and executes');
  }

  if (!hits.length) {
    reasons.push(KNOWN_BENIGN.test(command.trim()) ? 'common install step' : 'runs automatically on install; review it');
  }
  return { severity, reasons };
}

/** Finds `node some/file.js` style commands so the file itself can be audited. */
export function scriptFileOf(command: string): string | null {
  const m = /\bnode\s+(?:--?[\w-]+(?:=\S+)?\s+)*([^\s;&|]+\.[cm]?js)\b/.exec(command);
  return m?.[1] ?? null;
}

export async function auditManifests(root: string, files: string[]): Promise<{
  findings: InstallScriptFinding[];
  manifests: DependencySummary[];
}> {
  const findings: InstallScriptFinding[] = [];
  const manifests: DependencySummary[] = [];

  for (const manifest of files.filter((f) => f === 'package.json' || f.endsWith('/package.json'))) {
    const pkg = await readJson(path.join(root, manifest));
    if (!pkg) continue;
    const name = typeof pkg.name === 'string' ? pkg.name : null;
    const scripts = stringRecord(pkg.scripts);
    manifests.push({
      manifest,
      name,
      engines: stringRecord(pkg.engines),
      dependencies: stringRecord(pkg.dependencies),
      devDependencies: stringRecord(pkg.devDependencies),
      scripts,
    });

    for (const hook of INSTALL_HOOKS) {
      const command = scripts[hook];
      if (!command) continue;
      const scriptFile = scriptFileOf(command);
      const fileSource = scriptFile
        ? await readFile(path.join(root, path.dirname(manifest), scriptFile), 'utf8').catch(() => undefined)
        : undefined;
      findings.push({ manifest, packageName: name ?? manifest, hook, command, ...auditCommand(command, fileSource) });
    }
  }

  for (const lockfile of files.filter((f) => f === 'package-lock.json' || f === 'npm-shrinkwrap.json')) {
    findings.push(...(await auditLockfile(root, lockfile)));
  }

  findings.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  return { findings, manifests };
}

/** npm lockfile v2+ records `hasInstallScript` for every dependency that runs one. */
async function auditLockfile(root: string, lockfile: string): Promise<InstallScriptFinding[]> {
  const lock = await readJson(path.join(root, lockfile));
  const packages = lock?.packages;
  if (!packages || typeof packages !== 'object') return [];
  const out: InstallScriptFinding[] = [];
  for (const [key, meta] of Object.entries(packages as Record<string, Record<string, unknown>>)) {
    if (!key || !meta?.hasInstallScript) continue;
    const packageName = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    out.push({
      manifest: lockfile,
      packageName,
      hook: 'install',
      command: `(install script of ${packageName}@${String(meta.version ?? '?')})`,
      severity: 'info',
      reasons: ['dependency runs an install script; native builds here are a common resurrection failure'],
    });
  }
  return out;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'));
}
