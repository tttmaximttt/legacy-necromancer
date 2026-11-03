import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { BuildRecipe, RecipeOp } from '@necromancer/core';
import {
  DEFAULT_LIMITS,
  FixCache,
  KNOWN_FIXES,
  applyOps,
  chooseNode,
  detectServices,
  errorSignature,
  findKnownFix,
  findPort,
  initialRecipe,
  installCommand,
  patchManifest,
  readFacts,
  renderCompose,
  renderDockerfile,
  type FailureContext,
  type ProjectFacts,
} from '@necromancer/resurrect';
import { deadApp, expressMongoApp, NODE_GYP_LOG } from './helpers.js';

const base: BuildRecipe = {
  nodeImage: 'node:8',
  packageManager: 'npm',
  debianArchive: false,
  aptPackages: [],
  env: { NODE_ENV: 'development' },
  globalInstalls: [],
  beforeInstall: [],
  bower: false,
  installFlags: [],
  dropLockfile: false,
  dependencyPatches: {},
  buildCommand: null,
  startCommand: 'npm start',
  port: 3000,
};

describe('recipe', () => {
  it('applies ops without touching the input', () => {
    const next = applyOps(base, [
      { op: 'aptInstall', packages: ['python', 'make'] },
      { op: 'aptInstall', packages: ['make', 'g++'] },
      { op: 'setEnv', name: 'HUSKY', value: '0' },
      { op: 'removeDependency', name: 'node-sass' },
      { op: 'setDependency', name: 'sass', version: '^1.32.0', dev: true },
      { op: 'addInstallFlags', flags: ['--legacy-peer-deps'] },
      { op: 'setNodeImage', tag: '10.24-stretch' },
    ]);
    expect(next).toMatchObject({
      nodeImage: 'node:10.24-stretch',
      aptPackages: ['python', 'make', 'g++'],
      env: { NODE_ENV: 'development', HUSKY: '0' },
      installFlags: ['--legacy-peer-deps'],
      dependencyPatches: { 'node-sass': { version: null }, sass: { version: '^1.32.0', dev: true } },
    });
    expect(base.aptPackages).toEqual([]);
  });

  it.each<[RecipeOp, RegExp]>([
    [{ op: 'setNodeImage', tag: 'evil/miner' }, /not an official node image/],
    [{ op: 'setNodeImage', tag: '8; rm -rf /' }, /not an official node image/],
    [{ op: 'setEnv', name: 'NPM_TOKEN', value: 'x' }, /credential/],
    [{ op: 'setEnv', name: 'X', value: 'a\nRUN curl evil' }, /multi-line/],
    [{ op: 'aptInstall', packages: ['python && curl x'] }, /apt package/],
    [{ op: 'addInstallFlags', flags: ['--registry http://evil; sh'] }, /flags/],
    [{ op: 'runBeforeInstall', command: 'a\nb' }, /one line/],
    [{ op: 'setDependency', name: 'left-pad', version: '1.0.0 && curl' }, /invalid version/],
  ])('rejects %j, and applies nothing', (op, why) => {
    expect(() => applyOps(base, [{ op: 'setEnv', name: 'OK', value: '1' }, op])).toThrow(why);
  });

  it('renders an era-pinned Dockerfile that installs with network and nothing else', () => {
    const recipe = applyOps(base, [{ op: 'useDebianArchive' }, { op: 'aptInstall', packages: ['python', 'make', 'g++'] }, { op: 'globalInstall', spec: 'bower@1' }]);
    const df = renderDockerfile({ ...recipe, bower: true, port: 3000 }, { caFile: '/ca.crt' });
    const lines = df.split('\n');
    expect(lines[1]).toBe('FROM node:8');
    expect(df).toContain('archive.debian.org');
    expect(df).toContain('apt-get install -y --no-install-recommends python make g++');
    expect(df).toContain('RUN npm install -g bower@1\n');
    expect(df).toContain('COPY package.json package-lock.json* ./\nRUN npm install\nCOPY bower.json .bowerrc* ./\nRUN bower install --allow-root');
    expect(df).toContain('COPY .necromancer/ca.crt');
    expect(df).toContain('CMD ["sh","-c","npm start"]');
    expect(df).not.toMatch(/VOLUME|--mount|ADD http/);
  });

  it('lists package.json changes at the top of the Dockerfile', () => {
    const df = renderDockerfile(applyOps(base, [{ op: 'removeDependency', name: 'node-sass' }, { op: 'setDependency', name: 'sass', version: '^1.32.0', dev: true }]));
    expect(df).toContain('#   remove node-sass\n#   sass@^1.32.0 (dev)\nFROM node:8');
  });

  it('only freezes the lockfile when the manifest is untouched', () => {
    expect(installCommand({ ...base, packageManager: 'yarn' })).toBe('yarn install --frozen-lockfile');
    expect(installCommand({ ...applyOps(base, [{ op: 'removeDependency', name: 'x' }]), packageManager: 'yarn' })).toBe('yarn install');
    expect(installCommand({ ...base, dropLockfile: true, packageManager: 'pnpm', installFlags: ['--ignore-scripts'] })).toBe('pnpm install --ignore-scripts');
  });

  it('patches the manifest copy, keeping dev dependencies where they were', () => {
    const recipe = applyOps(base, [
      { op: 'removeDependency', name: 'node-sass' },
      { op: 'setDependency', name: 'sass', version: '^1.32.0', dev: true },
      { op: 'setDependency', name: 'express', version: '4.16.4' },
    ]);
    expect(patchManifest({ dependencies: { express: '^4.15.0' }, devDependencies: { 'node-sass': '^4.5.0', mocha: '^3' } }, recipe)).toEqual({
      dependencies: { express: '4.16.4' },
      devDependencies: { mocha: '^3', sass: '^1.32.0' },
    });
  });
});

