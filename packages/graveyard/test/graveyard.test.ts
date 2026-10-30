import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DependencySummary } from '@necromancer/core';
import {
  collectDependencies,
  digGraveyard,
  GitHubClient,
  NpmAdvisories,
  NpmRegistry,
  OsvAdvisories,
  registrySpec,
  type Fetch,
} from '@necromancer/graveyard';

/** A tiny fake of the endpoints we call. Unknown URLs 404. */
function fakeFetch(routes: Record<string, unknown | ((body: unknown) => unknown)>, log: string[] = []): Fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    log.push(`${init?.method ?? 'GET'} ${url}`);
    const route = routes[url];
    if (route === undefined) return new Response('not found', { status: 404 });
    if (route instanceof Response) return route;
    const body = typeof route === 'function' ? route(init?.body ? JSON.parse(String(init.body)) : undefined) : route;
    return Response.json(body);
  }) as Fetch;
}

const packument = (name: string, versions: Record<string, { time: string; deprecated?: string }>, extra: Record<string, unknown> = {}) => ({
  name,
  'dist-tags': { latest: Object.keys(versions).at(-1) },
  versions: Object.fromEntries(Object.entries(versions).map(([v, m]) => [v, m.deprecated ? { deprecated: m.deprecated } : {}])),
  time: { created: '2000-01-01T00:00:00Z', modified: '2025-01-01T00:00:00Z', ...Object.fromEntries(Object.entries(versions).map(([v, m]) => [v, m.time])) },
  ...extra,
});

const REG = 'https://registry.npmjs.org';
const NOW = new Date('2026-10-30T00:00:00Z');

const routes = {
  [`${REG}/request`]: packument(
    'request',
    { '2.40.0': { time: '2014-08-01T00:00:00Z' }, '2.88.2': { time: '2020-02-11T00:00:00Z', deprecated: 'request has been deprecated, see https://github.com/request/request/issues/3142' } },
    { repository: { url: 'git+https://github.com/request/request.git' } },
  ),
  [`${REG}/lodash`]: packument('lodash', {
    '3.10.1': { time: '2015-08-01T00:00:00Z' },
    '4.17.4': { time: '2016-12-31T00:00:00Z' },
    '4.17.21': { time: '2021-02-20T00:00:00Z' },
    '5.0.0': { time: '2026-01-01T00:00:00Z' },
  }),
  [`${REG}/express`]: packument('express', { '3.0.0': { time: '2012-10-23T00:00:00Z' }, '5.1.0': { time: '2026-03-31T00:00:00Z' } }),
  [`${REG}/hat`]: packument('hat', { '0.0.3': { time: '2011-08-06T00:00:00Z' } }, { repository: 'git://github.com/substack/node-hat.git' }),
  [`${REG}/old-thing`]: packument(
    'old-thing',
    { '1.0.0': { time: '2013-01-01T00:00:00Z', deprecated: 'Please use @new/thing instead' } },
  ),
  [`${REG}/-/npm/v1/security/advisories/bulk`]: (body: Record<string, string[]>) => ({
    ...(body.lodash?.[0] === '4.17.4' && {
      lodash: [{ id: 1, title: 'Prototype Pollution in lodash', severity: 'critical', url: 'https://github.com/advisories/GHSA-p6mc-m468-83gw', vulnerable_versions: '<4.17.19' }],
    }),
  }),
  'https://api.github.com/repos/substack/node-hat': { archived: true, pushed_at: '2011-08-06T00:00:00Z' },
  'https://api.github.com/repos/request/request': { archived: true, pushed_at: '2020-02-11T00:00:00Z' },
};

const manifests: DependencySummary[] = [
  {
    manifest: 'package.json',
    name: 'app',
    engines: { node: '>=0.10' },
    dependencies: { request: '~2.40.0', lodash: '^4.17.0', express: '3.x', hat: '0.0.3', 'old-thing': '^1.0.0', ghost: '^1.0.0', mine: 'github:me/mine', local: 'file:../local' },
    devDependencies: { lodash: '^4.0.0' },
  },
];

