import { describe, expect, it } from 'vitest';
import { ImportResolver, packageNameOf } from '@necromancer/excavate';
import type { ImportKind } from '@necromancer/core';

const files = [
  'package.json',
  'lib/index.js',
  'lib/ORM.js',
  'lib/Error.js',
  'lib/util/index.ts',
  'lib/data.json',
  'src/app.ts',
  'src/view.tsx',
  'packages/sub/package.json',
  'packages/sub/main/entry.js',
];
const resolver = new ImportResolver(files, { '': './lib/ORM', 'packages/sub': 'main/entry.js' });
const resolve = (from: string, specifier: string) =>
  resolver.resolve(from, { specifier, kind: 'require' as ImportKind, line: 1 });

describe('ImportResolver', () => {
  it('probes extensions and index files', () => {
    expect(resolve('lib/ORM.js', './Error')).toMatchObject({ type: 'internal', target: 'lib/Error.js' });
    expect(resolve('lib/ORM.js', './util')).toMatchObject({ type: 'internal', target: 'lib/util/index.ts' });
    expect(resolve('lib/ORM.js', './util/')).toMatchObject({ type: 'internal', target: 'lib/util/index.ts' });
    expect(resolve('src/app.ts', '../lib')).toMatchObject({ type: 'internal', target: 'lib/index.js' });
    expect(resolve('lib/ORM.js', './data.json')).toMatchObject({ type: 'internal', target: 'lib/data.json' });
  });

  it('maps TypeScript .js specifiers to their .ts/.tsx sources', () => {
    expect(resolve('src/app.ts', './view.js')).toMatchObject({ type: 'internal', target: 'src/view.tsx' });
  });

  it('follows package.json main for directory imports', () => {
    expect(resolve('test/integration/x.js', '../../')).toMatchObject({ type: 'internal', target: 'lib/ORM.js' });
    expect(resolve('packages/a.js', './sub')).toMatchObject({ type: 'internal', target: 'packages/sub/main/entry.js' });
  });

  it('flags imports that only resolve on case-insensitive filesystems', () => {
    expect(resolve('lib/ORM.js', './error')).toEqual(
      expect.objectContaining({ type: 'internal', target: 'lib/Error.js', caseMismatch: true }),
    );
    expect(resolve('lib/ORM.js', './Error')).not.toHaveProperty('caseMismatch');
  });

  it('classifies builtins, packages and misses', () => {
    expect(resolve('a.js', 'fs')).toMatchObject({ type: 'builtin', module: 'fs' });
    expect(resolve('a.js', 'node:path')).toMatchObject({ type: 'builtin', module: 'path' });
    expect(resolve('a.js', 'fs/promises')).toMatchObject({ type: 'builtin', module: 'fs' });
    expect(resolve('a.js', 'lodash/fp')).toMatchObject({ type: 'external', packageName: 'lodash' });
    expect(resolve('a.js', '@babel/core/lib/x')).toMatchObject({ type: 'external', packageName: '@babel/core' });
    expect(resolve('lib/ORM.js', './nope')).toMatchObject({ type: 'unresolved' });
    expect(resolve('lib/ORM.js', '../../../outside')).toMatchObject({ type: 'unresolved' });
  });
});

describe('packageNameOf', () => {
  it('handles scopes and loader prefixes', () => {
    expect(packageNameOf('react-dom/server')).toBe('react-dom');
    expect(packageNameOf('@scope/pkg')).toBe('@scope/pkg');
    expect(packageNameOf('@scope')).toBeNull();
    expect(packageNameOf('style!css!normalize.css')).toBe('normalize.css');
    expect(packageNameOf('raw-loader!./x')).toBeNull();
  });
});
