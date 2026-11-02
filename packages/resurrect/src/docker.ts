import { spawn } from 'node:child_process';
import Docker from 'dockerode';
import { errorMessage, type SandboxLimits } from '@necromancer/core';
import { serviceLimits } from './compose.js';

export interface StepResult {
  ok: boolean;
  log: string;
  durationMs: number;
  timedOut?: boolean;
}

export interface BootService {
  image: string;
  /** The port it serves on its localhost, to wait for before the app starts. */
  port: number;
  env: Record<string, string>;
}

export interface BootOptions {
  /** The start command; a committed build image's own CMD is the build script. */
  command: string;
  env: Record<string, string>;
  port: number | null;
  services: BootService[];
  limits: SandboxLimits;
}

export interface BootResult extends StepResult {
  health: { kind: 'port' | 'log'; detail: string } | null;
  /** The running app's container, whose network namespace `exec` can join; null if it isn't running. */
  namespace: string | null;
}

/**
 * Everything Resurrect does to containers. The loop only talks to this interface, so tests run it against a
 * scripted sandbox and nothing needs Docker.
 */
export interface Sandbox {
  /** Throws a readable error when Docker isn't reachable. */
  ping(): Promise<void>;
  /** `docker build` of the context: the only step with network access, used to install dependencies. */
  install(contextDir: string, tag: string, limits: SandboxLimits): Promise<StepResult>;
  /** Runs a command in a container from `image` with no network; on success, commits the result as `outTag`. */
  run(image: string, command: string, env: Record<string, string>, limits: SandboxLimits, outTag?: string): Promise<StepResult>;
  /** Starts services and the app with no network beyond their shared localhost, and waits for a health signal. */
  boot(image: string, options: BootOptions): Promise<BootResult>;
  /**
   * Runs a command from `image` inside a booted app's network namespace (its localhost and services, nothing
   * else), with the same limits; used to send requests and run the project's tests next to the live app.
   */
  exec(image: string, namespace: string, command: string[], env: Record<string, string>, limits: SandboxLimits): Promise<StepResult>;
  /** Removes every container and image this sandbox created. */
  cleanup(): Promise<void>;
}

export interface DockerSandboxOptions {
  docker?: Docker;
  /**
   * Pass the host's HTTP(S)_PROXY to the install step, for networks where the registry is only reachable through
   * a proxy. A proxy on the host's loopback is only reachable with host networking, which this then uses.
   */
  buildProxy?: boolean;
  /** How long boot waits for a health signal. */
  healthTimeoutSec?: number;
  onLog?: (line: string) => void;
}

/** Log lines that mean "the server is up" in most Node apps of any era. */
export const READY_LOG = /(listening (on|at)|server (is )?(running|started|listening)|started (on|at) (port|http)|running (on|at) (port|http)|ready on|express server|app(lication)? started|now listening)/i;

const SECURE_HOST = {
  CapDrop: ['ALL'],
  SecurityOpt: ['no-new-privileges'],
  // Nothing from the host is mounted; the repo was copied into the image.
  Binds: [],
};

function resources(l: Pick<SandboxLimits, 'cpus' | 'memoryMb' | 'pids'>) {
  return { Memory: l.memoryMb * 1024 * 1024, MemorySwap: l.memoryMb * 1024 * 1024, NanoCpus: Math.round(l.cpus * 1e9), PidsLimit: l.pids };
}

export class DockerSandbox implements Sandbox {
  private readonly docker: Docker;
  private readonly containers = new Set<string>();
  private readonly images = new Set<string>();

  constructor(private readonly options: DockerSandboxOptions = {}) {
    this.docker = options.docker ?? new Docker();
  }

  async ping(): Promise<void> {
    try {
      await this.docker.ping();
    } catch (err) {
      throw new Error(`Docker is not reachable (${errorMessage(err)}); start Docker and try again`);
    }
  }

