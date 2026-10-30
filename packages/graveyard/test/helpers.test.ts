import { describe, expect, it } from 'vitest';
import { githubSlug, nodeRelease, parseNpmLock, parseYarnLock, pool, replacementFromMessage, suggestReplacement } from '@necromancer/graveyard';

describe('githubSlug', () => {
  it.each([
    ['git+https://github.com/request/request.git', 'request/request'],
    ['git://github.com/substack/node-hat.git', 'substack/node-hat'],
    ['git@github.com:lodash/lodash.git', 'lodash/lodash'],
    ['https://github.com/a/b/tree/master/packages/c', 'a/b'],
    ['github:a/b', 'a/b'],
    ['a/b', 'a/b'],
    ['https://gitlab.com/a/b', null],
    [null, null],
  ])('%s → %s', (url, slug) => expect(githubSlug(url)).toBe(slug));
});

describe('lockfiles', () => {
  it('reads top-level versions from npm lockfile v1 and v3', () => {
    expect(parseNpmLock(JSON.stringify({ dependencies: { a: { version: '1.0.0' } } }))).toEqual(new Map([['a', '1.0.0']]));
    expect(
      parseNpmLock(
        JSON.stringify({
          lockfileVersion: 3,
          packages: { '': {}, 'node_modules/a': { version: '1.0.0' }, 'node_modules/@s/b': { version: '2.0.0' }, 'node_modules/a/node_modules/c': { version: '3.0.0' } },
        }),
      ),
    ).toEqual(new Map([['a', '1.0.0'], ['@s/b', '2.0.0']]));
    expect(parseNpmLock('not json')).toEqual(new Map());
  });

  it('reads yarn.lock v1', () => {
    const lock = `# yarn lockfile v1


"@babel/core@^7.0.0", "@babel/core@^7.1.0":
  version "7.1.2"
  resolved "https://registry.yarnpkg.com/@babel/core/-/core-7.1.2.tgz"

lodash@^4.17.4:
  version "4.17.10"
`;
    expect(parseYarnLock(lock)).toEqual(new Map([['@babel/core', '7.1.2'], ['lodash', '4.17.10']]));
  });
});

describe('replacements', () => {
  it('extracts successors from deprecation notices', () => {
    expect(replacementFromMessage('Please use @new/thing instead', 'old')).toBe('@new/thing');
    expect(replacementFromMessage('This package has been renamed to coffeescript.', 'coffee-script')).toBe('coffeescript');
    expect(replacementFromMessage('switch to `undici`', 'x')).toBe('undici');
    expect(replacementFromMessage('Use the latest version', 'x')).toBeNull();
    expect(replacementFromMessage('no longer supported', 'x')).toBeNull();
  });

  it('only suggests replacing healthy-but-old packages when they are actually dying', () => {
    expect(suggestReplacement('moment', null, false)).toBeNull();
    expect(suggestReplacement('moment', null, true)).toMatchObject({ source: 'known' });
    expect(suggestReplacement('node-sass', null, false)).toMatchObject({ name: 'sass' });
  });
});

describe('nodeRelease', () => {
  it('maps engines ranges to the Node line they target', () => {
    expect(nodeRelease('0.10.x')).toEqual({ range: '0.10.x', release: '0.10', released: '2013-03-11' });
    expect(nodeRelease('>=4')).toMatchObject({ release: '4' });
    expect(nodeRelease('>= 8.9.0')).toMatchObject({ release: '8' });
    expect(nodeRelease('nonsense')).toBeNull();
  });
});

describe('pool', () => {
  it('keeps order and limits concurrency', async () => {
    let active = 0;
    let peak = 0;
    const out = await pool([5, 1, 3, 2, 4], 2, async (n) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
  });
});
