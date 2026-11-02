import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

/** Where Necromancer looks for settings such as ANTHROPIC_API_KEY when they aren't in the environment. */
export function defaultEnvFile(): string {
  return path.join(os.homedir(), '.necromancer', '.env');
}

/** A non-empty value, ignoring blanks and an unexpanded `${...}` that older Claude Code versions pass through. */
export function usable(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && !/^\$\{[^}]*\}$/.test(v) ? v : undefined;
}

/** Parses a .env file. A missing file is empty. */
export function readEnvFile(file: string = defaultEnvFile()): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`can't read ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (text.includes('\u0000')) throw new Error(`can't read ${file}: save it as UTF-8`);
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(parseEnv(text.replace(/^\uFEFF/, '')))) if (value !== undefined) vars[name] = value;
  return vars;
}

let cached: Record<string, string> | undefined;

/**
 * The variables in ~/.necromancer/.env, read once per process. They are never copied into process.env, so child
 * processes don't inherit them. An unreadable file is reported once on stderr and treated as empty.
 */
export function fileSettings(): Record<string, string> {
  if (!cached) {
    try {
      cached = readEnvFile();
    } catch (err) {
      process.stderr.write(`necromancer: ignoring settings file: ${err instanceof Error ? err.message : String(err)}\n`);
      cached = {};
    }
  }
  return cached;
}

/** A setting from the environment, or else from ~/.necromancer/.env. */
export function setting(name: string, env: NodeJS.ProcessEnv = process.env, file: Record<string, string> = fileSettings()): string | undefined {
  return usable(env[name]) ?? usable(file[name]);
}