  async install(contextDir: string, tag: string, limits: SandboxLimits): Promise<StepResult> {
    const started = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), limits.stepTimeoutSec * 1000);
    const lines: string[] = [];
    let error: string | null = null;
    const proxy = this.options.buildProxy ? proxyArgs() : null;
    try {
      const stream = await this.docker.buildImage(tarStream(contextDir), {
        t: tag,
        dockerfile: 'Dockerfile.necromancer',
        rm: true,
        forcerm: true,
        memory: limits.memoryMb * 1024 * 1024,
        memswap: limits.memoryMb * 1024 * 1024,
        cpuperiod: 100_000,
        cpuquota: Math.round(limits.cpus * 100_000),
        ...(proxy && { buildargs: proxy.args, networkmode: proxy.hostNetwork ? 'host' : 'default' }),
        abortSignal: abort.signal,
      } as Docker.ImageBuildOptions);
      this.images.add(tag);
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(
          stream,
          (err) => (err ? reject(err) : resolve()),
          (event: { stream?: string; error?: string; errorDetail?: { message?: string } }) => {
            if (event.stream) {
              lines.push(event.stream);
              for (const l of event.stream.split('\n')) if (l.trim()) this.options.onLog?.(l);
            }
            if (event.error) error = event.errorDetail?.message ?? event.error;
          },
        );
      });
    } catch (err) {
      error ??= abort.signal.aborted ? `timed out after ${limits.stepTimeoutSec}s` : errorMessage(err);
    } finally {
      clearTimeout(timer);
    }
    if (error) lines.push(`\n${error}\n`);
    return { ok: !error, log: lines.join(''), durationMs: Date.now() - started, ...(abort.signal.aborted && { timedOut: true }) };
  }

  async run(image: string, command: string, env: Record<string, string>, limits: SandboxLimits, outTag?: string): Promise<StepResult> {
    const started = Date.now();
    const container = await this.create({
      Image: image,
      Cmd: ['sh', '-c', command],
      Env: toEnv(env),
      WorkingDir: '/app',
      HostConfig: { ...SECURE_HOST, ...resources(limits), NetworkMode: 'none' },
    });
    await container.start();
    const exit = await waitFor(container, limits.stepTimeoutSec * 1000);
    const log = await logsOf(container);
    if (exit.code === 0 && outTag) {
      const [repo, tag] = splitTag(outTag);
      await container.commit({ repo, tag });
      this.images.add(outTag);
    }
    await this.remove(container);
    return stepResult(exit, log, started, limits);
  }

  async boot(image: string, options: BootOptions): Promise<BootResult> {
    const started = Date.now();
    const healthTimeoutSec = this.options.healthTimeoutSec ?? 90;
    const deadline = started + healthTimeoutSec * 1000;
    const { limits } = options;
    // The first service owns the network namespace (loopback only); everything else joins it.
    let owner: Docker.Container | null = null;
    const serviceLogs: string[] = [];
    for (const s of options.services) {
      const c = await this.create({
        Image: s.image,
        Env: toEnv(s.env),
        HostConfig: {
          ...resources(serviceLimits(limits)),
          SecurityOpt: ['no-new-privileges'],
          NetworkMode: owner ? `container:${owner.id}` : 'none',
        },
      });
      await c.start();
      owner ??= c;
    }
    for (const s of options.services) {
      if (!(await this.probe(image, owner!.id, s.port, deadline))) {
        serviceLogs.push(`service ${s.image} did not open port ${s.port}`);
      }
    }
    const app = await this.create({
      Image: image,
      Cmd: ['sh', '-c', options.command],
      Env: toEnv(options.env),
      WorkingDir: '/app',
      HostConfig: { ...SECURE_HOST, ...resources(limits), NetworkMode: owner ? `container:${owner.id}` : 'none' },
    });
    await app.start();

    let health: BootResult['health'] = null;
    let crashed = false;
    while (Date.now() < deadline) {
      await sleep(2000);
      const state = (await app.inspect()).State;
      const log = await logsOf(app);
      if (!state.Running) {
        crashed = true;
        serviceLogs.push(`app exited with code ${state.ExitCode}`);
        break;
      }
      if (options.port && (await this.probe(image, app.id, options.port, Date.now() + 3000))) {
        health = { kind: 'port', detail: `port ${options.port} accepted a connection` };
        break;
      }
      const ready = log.split('\n').find((l) => READY_LOG.test(l));
      if (!options.port && ready) {
        health = { kind: 'log', detail: ready.trim().slice(0, 200) };
        break;
      }
    }
    if (!health && !crashed && !options.port) {
      health = { kind: 'log', detail: `kept running for ${Math.round((Date.now() - started) / 1000)}s without crashing (no port to probe)` };
    }
    const log = `${await logsOf(app)}${serviceLogs.length ? `\n${serviceLogs.join('\n')}\n` : ''}${!health && !crashed ? `\nno health signal within ${healthTimeoutSec}s\n` : ''}`;
    return { ok: health !== null, log, durationMs: Date.now() - started, health, namespace: crashed ? null : app.id };
  }

  async exec(image: string, namespace: string, command: string[], env: Record<string, string>, limits: SandboxLimits): Promise<StepResult> {
    const started = Date.now();
    const c = await this.create({
      Image: image,
      Cmd: command,
      Env: toEnv(env),
      WorkingDir: '/app',
      HostConfig: { ...SECURE_HOST, ...resources(limits), NetworkMode: `container:${namespace}` },
    });
    await c.start();
    const exit = await waitFor(c, limits.stepTimeoutSec * 1000);
    const log = await logsOf(c);
    await this.remove(c);
    return stepResult(exit, log, started, limits);
  }

  /** Connects to localhost:port from inside a namespace, using node from the app image (every era has net.connect). */
  private async probe(image: string, namespace: string, port: number, deadline: number): Promise<boolean> {
    const script = `var s=require('net').connect(${port},'127.0.0.1');s.on('connect',function(){process.exit(0)});s.on('error',function(){process.exit(1)})`;
    while (Date.now() < deadline) {
      const c = await this.create({
        Image: image,
        Entrypoint: ['node', '-e', script],
        Cmd: [],
        HostConfig: { ...SECURE_HOST, Memory: 128 * 1024 * 1024, NetworkMode: `container:${namespace}` },
      });
      await c.start();
      const exit = await waitFor(c, 10_000);
      await this.remove(c);
      if (exit.code === 0) return true;
      await sleep(1500);
    }
    return false;
  }

  async cleanup(): Promise<void> {
    for (const id of [...this.containers].reverse()) await this.remove(this.docker.getContainer(id));
    for (const tag of this.images) await this.docker.getImage(tag).remove({ force: true }).catch(() => {});
    this.images.clear();
  }

  private async create(spec: Docker.ContainerCreateOptions): Promise<Docker.Container> {
    const c = await this.docker.createContainer({ Tty: true, Labels: { 'necromancer.sandbox': '1' }, ...spec });
    this.containers.add(c.id);
    return c;
  }

  private async remove(c: Docker.Container): Promise<void> {
    await c.remove({ force: true }).catch(() => {});
    this.containers.delete(c.id);
  }
}

