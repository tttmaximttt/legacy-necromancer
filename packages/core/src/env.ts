import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

/** Where Necromancer looks for settings such as ANTHROPIC_API_KEY when they aren't in the environment. */
export function defaultEnvFile(): string {
  return path.join(os.homedir(), '.necromancer', '.env');
}

/** The ways to give the Anthropic SDK credentials. One set in the environment means the file's are not used. */
const CREDENTIALS = ['NECROMANCER_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/** A non-empty value, ignoring an unexpanded `${...}` that older Claude Code versions pass through literally. */
function usable(value: string | undefined): string | undefined {
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
  for (const [name, value] of Object.entries(parseEnv(text.replace(/^﻿/, '')))) if (value !== undefined) vars[name] = value;
  return vars;
}

/**
 * Sets up this process's settings. The key is the first of: NECROMANCER_ANTHROPIC_API_KEY (which the Claude Code
 * plugin sets from its own settings), ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN from the environment, then the same
 * names from ~/.necromancer/.env. Other variables in the file fill in only what the environment leaves unset.
 *
 * A separate name lets you keep the key away from Claude Code itself, which bills to ANTHROPIC_API_KEY when it finds
 * one in its environment.
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env, file: string = defaultEnvFile()): void {
  const fromFile = readEnvFile(file);
  const envHasKey = CREDENTIALS.some((name) => usable(env[name]));
  for (const [name, value] of Object.entries(fromFile)) {
    if (CREDENTIALS.includes(name) ? envHasKey : usable(env[name])) continue;
    env[name] = value;
  }
  const own = usable(env.NECROMANCER_ANTHROPIC_API_KEY);
  if (own) env.ANTHROPIC_API_KEY = own;
}
