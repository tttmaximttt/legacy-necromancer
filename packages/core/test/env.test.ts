import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEnvFile, setting } from '@necromancer/core';

async function envFile(content: string | Buffer): Promise<string> {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-env-')), '.env');
  await writeFile(file, content);
  return file;
}

describe('readEnvFile', () => {
  it('reads comments, quotes, CRLF and a UTF-8 BOM', async () => {
    const file = await envFile('\uFEFF# my keys\r\nANTHROPIC_API_KEY=sk-ant-file\r\nGITHUB_TOKEN="ghp_file"\r\n');
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
    const file = await envFile(Buffer.from('\uFEFFANTHROPIC_API_KEY=sk-ant-file\n', 'utf16le'));
    expect(() => readEnvFile(file)).toThrow('save it as UTF-8');
  });
});

describe('setting', () => {
  it('takes the environment first, then the file, ignoring blanks and unexpanded placeholders', () => {
    const file = { GITHUB_TOKEN: 'ghp_file', OTHER: 'from-file' };
    expect(setting('GITHUB_TOKEN', { GITHUB_TOKEN: 'ghp_shell' }, file)).toBe('ghp_shell');
    expect(setting('GITHUB_TOKEN', { GITHUB_TOKEN: '  ' }, file)).toBe('ghp_file');
    expect(setting('GITHUB_TOKEN', { GITHUB_TOKEN: '${user_config.x}' }, file)).toBe('ghp_file');
    expect(setting('MISSING', {}, file)).toBeUndefined();
  });
});