function stepResult(exit: { code: number | null; timedOut: boolean }, log: string, started: number, limits: SandboxLimits): StepResult {
  return {
    ok: exit.code === 0,
    log: exit.timedOut ? `${log}\ntimed out after ${limits.stepTimeoutSec}s\n` : log,
    durationMs: Date.now() - started,
    ...(exit.timedOut && { timedOut: true }),
  };
}

function toEnv(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

function splitTag(ref: string): [string, string] {
  const i = ref.lastIndexOf(':');
  return i > ref.lastIndexOf('/') ? [ref.slice(0, i), ref.slice(i + 1)] : [ref, 'latest'];
}

async function waitFor(c: Docker.Container, ms: number): Promise<{ code: number | null; timedOut: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)));
  const result = (await Promise.race([c.wait(), timeout])) as { StatusCode: number } | null;
  clearTimeout(timer);
  if (result) return { code: result.StatusCode, timedOut: false };
  await c.kill().catch(() => {});
  return { code: null, timedOut: true };
}

async function logsOf(c: Docker.Container): Promise<string> {
  try {
    const buf = (await c.logs({ stdout: true, stderr: true, follow: false })) as unknown as Buffer;
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function tarStream(dir: string): NodeJS.ReadableStream {
  const tar = spawn('tar', ['-C', dir, '-c', '.'], { stdio: ['ignore', 'pipe', 'inherit'] });
  return tar.stdout;
}

function proxyArgs(): { args: Record<string, string>; hostNetwork: boolean } | null {
  const args: Record<string, string> = {};
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) {
    if (process.env[key]) args[key] = process.env[key]!;
  }
  if (!Object.keys(args).length) return null;
  const url = args.HTTPS_PROXY ?? args.https_proxy ?? args.HTTP_PROXY ?? args.http_proxy ?? '';
  // apt fetches Debian mirrors over plain HTTP and only reads http_proxy.
  if (!args.HTTP_PROXY && !args.http_proxy) {
    args.HTTP_PROXY = url;
    args.http_proxy = url;
  }
  return { args, hostNetwork: /\/\/(127\.|localhost|\[::1\])/.test(url) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
