import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isUiBuild, PUBLISHED_PACKAGE, uiDistDir, uiMissingWarning } from '../src/index.js';

describe('UI assets', () => {
  it('needs both index.html and a non-empty assets directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'necro-ui-'));
    expect(isUiBuild(dir)).toBe(false);
    await writeFile(path.join(dir, 'index.html'), '<!doctype html>');
    expect(isUiBuild(dir)).toBe(false);
    await mkdir(path.join(dir, 'assets'));
    expect(isUiBuild(dir)).toBe(false);
    await writeFile(path.join(dir, 'assets', 'index.js'), '');
    expect(isUiBuild(dir)).toBe(true);
  });

  it('finds a complete build or none', () => {
    const dist = uiDistDir();
    expect(dist === null || isUiBuild(dist)).toBe(true);
  });

  it('tells npm users to reinstall and workspace users to build', () => {
    const npm = uiMissingWarning(PUBLISHED_PACKAGE);
    expect(npm).toContain('reinstall legacy-necromancer');
    expect(npm).toContain('https://github.com/tttmaximttt/legacy-necromancer/issues');
    expect(npm).not.toContain('pnpm');
    expect(uiMissingWarning('@necromancer/cli')).toContain('run `pnpm build`');
    expect(uiMissingWarning()).toContain('run `pnpm build`');
  });
});
