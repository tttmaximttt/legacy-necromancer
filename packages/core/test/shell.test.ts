import { describe, expect, it } from 'vitest';
import { shellArg, shellQuote } from '@necromancer/core';

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

  it('quotes a leading = (zsh expands =word) or % (a job spec), but not one later on', () => {
    expect(shellArg('=node')).toBe(`'=node'`);
    expect(shellArg('%1')).toBe(`'%1'`);
    expect(shellArg('a=b%c')).toBe('a=b%c');
  });

  it('prefixes a path starting with a dash, so it is not read as an option', () => {
    expect(shellArg('-app')).toBe('./-app');
    expect(shellArg('--help')).toBe('./--help');
    expect(shellArg("-my app")).toBe(`'./-my app'`);
  });
});

describe('shellQuote', () => {
  it('always single-quotes, as the text is, even with a leading dash', () => {
    expect(shellQuote('stub it')).toBe(`'stub it'`);
    expect(shellQuote('--legacy-peer-deps')).toBe(`'--legacy-peer-deps'`);
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});
