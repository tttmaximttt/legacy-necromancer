import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, DockerSandbox } from '@necromancer/resurrect';

interface FakeContainer {
  id: string;
  spec: Docker.ContainerCreateOptions;
  removed: boolean;
}

/** Just enough of dockerode to see what the sandbox asks Docker for. */
function fakeDocker(opts: { buildEvents?: object[]; exitCode?: (spec: Docker.ContainerCreateOptions) => number; running?: boolean; logs?: string } = {}) {
  const containers: FakeContainer[] = [];
  const builds: Array<Record<string, unknown>> = [];
  const commits: unknown[] = [];
  const removedImages: string[] = [];
  const docker = {
    ping: async () => 'OK',
    buildImage: async (_tar: unknown, options: Record<string, unknown>) => {
      builds.push(options);
      const s = new PassThrough();
      s.end();
      return s;
    },
    modem: {
      followProgress: (_s: unknown, done: (err: Error | null) => void, onEvent: (e: object) => void) => {
        for (const e of opts.buildEvents ?? [{ stream: 'Step 1/5 : FROM node:8\n' }]) onEvent(e);
        done(null);
      },
    },
    createContainer: async (spec: Docker.ContainerCreateOptions) => {
      const c: FakeContainer = { id: `c${containers.length}`, spec, removed: false };
      containers.push(c);
      return {
        id: c.id,
        start: async () => {},
        wait: async () => ({ StatusCode: opts.exitCode?.(spec) ?? 0 }),
        logs: async () => Buffer.from(opts.logs ?? 'Express server listening on port 3000\n'),
        inspect: async () => ({ State: { Running: opts.running ?? true, ExitCode: 0 } }),
        commit: async (o: unknown) => void commits.push(o),
        kill: async () => {},
        remove: async () => void (c.removed = true),
      };
    },
    getContainer: (id: string) => ({ id, remove: async () => void (containers.find((c) => c.id === id)!.removed = true) }),
    getImage: (tag: string) => ({ remove: async () => void removedImages.push(tag) }),
  };
  return { docker: docker as unknown as Docker, containers, builds, commits, removedImages };
}

async function context(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'necro-ctx-'));
  await writeFile(path.join(dir, 'Dockerfile.necromancer'), 'FROM node:8\n');
  return dir;
}

describe('DockerSandbox', () => {
  it('builds with CPU and memory limits, and no proxy or host network unless asked', async () => {
    const fake = fakeDocker();
    const sandbox = new DockerSandbox({ docker: fake.docker });
    const result = await sandbox.install(await context(), 'necromancer/x:attempt-1', { ...DEFAULT_LIMITS, cpus: 1.5, memoryMb: 1024 });
    expect(result.ok).toBe(true);
    expect(fake.builds[0]).toMatchObject({ t: 'necromancer/x:attempt-1', dockerfile: 'Dockerfile.necromancer', memory: 1024 ** 3, memswap: 1024 ** 3, cpuquota: 150_000 });
    expect(fake.builds[0]).not.toHaveProperty('buildargs');
    expect(fake.builds[0]).not.toHaveProperty('networkmode');
  });

  it('passes a loopback proxy with host networking only when asked', async () => {
    const saved = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
    try {
      const fake = fakeDocker();
      await new DockerSandbox({ docker: fake.docker, buildProxy: true }).install(await context(), 't:1', DEFAULT_LIMITS);
      expect(fake.builds[0]).toMatchObject({ networkmode: 'host', buildargs: { HTTPS_PROXY: 'http://127.0.0.1:3128', http_proxy: 'http://127.0.0.1:3128' } });
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved;
    }
  });

  it('reports a failed build with the daemon’s error', async () => {
    const fake = fakeDocker({ buildEvents: [{ stream: 'npm ERR! code E404\n' }, { error: 'returned a non-zero code: 1', errorDetail: { message: 'returned a non-zero code: 1' } }] });
    const result = await new DockerSandbox({ docker: fake.docker }).install(await context(), 't:1', DEFAULT_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.log).toContain('npm ERR! code E404');
    expect(result.log).toContain('returned a non-zero code: 1');
  });

  it('runs build scripts with no network, no capabilities and no mounts, and commits the result', async () => {
    const fake = fakeDocker();
    const result = await new DockerSandbox({ docker: fake.docker }).run('img:1', 'npm run build', { A: '1' }, DEFAULT_LIMITS, 'img:1-built');
    expect(result.ok).toBe(true);
    expect(fake.containers[0]!.spec).toMatchObject({
      Image: 'img:1',
      Cmd: ['sh', '-c', 'npm run build'],
      Env: ['A=1'],
      HostConfig: { NetworkMode: 'none', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Binds: [], Memory: 2048 * 1024 ** 2, NanoCpus: 2e9, PidsLimit: 512 },
    });
    expect(fake.commits).toEqual([{ repo: 'img', tag: '1-built' }]);
    expect(fake.containers[0]!.removed).toBe(true);
  });

  it('boots services and app in one loopback-only namespace and probes the port from inside it', async () => {
    const fake = fakeDocker();
    const sandbox = new DockerSandbox({ docker: fake.docker, healthTimeoutSec: 30 });
    const result = await sandbox.boot('app:1', {
      command: 'npm start',
      env: { MONGO_URL: 'mongodb://localhost:27017/app' },
      port: 3000,
      services: [{ image: 'mongo:3.4', port: 27017, env: {} }],
      limits: DEFAULT_LIMITS,
    });
    expect(result).toMatchObject({ ok: true, health: { kind: 'port', detail: 'port 3000 accepted a connection' } });
    const [mongo, ...rest] = fake.containers;
    expect(mongo!.spec).toMatchObject({ Image: 'mongo:3.4', HostConfig: { NetworkMode: 'none', Memory: 1024 * 1024 ** 2 } });
    const app = rest.find((c) => c.spec.Image === 'app:1' && c.spec.Cmd?.[2] === 'npm start')!;
    expect(app.spec.HostConfig).toMatchObject({ NetworkMode: `container:${mongo!.id}`, CapDrop: ['ALL'], Binds: [] });
    const probes = rest.filter((c) => c.spec.Entrypoint);
    expect(probes.map((p) => p.spec.Entrypoint![2])).toEqual([expect.stringContaining('connect(27017'), expect.stringContaining('connect(3000')]);
    expect(probes.every((p) => p.spec.HostConfig!.NetworkMode!.startsWith('container:'))).toBe(true);

    await sandbox.cleanup();
    expect(fake.containers.every((c) => c.removed)).toBe(true);
  }, 20_000);

  it('fails the boot when the app exits', async () => {
    const fake = fakeDocker({ running: false, logs: 'Error: listen EADDRINUSE\n' });
    const result = await new DockerSandbox({ docker: fake.docker, healthTimeoutSec: 10 }).boot('app:1', { command: 'npm start', env: {}, port: 3000, services: [], limits: DEFAULT_LIMITS });
    expect(result.ok).toBe(false);
    expect(result.log).toContain('EADDRINUSE');
    expect(result.log).toContain('app exited');
  }, 20_000);
});
