import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSettings, readEnvFile } from '@necromancer/core';

async function envFile(content: string | Buffer): Promise<string> {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-env-')), '.env');
  await writeFile(file, content);
  return file;
}

describe('readEnvFile', () => {
  it('reads comments, quotes, CRLF and a UTF-8 BOM', async () => {
    const file = await envFile('﻿# my keys\r\nANTHROPIC_API_KEY=sk-ant-file\r\nGITHUB_TOKEN="ghp_file"\r\n');
    expect(readEnvFile(file)).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-file', GITHUB_TOKEN: 'ghp_file' });
  });

  it('treats a missing file as empty', () => {
    expect(readEnvFile(path.join(os.tmpdir(), 'no-such-dir-necro', '.env'))).toEqual({});
  });

  it('says which file it could not read', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'necro-env-'));
    expect(() => readEnvFile(dir)).toThrow(`can't read ${dir}`);
  });

  it('asks for UTF-8 instead of silently reading a UTF-16 file', async () => {
    const file = await envFile(Buffer.from('﻿ANTHROPIC_API_KEY=sk-ant-file\n', 'utf16le'));
    expect(() => readEnvFile(file)).toThrow('save it as UTF-8');
  });
});

describe('loadSettings', () => {
  it('fills in missing or empty variables and leaves set ones alone', async () => {
    const file = await envFile('ANTHROPIC_API_KEY=sk-ant-file\nGITHUB_TOKEN=ghp_file\nEMPTY_IN_ENV=from-file\n');
    const env: NodeJS.ProcessEnv = { GITHUB_TOKEN: 'ghp_shell', EMPTY_IN_ENV: '' };
    loadSettings(env, file);
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-file', GITHUB_TOKEN: 'ghp_shell', EMPTY_IN_ENV: 'from-file' });
  });

  it('prefers NECROMANCER_ANTHROPIC_API_KEY over ANTHROPIC_API_KEY', async () => {
    const env: NodeJS.ProcessEnv = { NECROMANCER_ANTHROPIC_API_KEY: 'sk-ant-plugin', ANTHROPIC_API_KEY: 'sk-ant-shell' };
    loadSettings(env, await envFile('ANTHROPIC_API_KEY=sk-ant-file\n'));
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-plugin');
  });

  it('never lets a key in the file beat one from the environment', async () => {
    const file = await envFile('NECROMANCER_ANTHROPIC_API_KEY=sk-ant-file-own\nANTHROPIC_API_KEY=sk-ant-file\n');
    const shell: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'sk-ant-shell' };
    loadSettings(shell, file);
    expect(shell).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-shell' });

    const gateway: NodeJS.ProcessEnv = { ANTHROPIC_AUTH_TOKEN: 'gateway-token' };
    loadSettings(gateway, file);
    expect(gateway).toEqual({ ANTHROPIC_AUTH_TOKEN: 'gateway-token' });
  });

  it('ignores an empty or unexpanded plugin setting', async () => {
    const file = await envFile('ANTHROPIC_API_KEY=sk-ant-file\n');
    const shell: NodeJS.ProcessEnv = { NECROMANCER_ANTHROPIC_API_KEY: '', ANTHROPIC_API_KEY: 'sk-ant-shell' };
    loadSettings(shell, file);
    expect(shell.ANTHROPIC_API_KEY).toBe('sk-ant-shell');

    const literal: NodeJS.ProcessEnv = { NECROMANCER_ANTHROPIC_API_KEY: '${user_config.anthropic_api_key}' };
    loadSettings(literal, file);
    expect(literal.ANTHROPIC_API_KEY).toBe('sk-ant-file');
  });
});
