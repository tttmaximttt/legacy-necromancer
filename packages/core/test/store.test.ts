import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReportStore, slugFor, type ExhumeReport } from '@necromancer/core';

describe('slugFor', () => {
  it.each([
    ['https://github.com/tttmaximttt/node-orm2', 'tttmaximttt__node-orm2'],
    ['https://github.com/tttmaximttt/node-orm2.git', 'tttmaximttt__node-orm2'],
    ['git@github.com:a/b.git', 'a__b'],
    ['/home/me/old project/', 'old_project'],
    ['C:\\code\\legacy', 'legacy'],
    ['../..', '_'],
  ])('%s → %s', (source, slug) => expect(slugFor(source)).toBe(slug));
});

describe('ReportStore', () => {
  it('saves, lists newest first, and loads reports', async () => {
    const store = new ReportStore(await mkdtemp(path.join(os.tmpdir(), 'necro-store-')));
    expect(await store.list()).toEqual([]);

    const report = (source: string) => ({ repo: { source, commit: null } }) as unknown as ExhumeReport;
    await store.save('exhume', report('https://github.com/a/one'));
    await new Promise((r) => setTimeout(r, 20));
    const file = await store.save('graveyard', report('https://github.com/a/two') as never);
    expect(file).toBe(path.join(store.dir, 'a__two', 'graveyard.json'));

    const list = await store.list();
    expect(list.map((r) => [r.slug, r.source, r.kinds])).toEqual([
      ['a__two', 'https://github.com/a/two', ['graveyard']],
      ['a__one', 'https://github.com/a/one', ['exhume']],
    ]);
    expect(await store.load('a__one')).toEqual({ exhume: report('https://github.com/a/one'), graveyard: null, interview: null, resurrect: null, witness: null });
  });

  it('refuses slugs that could escape the store and ignores stray directories', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'necro-store-'));
    await mkdir(path.join(dir, 'empty'));
    await writeFile(path.join(dir, 'stray.txt'), 'x');
    const store = new ReportStore(dir);
    expect(await store.list()).toEqual([]);
    expect(await store.load('../etc')).toBeNull();
    expect(await store.load('missing')).toBeNull();
  });
});
