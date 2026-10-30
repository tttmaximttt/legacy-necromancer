import { readFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import type { BuildRecipe, DetectedService, ServiceKind } from '@necromancer/core';

/** What Resurrect needs to know about a checkout, read once. */
export interface ProjectFacts {
  manifest: Record<string, unknown> | null;
  packageManager: BuildRecipe['packageManager'];
  /** From .nvmrc or .node-version. */
  nodeVersionFile: string | null;
  enginesNode: string | null;
  scripts: Record<string, string>;
  dependencies: string[];
  /** `process.env.X` names read anywhere in the source. */
  envNames: string[];
  /** Connection strings written in the source, e.g. mongodb://localhost/app. */
  connectionStrings: string[];
  /** A port the app listens on, from `.listen(3000)` or `PORT || 3000`. */
  listenPort: number | null;
  bower: boolean;
  files: string[];
}

const SOURCE = /\.[cm]?[jt]sx?$/;
const MAX_SCAN_BYTES = 256 * 1024;

export async function readFacts(root: string, files: string[]): Promise<ProjectFacts> {
  const read = (f: string) => readFile(path.join(root, f), 'utf8').catch(() => null);
  const manifestText = files.includes('package.json') ? await read('package.json') : null;
  let manifest: Record<string, unknown> | null = null;
  try {
    manifest = manifestText ? (JSON.parse(manifestText) as Record<string, unknown>) : null;
  } catch {
    manifest = null;
  }
  const versionFile = files.find((f) => f === '.nvmrc' || f === '.node-version');
  const env = new Set<string>();
  const urls = new Set<string>();
  let listenPort: number | null = null;
  for (const f of files.filter((f) => SOURCE.test(f) && !/(^|\/)(test|tests|spec|__tests__)\//.test(f))) {
    const text = await read(f);
    if (!text || text.length > MAX_SCAN_BYTES) continue;
    for (const m of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g)) env.add(m[1] ?? m[2]!);
    for (const m of text.matchAll(/\b(mongodb(?:\+srv)?|redis|postgres(?:ql)?|mysql|amqp):\/\/[^\s'"`]+/g)) urls.add(m[0]);
    listenPort ??= findPort(text);
  }
  const record = (key: string) => (manifest?.[key] && typeof manifest[key] === 'object' ? (manifest[key] as Record<string, string>) : {});
  return {
    manifest,
    packageManager: files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : 'npm',
    nodeVersionFile: versionFile ? ((await read(versionFile))?.trim() ?? null) : null,
    enginesNode: typeof record('engines').node === 'string' ? record('engines').node! : null,
    scripts: record('scripts'),
    dependencies: [...Object.keys(record('dependencies')), ...Object.keys(record('devDependencies'))],
    envNames: [...env].sort(),
    connectionStrings: [...urls].sort(),
    listenPort,
    bower: files.includes('bower.json'),
    files,
  };
}

export function findPort(text: string): number | null {
  const patterns = [/\.listen\(\s*(\d{2,5})\b/, /PORT\s*\|\|\s*(\d{2,5})\b/, /\bport\s*[:=]\s*(\d{4,5})\b/i];
  for (const p of patterns) {
    const n = Number(p.exec(text)?.[1]);
    if (n >= 80 && n <= 65535) return n;
  }
  return null;
}

/** Major lines with official images, and when each became the one people deployed (LTS start). */
const NODE_LINES: Array<[string, string]> = [
  ['0.10', '2013-03'],
  ['0.12', '2015-02'],
  ['4', '2015-10'],
  ['6', '2016-10'],
  ['8', '2017-10'],
  ['10', '2018-10'],
  ['12', '2019-10'],
  ['14', '2020-10'],
  ['16', '2021-10'],
  ['18', '2022-10'],
  ['20', '2023-10'],
  ['22', '2024-10'],
];

const CODENAMES: Record<string, string> = {
  argon: '4', boron: '6', carbon: '8', dubnium: '10', erbium: '12', fermium: '14', gallium: '16', hydrogen: '18', iron: '20', jod: '22',
};

/**
 * Picks the node image tag: .nvmrc wins; otherwise the LTS line people were deploying at the era date, moved to
 * the nearest line that `engines.node` allows.
 */
export function chooseNode(facts: Pick<ProjectFacts, 'nodeVersionFile' | 'enginesNode'>, eraDate: string | null): { tag: string; why: string } {
  const pinned = facts.nodeVersionFile?.replace(/^v/, '').toLowerCase();
  if (pinned) {
    const name = /^lts\/(\w+)/.exec(pinned)?.[1];
    if (name && CODENAMES[name]) return { tag: CODENAMES[name], why: `.nvmrc says ${facts.nodeVersionFile}` };
    const m = /^(0\.\d+|\d+)/.exec(pinned);
    if (m) return { tag: m[1]!, why: `.nvmrc says ${facts.nodeVersionFile}` };
  }
  const allowed = (line: string) => {
    if (!facts.enginesNode || !semver.validRange(facts.enginesNode)) return true;
    return semver.intersects(facts.enginesNode, line.startsWith('0.') ? `${line}.x` : `${line}.x`);
  };
  const date = eraDate?.slice(0, 7) ?? null;
  const atEra = date ? ([...NODE_LINES].reverse().find(([, from]) => from <= date) ?? NODE_LINES[0]!) : null;
  if (atEra && allowed(atEra[0])) {
    return { tag: atEra[0], why: `Node ${atEra[0]} was the LTS line in ${date}${facts.enginesNode ? `, within engines ${facts.enginesNode}` : ''}` };
  }
  const fits = NODE_LINES.filter(([line]) => allowed(line));
  if (atEra && fits.length) {
    const before = fits.filter(([, from]) => from <= date!).at(-1);
    const pick = before ?? fits[0]!;
    return { tag: pick[0], why: `engines ${facts.enginesNode} rules out Node ${atEra[0]} (the ${date} LTS); nearest allowed line` };
  }
  if (fits.length && facts.enginesNode) return { tag: fits[0]![0], why: `oldest line allowed by engines ${facts.enginesNode}` };
  return { tag: '22', why: 'no era or engines information; current LTS' };
}

interface ServiceSpec {
  packages: string[];
  scheme: RegExp;
  envMatch: RegExp;
  port: number;
  url: string;
  image: string;
  /** [first release, tag], oldest first. */
  versions: Array<[string, string]>;
  /** Environment for the service container itself. */
  serviceEnv: Record<string, string>;
}

export const SERVICES: Record<ServiceKind, ServiceSpec> = {
  mongo: {
    packages: ['mongodb', 'mongoose', 'monk', 'mongojs', 'mongoskin', 'connect-mongo', 'mongodb-core', 'waterline-mongo', 'sails-mongo'],
    scheme: /^mongodb(\+srv)?:/,
    envMatch: /MONGO/i,
    port: 27017,
    url: 'mongodb://localhost:27017/app',
    image: 'mongo',
    versions: [['2015-03', '3.0'], ['2015-12', '3.2'], ['2016-11', '3.4'], ['2017-11', '3.6'], ['2018-06', '4.0'], ['2019-08', '4.2'], ['2020-07', '4.4'], ['2021-07', '5.0'], ['2022-07', '6.0'], ['2023-08', '7.0']],
    serviceEnv: {},
  },
  redis: {
    packages: ['redis', 'ioredis', 'connect-redis', 'kue', 'bull', 'bee-queue', 'socket.io-redis', 'redis-sentinel'],
    scheme: /^redis:/,
    envMatch: /REDIS/i,
    port: 6379,
    url: 'redis://localhost:6379',
    image: 'redis',
    versions: [['2015-04', '3.0'], ['2016-05', '3.2'], ['2017-07', '4.0'], ['2018-10', '5.0'], ['2020-04', '6.0'], ['2022-04', '7.0']],
    serviceEnv: {},
  },
  postgres: {
    packages: ['pg', 'pg-promise', 'pg-native', 'postgres', 'pg-hstore'],
    scheme: /^postgres(ql)?:/,
    envMatch: /(POSTGRES|PG|DATABASE_URL)/i,
    port: 5432,
    url: 'postgres://postgres:necromancer@localhost:5432/app',
    image: 'postgres',
    versions: [['2014-12', '9.4'], ['2016-01', '9.5'], ['2016-09', '9.6'], ['2017-10', '10'], ['2018-10', '11'], ['2019-10', '12'], ['2020-09', '13'], ['2021-09', '14'], ['2022-10', '15'], ['2023-09', '16']],
    serviceEnv: { POSTGRES_PASSWORD: 'necromancer', POSTGRES_DB: 'app' },
  },
  mysql: {
    packages: ['mysql', 'mysql2', 'mariadb'],
    scheme: /^mysql:/,
    envMatch: /(MYSQL|DB_HOST|DATABASE_URL)/i,
    port: 3306,
    url: 'mysql://root@localhost:3306/app',
    image: 'mysql',
    versions: [['2013-02', '5.6'], ['2015-10', '5.7'], ['2018-04', '8.0']],
    serviceEnv: { MYSQL_ALLOW_EMPTY_PASSWORD: 'yes', MYSQL_DATABASE: 'app' },
  },
  rabbitmq: {
    packages: ['amqplib', 'amqp', 'rascal', 'amqp-connection-manager'],
    scheme: /^amqp:/,
    envMatch: /(RABBIT|AMQP)/i,
    port: 5672,
    url: 'amqp://guest:guest@localhost:5672',
    image: 'rabbitmq',
    versions: [['2015-12', '3.6'], ['2017-11', '3.7'], ['2019-10', '3.8'], ['2021-07', '3.9'], ['2023-06', '3.12']],
    serviceEnv: {},
  },
  elasticsearch: {
    packages: ['elasticsearch', '@elastic/elasticsearch', 'elastic.js'],
    scheme: /^$/,
    envMatch: /(ELASTIC|ES_HOST|SEARCH_URL)/i,
    port: 9200,
    url: 'http://localhost:9200',
    image: 'elasticsearch',
    versions: [['2015-10', '2.4'], ['2016-10', '5.6.16'], ['2017-11', '6.8.23'], ['2019-04', '7.17.10']],
    serviceEnv: { 'discovery.type': 'single-node', ES_JAVA_OPTS: '-Xms256m -Xmx256m' },
  },
  memcached: {
    packages: ['memcached', 'memjs', 'memcache'],
    scheme: /^$/,
    envMatch: /MEMCACHE/i,
    port: 11211,
    url: 'localhost:11211',
    image: 'memcached',
    versions: [['2015-01', '1.4'], ['2017-08', '1.5'], ['2020-03', '1.6']],
    serviceEnv: {},
  },
};

/** Services the app talks to, pinned to versions from its era, sharing its localhost so hard-coded URLs work. */
export function detectServices(facts: ProjectFacts, eraDate: string | null): DetectedService[] {
  const out: DetectedService[] = [];
  for (const [kind, spec] of Object.entries(SERVICES) as Array<[ServiceKind, ServiceSpec]>) {
    const evidence = [
      ...facts.dependencies.filter((d) => spec.packages.includes(d)).map((d) => `depends on ${d}`),
      ...facts.connectionStrings.filter((u) => spec.scheme.test(u)).map((u) => `connects to ${u}`),
    ];
    if (!evidence.length) continue;
    const date = eraDate?.slice(0, 7);
    const version = date ? ([...spec.versions].reverse().find(([from]) => from <= date) ?? spec.versions[0]!) : spec.versions.at(-1)!;
    const env: Record<string, string> = {};
    for (const name of facts.envNames.filter((n) => spec.envMatch.test(n))) {
      if (/(URL|URI|DSN|CONNECTION)/i.test(name)) env[name] = spec.url;
      else if (/HOST/i.test(name)) env[name] = 'localhost';
      else if (/PORT/i.test(name)) env[name] = String(spec.port);
    }
    out.push({ kind, image: `${spec.image}:${version[1]}`, evidence, env });
  }
  return out;
}

/** The first recipe, before any fixes. */
export function initialRecipe(facts: ProjectFacts, nodeTag: string, services: DetectedService[]): BuildRecipe {
  const run = (script: string) => (facts.packageManager === 'npm' ? `npm run ${script}` : `${facts.packageManager} run ${script}`);
  const main = typeof facts.manifest?.main === 'string' ? facts.manifest.main.replace(/^\.\//, '') : null;
  const entry = [main, main && `${main}.js`, 'server.js', 'app.js', 'index.js'].find((f) => f && facts.files.includes(f)) ?? null;
  const looksLikeServer = facts.listenPort !== null || 'start' in facts.scripts;
  const startCommand = 'start' in facts.scripts ? (facts.packageManager === 'npm' ? 'npm start' : `${facts.packageManager} start`) : looksLikeServer && entry ? `node ${entry}` : null;
  const env: Record<string, string> = { NODE_ENV: 'development' };
  if (facts.listenPort) env.PORT = String(facts.listenPort);
  for (const s of services) Object.assign(env, s.env);
  return {
    nodeImage: `node:${nodeTag}`,
    packageManager: facts.packageManager,
    debianArchive: false,
    aptPackages: [],
    env,
    globalInstalls: facts.packageManager === 'pnpm' ? ['pnpm@8'] : [],
    beforeInstall: [],
    bower: facts.bower,
    installFlags: [],
    dropLockfile: false,
    dependencyPatches: {},
    buildCommand: 'build' in facts.scripts ? run('build') : null,
    startCommand,
    port: facts.listenPort,
  };
}

/** Environment for a service's own container. */
export function serviceEnv(kind: ServiceKind): Record<string, string> {
  return SERVICES[kind].serviceEnv;
}
