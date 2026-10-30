import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImportParser, languageFor } from '@necromancer/excavate';

let parser: ImportParser;
beforeAll(async () => {
  parser = await ImportParser.create();
});
afterAll(() => parser.dispose());

const specs = (source: string, lang: Parameters<ImportParser['parse']>[1] = 'javascript') =>
  parser.parse(source, lang).imports.map((i) => [i.kind, i.specifier]);

describe('ImportParser', () => {
  it('finds every static import form in JavaScript', () => {
    const src = `
      import a from './a';
      import * as b from "./b";
      import './side-effect';
      export { c } from './c';
      export * from './d';
      const e = require('e');
      const { f } = require(\`./f\`);
      import('./g').then(() => {});
    `;
    expect(specs(src)).toEqual([
      ['import', './a'],
      ['import', './b'],
      ['import', './side-effect'],
      ['export-from', './c'],
      ['export-from', './d'],
      ['require', 'e'],
      ['require', './f'],
      ['dynamic-import', './g'],
    ]);
  });

  it('ignores computed specifiers and plain exports', () => {
    const src = `
      const name = 'x';
      require(name);
      require('./a' + name);
      import(\`./\${name}\`);
      export const y = 1;
      foo.require('./not-a-require');
    `;
    expect(specs(src)).toEqual([]);
  });

  it('handles TypeScript-only forms', () => {
    const src = `
      import type { T } from './types';
      import fs = require('fs');
      export type { U } from './u';
      const x: Array<string> = [];
    `;
    expect(specs(src, 'typescript')).toEqual([
      ['import', './types'],
      ['import-equals', 'fs'],
      ['export-from', './u'],
    ]);
  });

  it('parses JSX in .js and .tsx files', () => {
    expect(specs(`import App from './App';\nrender(<App />);`)).toEqual([['import', './App']]);
    expect(specs(`import App from './App';\nconst el = <App<string> />;`, 'tsx')).toEqual([['import', './App']]);
  });

  it('reports line numbers and parse errors', () => {
    const result = parser.parse(`\n\nconst a = require('a');\nfunction (( {`, 'javascript');
    expect(result.imports[0]?.line).toBe(3);
    expect(result.parseErrors).toBeGreaterThan(0);
  });
});

describe('languageFor', () => {
  it('maps extensions and skips declaration files', () => {
    expect(languageFor('a/b.cjs')).toBe('javascript');
    expect(languageFor('a/b.mts')).toBe('typescript');
    expect(languageFor('a/b.tsx')).toBe('tsx');
    expect(languageFor('a/b.d.ts')).toBeNull();
    expect(languageFor('a/b.coffee')).toBeNull();
    expect(languageFor('Makefile')).toBeNull();
  });
});