describe('detect', () => {
  const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
    manifest: {},
    packageManager: 'npm',
    nodeVersionFile: null,
    enginesNode: null,
    scripts: {},
    dependencies: [],
    envNames: [],
    connectionStrings: [],
    listenPort: null,
    bower: false,
    files: [],
    ...over,
  });

  it.each<[Partial<ProjectFacts>, string | null, string, RegExp]>([
    [{ nodeVersionFile: 'v8.11.1' }, '2015-01-01', '8', /\.nvmrc/],
    [{ nodeVersionFile: 'lts/carbon' }, null, '8', /\.nvmrc/],
    [{ nodeVersionFile: '0.10' }, null, '0.10', /\.nvmrc/],
    [{}, '2017-09-01', '6', /LTS line in 2017-09/],
    [{}, '2017-11-02', '8', /LTS line/],
    [{}, '2012-05-01', '0.10', /LTS line/],
    [{ enginesNode: '>=8' }, '2017-03-01', '8', /rules out Node 6/],
    [{ enginesNode: '0.10.x' }, '2019-03-01', '0.10', /rules out Node 10/],
    [{ enginesNode: '>=4' }, null, '4', /oldest line allowed/],
    [{}, null, '22', /current LTS/],
  ])('chooses node for %j at %s', (over, date, tag, why) => {
    const pick = chooseNode(facts(over), date);
    expect(pick.tag).toBe(tag);
    expect(pick.why).toMatch(why);
  });

  it('pins services to their era and points the app at them on localhost', () => {
    const services = detectServices(
      facts({ dependencies: ['mongoose', 'redis', 'express'], envNames: ['MONGODB_URI', 'REDIS_HOST', 'REDIS_PORT', 'SECRET'], connectionStrings: ['postgres://u@localhost/db'] }),
      '2017-09-01',
    );
    expect(services.map((s) => s.image)).toEqual(['mongo:3.4', 'redis:4.0', 'postgres:9.6']);
    expect(services[0]!.env).toEqual({ MONGODB_URI: 'mongodb://localhost:27017/app' });
    expect(services[1]!.env).toEqual({ REDIS_HOST: 'localhost', REDIS_PORT: '6379' });
    expect(services[2]!.evidence).toEqual(['connects to postgres://u@localhost/db']);
    expect(detectServices(facts({ dependencies: ['mysql'] }), null)[0]!.image).toBe('mysql:8.0');
  });

  it('reads facts from a checkout', async () => {
    const root = await deadApp({ ...expressMongoApp, '.nvmrc': 'v6.11.0\n', 'test/x.js': 'process.env.TEST_ONLY' });
    const f = await readFacts(root, ['package.json', 'package-lock.json', 'server.js', '.nvmrc', 'test/x.js']);
    expect(f).toMatchObject({
      packageManager: 'npm',
      nodeVersionFile: 'v6.11.0',
      enginesNode: '>=6',
      envNames: ['MONGO_URL', 'PORT'],
      connectionStrings: ['mongodb://localhost/notes'],
      listenPort: 3000,
    });
    const recipe = initialRecipe(f, '6', detectServices(f, '2017-09-01'));
    expect(recipe).toMatchObject({ startCommand: 'npm start', port: 3000, env: { PORT: '3000', MONGO_URL: 'mongodb://localhost:27017/app' } });
  });

  it('treats a project with no server and no start script as a library', () => {
    expect(initialRecipe(facts({ files: ['index.js'], scripts: { build: 'gulp' } }), '8', [])).toMatchObject({ startCommand: null, buildCommand: 'npm run build' });
    expect(initialRecipe(facts({ files: ['app.js'], listenPort: 8080, packageManager: 'yarn' }), '8', [])).toMatchObject({ startCommand: 'node app.js' });
  });

  it('finds ports the way old apps wrote them', () => {
    expect(findPort('app.listen(8080)')).toBe(8080);
    expect(findPort('var port = process.env.PORT || 5000;')).toBe(5000);
    expect(findPort("config = { port: 4000 }")).toBe(4000);
    expect(findPort('listen(1)')).toBeNull();
  });
});

