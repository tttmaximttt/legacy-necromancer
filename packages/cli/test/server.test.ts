import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReportStore, type ExhumeReport } from '@necromancer/core';
import { createUiServer } from '../src/server.js';

let base: string;
let close: () => void;

beforeAll(async () => {
  const store = new ReportStore(await mkdtemp(path.join(os.tmpdir(), 'necro-ui-store-')));
  await store.save('exhume', { repo: { source: 'https://github.com/a/b', commit: null } } as unknown as ExhumeReport);
  const dist = await mkdtemp(path.join(os.tmpdir(), 'necro-ui-dist-'));
  await mkdir(path.join(dist, 'assets'));
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>ui</title>');
  await writeFile(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
  const server = createUiServer(store, dist);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

describe('ui server', () => {
  it('lists and serves stored reports', async () => {
    const list = await (await fetch(`${base}/api/reports`)).json();
    expect(list).toEqual([expect.objectContaining({ slug: 'a__b', source: 'https://github.com/a/b', kinds: ['exhume'] })]);
    const one = (await (await fetch(`${base}/api/reports/a__b`)).json()) as { exhume: ExhumeReport };
    expect(one.exhume.repo.source).toBe('https://github.com/a/b');
    expect((await fetch(`${base}/api/reports/nope`)).status).toBe(404);
  });

  it('serves assets with an SPA fallback and never leaves the dist dir', async () => {
    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(await (await fetch(`${base}/some/route?repo=x`)).text()).toContain('<title>ui</title>');
    expect(await (await fetch(`${base}/..%2f..%2f..%2fetc%2fpasswd`)).text()).toContain('<title>ui</title>');
  });

  it('is read-only', async () => {
    expect((await fetch(`${base}/api/reports`, { method: 'POST' })).status).toBe(405);
  });
});