async function dig(fetch: Fetch, opts: { lock?: object; authed?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'necro-gy-'));
  const files = ['package.json'];
  if (opts.lock) {
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(opts.lock));
    files.push('package-lock.json');
  }
  return digGraveyard(
    {
      source: 'test',
      commit: null,
      root,
      files,
      manifests,
      history: { commits: 10, authors: 2, firstCommit: '2013-05-01T00:00:00Z', lastCommit: '2017-03-01T00:00:00Z' },
      now: NOW,
    },
    { registry: new NpmRegistry(fetch), advisories: new NpmAdvisories(fetch), github: new GitHubClient(fetch, opts.authed ? 't' : undefined), githubAuthenticated: !!opts.authed },
  );
}

describe('digGraveyard', () => {
  it('carves a tombstone per registry dependency', async () => {
    const report = await dig(fakeFetch(routes), { lock: { lockfileVersion: 1, dependencies: { lodash: { version: '4.17.4' } } } });
    const t = Object.fromEntries(report.tombstones.map((x) => [x.name, x]));

    expect(report.nonRegistry).toEqual([
      { name: 'mine', spec: 'github:me/mine' },
      { name: 'local', spec: 'file:../local' },
    ]);
    expect(report.summary).toMatchObject({ total: 6, dead: 4, dying: 0, ailing: 2, vulnerable: 1 });

    // Deprecated at latest, archived, and successor from the curated table.
    expect(t.request).toMatchObject({ status: 'dead', resolved: '2.40.0', resolvedFrom: 'era', replacement: { source: 'known' } });
    expect(t.request!.causes.map((c) => c.kind)).toEqual(['deprecated', 'archived', 'abandoned']);

    // Lockfile wins over ranges; advisories apply to the locked version.
    expect(t.lodash).toMatchObject({ status: 'ailing', resolved: '4.17.4', resolvedFrom: 'lockfile', dev: false, latest: '5.0.0', majorsBehind: 1 });
    expect(t.lodash!.advisories).toEqual([expect.objectContaining({ id: 'GHSA-p6mc-m468-83gw', severity: 'critical' })]);
    expect(t.lodash!.epitaph).toBe('lodash@4.17.4: 1 advisory, worst critical.');

    // "era": the newest 3.x that existed when the project died, not today's.
    expect(t.express).toMatchObject({ resolved: '3.0.0', resolvedFrom: 'era', majorsBehind: 2, status: 'ailing' });

    expect(t.hat).toMatchObject({ status: 'dead', replacement: { name: 'crypto.randomUUID()' } });
    expect(t.hat!.causes.map((c) => c.kind)).toEqual(['archived', 'abandoned']);

    expect(t['old-thing']).toMatchObject({ status: 'dead', replacement: { name: '@new/thing', source: 'deprecation-message' } });
    expect(t.ghost).toMatchObject({ status: 'dead', causes: [{ kind: 'missing' }] });

    expect(report.sources).toEqual({ registry: 'ok', advisories: 'ok', advisoryProvider: 'npm', github: 'ok' });
  });

  it('dates the remains', async () => {
    const { era } = await dig(fakeFetch(routes));
    expect(era).toMatchObject({
      born: '2013-05-01T00:00:00Z',
      died: '2017-03-01T00:00:00Z',
      estimate: '2017-03',
      confidence: 'high',
      node: { range: '>=0.10', release: '0.10', released: '2013-03-11' },
      dependencyFloor: { package: 'request', version: '2.40.0', date: '2014-08-01T00:00:00Z' },
    });
    expect(era.summary).toBe('Lived 2013–2017; manifest written no earlier than 2014-08 (request@2.40.0); targets Node 0.10 (2013).');
  });

  it('spends unauthenticated GitHub calls only on quiet packages', async () => {
    const log: string[] = [];
    const report = await dig(fakeFetch(routes, log));
    // request (2020) and hat (2011) are quiet; nothing else has a GitHub repo.
    expect(log.filter((l) => l.includes('api.github.com')).sort()).toEqual([
      'GET https://api.github.com/repos/request/request',
      'GET https://api.github.com/repos/substack/node-hat',
    ]);
    expect(report.warnings[0]).toMatch(/no GITHUB_TOKEN/);
  });

  it('reports failed sources instead of pretending everything is fine', async () => {
    const broken = { ...routes, [`${REG}/-/npm/v1/security/advisories/bulk`]: new Response('nope', { status: 503 }) };
    delete (broken as Record<string, unknown>)['https://api.github.com/repos/request/request'];
    (broken as Record<string, unknown>)['https://api.github.com/repos/substack/node-hat'] = new Response('rate limited', { status: 403 });
    (broken as Record<string, unknown>)['https://api.github.com/repos/request/request'] = new Response('rate limited', { status: 403 });
    const report = await dig(fakeFetch(broken));
    expect(report.sources).toMatchObject({ advisories: 'failed', github: 'failed' });
    expect(report.warnings.join('\n')).toMatch(/advisory lookup failed: 503/);
    expect(report.tombstones.every((t) => t.advisories.length === 0)).toBe(true);
  });
});