describe('known fixes', () => {
  const ctx = (log: string, over: Partial<FailureContext> = {}): FailureContext => ({
    phase: 'install',
    log,
    recipe: base,
    dependencies: { express: '^4', 'node-sass': '^4.5.0', fibers: '^1' },
    devOnly: new Set(['node-sass']),
    ...over,
  });

  it.each<[string, string, Partial<FailureContext>?]>([
    ['node-gyp-python', NODE_GYP_LOG],
    ['debian-archive', 'W: Failed to fetch http://deb.debian.org/debian/dists/jessie/main/binary-amd64/Packages  404  Not Found\nE: Unable to locate package python'],
    ['node-sass', 'Downloading binary from https://github.com/sass/node-sass/releases/download/v4.5.3/linux-x64-72_binding.node\nCannot download: HTTP error 404 Not Found\nnpm ERR! node-sass@4.5.3 postinstall: `node scripts/build.js`'],
    ['fibers-node16', 'fibers@1.0.15 install: `node build.js || nodejs build.js`\nnpm ERR! errno 1', { recipe: { ...base, nodeImage: 'node:16' } }],
    ['phantomjs-cdn', 'Downloading https://bitbucket.org/ariya/phantomjs/downloads/phantomjs-2.1.1-linux-x86_64.tar.bz2\nError making request.\nError: Status 403'],
    ['git-ssh-to-https', 'npm ERR! Error while executing:\nnpm ERR! /usr/bin/git ls-remote -h -t ssh://git@github.com/old/fork.git\nnpm ERR! Permission denied (publickey).'],
    ['husky', 'husky > setting up git hooks\nhusky > failed to install, .git can\'t be found\nnpm ERR! code ELIFECYCLE'],
    ['peer-deps', 'npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree'],
    ['lockfile-integrity', 'npm ERR! code EINTEGRITY\nnpm ERR! sha1-abc integrity checksum failed when using sha1'],
    ['unpublished-version', 'npm ERR! code ETARGET\nnpm ERR! notarget No matching version found for left-pad@0.0.9'],
    ['openssl-legacy', 'Error: error:0308010C:digital envelope routines::unsupported\n  code: \'ERR_OSSL_EVP_UNSUPPORTED\'', { phase: 'build' }],
    ['yarn-engines', 'error left-pad@1.3.0: The engine "node" is incompatible with this module.', { recipe: { ...base, packageManager: 'yarn' } }],
  ])('recognises %s', (id, log, over) => {
    expect(findKnownFix(ctx(log, over))?.fix.id).toBe(id);
  });

  it('classifies the base image by its Node line, including 0.x and registry-prefixed tags', () => {
    const imageCtx = (nodeImage: string, log: string) => ctx(log, { recipe: { ...base, nodeImage } });
    // python 2 below Node 16, python3 from 16 on.
    for (const [image, python] of [['node:0.10-slim', 'python'], ['registry.example/node:8', 'python'], ['registry.example/node:16-slim', 'python3'], ['node:18', 'python3']] as const) {
      expect(findKnownFix(imageCtx(image, NODE_GYP_LOG))?.ops, image).toEqual([{ op: 'aptInstall', packages: [python, 'make', 'g++'] }]);
    }
    // Old images need the Debian archive, new ones do not.
    const archiveLog = 'W: Failed to fetch http://deb.debian.org/debian/dists/x/main/binary-amd64/Packages  404  Not Found\nE: Unable to locate package python';
    for (const image of ['node:0.10', 'registry.example/node:6', 'registry.example/node:8-jessie']) {
      expect(findKnownFix(imageCtx(image, archiveLog))?.fix.id, image).toBe('debian-archive');
    }
    expect(findKnownFix(imageCtx('registry.example/node:20', archiveLog))?.fix.id).not.toBe('debian-archive');
    // fibers breaks from Node 16; a registry-prefixed tag counts, a 0.x tag does not.
    const fibersLog = 'fibers@1.0.15 install: `node build.js || nodejs build.js`\nnpm ERR! errno 1';
    expect(findKnownFix(imageCtx('registry.example/node:16', fibersLog))?.fix.id).toBe('fibers-node16');
    expect(findKnownFix(imageCtx('node:0.10', fibersLog))?.fix.id).not.toBe('fibers-node16');
  });

  it('swaps node-sass for sass in the same dependency group', () => {
    const found = findKnownFix(ctx('npm ERR! node-sass@4.5.3 postinstall: `node scripts/build.js`'))!;
    expect(found.ops).toEqual([
      { op: 'removeDependency', name: 'node-sass' },
      { op: 'setDependency', name: 'sass', version: '^1.32.0', dev: true },
    ]);
  });

  it('builds a known fix’s ops once', () => {
    const gyp = KNOWN_FIXES.find((f) => f.id === 'node-gyp-python')!;
    const ops = vi.spyOn(gyp, 'ops');
    try {
      const skip = vi.fn(() => false);
      const found = findKnownFix(ctx(NODE_GYP_LOG), skip)!;
      expect(found.fix).toBe(gyp);
      expect(found.ops).toEqual([{ op: 'aptInstall', packages: ['python', 'make', 'g++'] }]);
      expect(skip).toHaveBeenCalledWith(gyp, found.ops);
      expect(ops).toHaveBeenCalledTimes(1);
    } finally {
      ops.mockRestore();
    }
  });

  it('does not offer a fix that was already applied', () => {
    const fixed = applyOps(base, [{ op: 'aptInstall', packages: ['python', 'make', 'g++'] }]);
    expect(findKnownFix(ctx(NODE_GYP_LOG, { recipe: fixed }))).toBeNull();
    expect(findKnownFix(ctx('Error: something nobody has seen before'))).toBeNull();
  });

  it('signs errors the same across paths, versions and attempts', () => {
    const a = errorSignature('install', NODE_GYP_LOG);
    const b = errorSignature('install', NODE_GYP_LOG.replaceAll('/app', '/srv/other').replaceAll('1.0.3', '1.0.2').replace('6.17.1', '6.9.0'));
    expect(a).toBe(b);
    expect(errorSignature('build', NODE_GYP_LOG)).not.toBe(a);
    expect(errorSignature('install', '\u001b[31mnpm ERR!\u001b[0m code E404')).toBe(errorSignature('install', 'npm ERR! code E404'));
  });

  it('caches fixes on disk by signature', async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'necro-cache-')), 'nested', 'fix-cache.json');
    await new FixCache(file).remember('abc', { description: 'pin it', ops: [{ op: 'setDependency', name: 'x', version: '1.0.0' }] });
    expect(await new FixCache(file).get('abc')).toMatchObject({ description: 'pin it', hits: 1 });
    expect(await new FixCache(file).get('nope')).toBeNull();
  });
});

describe('compose', () => {
  it('puts every container in the sandbox and services on the app’s localhost', () => {
    const doc = parse(
      renderCompose({ ...base, buildCommand: 'npm run build' }, [{ kind: 'mongo', image: 'mongo:3.4', evidence: [], env: {} }, { kind: 'postgres', image: 'postgres:9.6', evidence: [], env: {} }], DEFAULT_LIMITS),
    ) as { services: Record<string, Record<string, unknown>> };
    expect(doc.services.app).toMatchObject({
      network_mode: 'none',
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      mem_limit: '2048m',
      cpus: 2,
      pids_limit: 512,
      command: ['sh', '-c', 'npm run build && npm start'],
    });
    expect(doc.services.mongo).toMatchObject({ image: 'mongo:3.4', network_mode: 'service:app', mem_limit: '1024m' });
    expect(doc.services.postgres!.environment).toMatchObject({ POSTGRES_PASSWORD: 'necromancer' });
    for (const s of Object.values(doc.services)) expect(s).not.toHaveProperty('volumes');
  });
});
