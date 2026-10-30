import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SandboxLimits } from '@necromancer/core';
import type { BootOptions, BootResult, Sandbox, StepResult } from '@necromancer/resurrect';

type Step = { ok: boolean; log?: string; health?: BootResult['health'] };

/**
 * A sandbox that replays scripted results per step, and records what it was asked to do, including the
 * Dockerfile and package.json it was handed for each install.
 */
export class FakeSandbox implements Sandbox {
  readonly calls: Array<{ step: 'install' | 'run' | 'boot'; image?: string; command?: string; outTag?: string; boot?: BootOptions; limits?: SandboxLimits }> = [];
  readonly dockerfiles: string[] = [];
  readonly manifests: Array<Record<string, unknown>> = [];
  cleaned = 0;

  constructor(private readonly script: { install?: Step[]; run?: Step[]; boot?: Step[] }) {}

  async ping(): Promise<void> {}

  async install(contextDir: string, tag: string, limits: SandboxLimits): Promise<StepResult> {
    this.calls.push({ step: 'install', image: tag, limits });
    this.dockerfiles.push(await readFile(path.join(contextDir, 'Dockerfile.necromancer'), 'utf8'));
    this.manifests.push(JSON.parse(await readFile(path.join(contextDir, 'package.json'), 'utf8')) as Record<string, unknown>);
    return this.next('install');
  }

  async run(image: string, command: string, _env: Record<string, string>, limits: SandboxLimits, outTag?: string): Promise<StepResult> {
    this.calls.push({ step: 'run', image, command, outTag, limits });
    return this.next('run');
  }

  async boot(image: string, options: BootOptions): Promise<BootResult> {
    this.calls.push({ step: 'boot', image, boot: options });
    const s = this.take('boot');
    return { ok: s.ok, log: s.log ?? '', durationMs: 1, health: s.ok ? (s.health ?? { kind: 'port', detail: 'port answered' }) : null };
  }

  async cleanup(): Promise<void> {
    this.cleaned++;
  }

  private take(step: 'install' | 'run' | 'boot'): Step {
    return this.script[step]?.shift() ?? { ok: true };
  }

  private next(step: 'install' | 'run'): StepResult {
    const s = this.take(step);
    return { ok: s.ok, log: s.log ?? '', durationMs: 1 };
  }
}

export async function deadApp(files: Record<string, string>, date = '2017-09-01T10:00:00'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'necro-dead-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], {
      cwd: root,
      env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return root;
}

export const expressMongoApp = {
  'package.json': JSON.stringify({
    name: 'dead-notes',
    main: 'server.js',
    scripts: { start: 'node server.js' },
    dependencies: { express: '^4.15.0', mongoose: '^4.11.0', bcrypt: '^1.0.2' },
    devDependencies: { 'node-sass': '^4.5.0' },
    engines: { node: '>=6' },
  }),
  'package-lock.json': '{"lockfileVersion":1}',
  'server.js':
    "var mongoose = require('mongoose');\nmongoose.connect(process.env.MONGO_URL || 'mongodb://localhost/notes');\nrequire('express')().listen(process.env.PORT || 3000);\n",
};

export const NODE_GYP_LOG = `npm WARN deprecated node-pre-gyp@0.6.39
> bcrypt@1.0.3 install /app/node_modules/bcrypt
> node-pre-gyp install --fallback-to-build
node-pre-gyp WARN Pre-built binaries not installable for bcrypt@1.0.3 and node@6.17.1 (node-v48 ABI) (falling back to source compile with node-gyp)
gyp ERR! configure error
gyp ERR! stack Error: Can't find Python executable "python", you can set the PYTHON env variable.
gyp ERR! stack     at PythonFinder.failNoPython (/usr/local/lib/node_modules/npm/node_modules/node-gyp/lib/configure.js:483:19)
npm ERR! code ELIFECYCLE
npm ERR! errno 1
npm ERR! bcrypt@1.0.3 install: \`node-pre-gyp install --fallback-to-build\`
The command '/bin/sh -c npm install' returned a non-zero code: 1`;
