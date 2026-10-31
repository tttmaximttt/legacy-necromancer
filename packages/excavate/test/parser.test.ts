import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMounts, ImportParser, languageFor } from '@necromancer/excavate';

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

describe('route extraction', () => {
  it('finds Express, Restify, Koa-router and Hapi routes, and mounts', () => {
    const src = [
      "const api = require('./routes/api');",
      "import admin from './admin';",
      "app.get('/', home);",
      "router.post('/users/:id', auth, function (req, res) {});",
      "app.del('/old', h);",
      "app.route('/books').get(list).post(create);",
      "server.get({ path: '/health' }, h);",
      "router.get('user', '/u/:name', h);",
      "server.route([{ method: 'GET', path: '/hapi/{id}', handler }, { method: ['PUT', 'patch'], path: '/hapi', handler }]);",
      "app.use('/api', api);",
      "app.use('/admin', auth, admin);",
      "app.use('/inline', require('./inline'));",
      "app.use(express.static('public'));",
      "cache.get('/not-a-route');",
      "map.get(key, fallback);",
    ].join('\n');
    const parsed = parser.parse(src, 'javascript');
    expect(parsed.routes.map((r) => `${r.method} ${r.path} @${r.line}`)).toEqual([
      'GET / @3',
      'POST /users/:id @4',
      'DELETE /old @5',
      'POST /books @6',
      'GET /books @6',
      'GET /health @7',
      'GET /u/:name @8',
      'GET /hapi/{id} @9',
      'PUT /hapi @9',
      'PATCH /hapi @9',
    ]);
    expect(parsed.mounts).toEqual([
      { prefix: '/api', specifier: './routes/api', line: 10 },
      { prefix: '/admin', specifier: './admin', line: 11 },
      { prefix: '/inline', specifier: './inline', line: 12 },
    ]);
  });
});

describe('local routers', () => {
  it('applies the prefix a local router is mounted under to its routes and mounts', () => {
    const parsed = parser.parse(
      [
        "import tags from './tags';",
        'const api = Router()',
        '  .use(tags)',
        "  .get('/ping', h);",
        "export default Router().use('/api', api);",
      ].join('\n'),
      'typescript',
    );
    expect(parsed.routes).toEqual([{ method: 'GET', path: '/api/ping', line: 2 }]);
    expect(parsed.mounts).toEqual([{ prefix: '/api', specifier: './tags', line: 2 }]);
  });
});

describe('applyMounts', () => {
  it('prefixes routes with the paths their file is mounted under, through nested mounts', () => {
    const routes = applyMounts(
      new Map([
        ['app.js', [{ method: 'GET', path: '/', line: 3 }]],
        ['routes/api.js', [{ method: 'GET', path: '/status', line: 2 }]],
        ['routes/users.js', [{ method: 'GET', path: '/:id', line: 4 }, { method: 'POST', path: '/', line: 5 }]],
      ]),
      new Map([
        ['app.js', [{ prefix: '/api', specifier: './routes/api', line: 5, target: 'routes/api.js' }]],
        ['routes/api.js', [{ prefix: '/users/', specifier: './users', line: 1, target: 'routes/users.js' }]],
      ]),
    );
    expect(routes.map((r) => `${r.method} ${r.path} ${r.file}:${r.line}`)).toEqual([
      'GET / app.js:3',
      'GET /api/status routes/api.js:2',
      'GET /api/users/:id routes/users.js:4',
      'POST /api/users routes/users.js:5',
    ]);
  });
});