describe('collectDependencies / registrySpec', () => {
  it('dedupes across manifests, preferring prod over dev and skipping workspace siblings', () => {
    const { deps } = collectDependencies([
      { manifest: 'packages/a/package.json', name: 'a', engines: {}, dependencies: { b: 'workspace:*', x: '^1' }, devDependencies: {} },
      { manifest: 'package.json', name: 'root', engines: {}, dependencies: {}, devDependencies: { x: '^1', y: '^2' } },
      { manifest: 'packages/b/package.json', name: 'b', engines: {}, dependencies: {}, devDependencies: {} },
    ]);
    expect(deps.map((d) => [d.name, d.dev, d.manifestDir])).toEqual([
      ['x', false, ''],
      ['y', true, ''],
    ]);
  });

  it.each([
    ['^1.2.3', { name: 'p', range: '^1.2.3' }],
    ['latest', { name: 'p', range: '*' }],
    ['', { name: 'p', range: '*' }],
    ['npm:@scope/real@^2', { name: '@scope/real', range: '^2' }],
    ['>= 0.2.0 < 0.3', { name: 'p', range: '>= 0.2.0 < 0.3' }],
    ['git+https://github.com/a/b.git', null],
    ['user/repo#v1', null],
    ['file:../x', null],
    ['https://example.com/x.tgz', null],
  ])('%s', (spec, expected) => {
    expect(registrySpec('p', spec)).toEqual(expected);
  });
});

describe('OsvAdvisories', () => {
  it('batches queries and fetches details per vulnerability', async () => {
    const fetch = fakeFetch({
      'https://api.osv.dev/v1/querybatch': (body: { queries: Array<{ package: { name: string } }> }) => ({
        results: body.queries.map((q) => (q.package.name === 'lodash' ? { vulns: [{ id: 'GHSA-p6mc-m468-83gw' }] } : {})),
      }),
      'https://api.osv.dev/v1/vulns/GHSA-p6mc-m468-83gw': {
        id: 'GHSA-p6mc-m468-83gw',
        summary: 'Prototype Pollution in lodash',
        aliases: ['CVE-2020-8203'],
        database_specific: { severity: 'HIGH' },
        references: [{ type: 'ADVISORY', url: 'https://nvd.nist.gov/vuln/detail/CVE-2020-8203' }],
      },
    });
    const result = await new OsvAdvisories(fetch).lookup([
      { name: 'lodash', version: '4.17.4' },
      { name: 'left-pad', version: '1.0.0' },
    ]);
    expect(result.get('lodash@4.17.4')).toEqual([
      { id: 'GHSA-p6mc-m468-83gw', title: 'Prototype Pollution in lodash', severity: 'high', url: 'https://nvd.nist.gov/vuln/detail/CVE-2020-8203', vulnerableVersions: null },
    ]);
    expect(result.get('left-pad@1.0.0')).toEqual([]);
  });
});
