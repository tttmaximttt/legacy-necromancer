import { describe, expect, it } from 'vitest';
import { shellArg } from '@necromancer/core';

describe('shellArg', () => {
  it('leaves plain words, paths and URLs alone', () => {
    for (const v of ['dresende/node-orm2', 'https://github.com/a/b.git', '/tmp/repo', './app', 'a~b']) expect(shellArg(v)).toBe(v);
  });

  it('quotes anything a shell would change, including a leading tilde', () => {
    expect(shellArg('~/code/app')).toBe(`'~/code/app'`);
    expect(shellArg('my repo')).toBe(`'my repo'`);
    expect(shellArg("it's")).toBe(`'it'\\''s'`);
    expect(shellArg('$(rm -rf /)')).toBe(`'$(rm -rf /)'`);
  });
});
