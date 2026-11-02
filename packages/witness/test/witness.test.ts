import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HttpRoute, WitnessReport } from '@necromancer/core';
import { ScriptedModel } from '@necromancer/llm';
import { resurrect } from '@necromancer/resurrect';
import {
  blank,
  compareWitness,
  defaultCases,
  differingPaths,
  fillPath,
  generateCases,
  normalizeBody,
  normalizeHeaders,
  normalizeJson,
  normalizeText,
  parseRunnerOutput,
  RUNNER,
  runnerEnv,
  testSummary,
  witness,
} from '@necromancer/witness';
import { deadApp, FakeSandbox, type ExecHandler } from '../../resurrect/test/helpers.js';

const run = promisify(execFile);

const notesApp = {
  'package.json': JSON.stringify({
    name: 'dead-notes',
    main: 'server.js',
    scripts: { start: 'node server.js', test: 'mocha' },
    dependencies: { express: '^4.15.0' },
  }),
  'server.js': [
    "var express = require('express');",
    'var app = express();',
    "var notes = require('./notes');",
    "app.use('/notes', notes);",
    "app.get('/lucky', function (req, res) { res.json({ n: Math.random() }); });",
    'app.listen(process.env.PORT || 3000);',
    '',
  ].join('\n'),
  'notes.js': [
    "var router = require('express').Router();",
    "router.post('/', function (req, res) { res.status(201).json({ text: req.body.text }); });",
    "router.get('/:id', function (req, res) { res.status(404).end(); });",
    'module.exports = router;',
    '',
  ].join('\n'),
};

/** The app behind the fake sandbox: what the resurrected container would answer. */
let created = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.setHeader('date', new Date().toUTCString());
    res.setHeader('x-response-time', `${Math.random()}ms`);
    if (req.method === 'POST' && req.url === '/notes') {
      const text = body ? (JSON.parse(body) as { text?: string }).text : undefined;
      if (!text) return void res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"text is required"}');
      res.writeHead(201, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': ['sid=abc123; HttpOnly'] });
      return void res.end(JSON.stringify({ _id: `59a8f0c2e4b0a1b2c3d4e5f${created++ % 10}`, text, createdAt: new Date().toISOString() }));
    }
    if (req.url === '/lucky') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ n: Math.random(), ok: true }));
    res.writeHead(404).end('Not Found');
  });
});
let port = 0;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());

/** Runs the real request runner on this machine, pointed at the test server instead of the container's port. */
const realRunner: ExecHandler = async (command, env) => {
  if (command[0] !== 'node') return { ok: true, log: '  3 passing (12ms)\n  1 pending\n', durationMs: 5 };
  const { stdout } = await run(process.execPath, ['-e', RUNNER], { env: { ...process.env, ...env, WITNESS_PORT: String(port) } });
  return { ok: true, log: stdout, durationMs: 5 };
};

async function revived() {
  const root = await deadApp(notesApp);
  const report = await resurrect(root, { sandbox: new FakeSandbox({}), model: null });
  expect(report.outcome).toBe('resurrected');
  return { root, report };
}

const json = [{ name: 'content-type', value: 'application/json' }];
const modelCases = {
  cases: [
    { route: 'POST /notes', name: 'create', method: 'post', path: '/notes', headers: [...json, { name: 'Authorization', value: 'Bearer x' }], body: '{"text":"hi"}' },
    { route: 'POST /notes', name: 'missing text', method: 'POST', path: '/notes', headers: json, body: '{}' },
    { route: 'GET /lucky', name: 'lucky', method: 'GET', path: '/lucky', headers: [], body: null },
    { route: 'GET /invented', name: 'not a real route', method: 'GET', path: '/invented', headers: [], body: null },
  ],
};

describe('normalization', () => {
  it('blanks timestamps, ids, tokens and hashes in text', () => {
    expect(
      normalizeText('at 2017-09-01T10:00:00.123Z id 59a8f0c2e4b0a1b2c3d4e5f6 u 1b4e28ba-2fa1-11d2-883f-0016d3cca427 t eyJhbGciOi.eyJzdWIi.c2ln on Fri, 01 Sep 2017 10:00:00 GMT'),
    ).toBe('at <timestamp> id <objectid> u <uuid> t <jwt> on <timestamp>');
  });

  it('uses keys to decide, and keeps values that are behaviour', () => {
    expect(
      normalizeJson({ id: 42, userId: '17', createdAt: '2017-09-01', expires: 1504260000, token: 'abc', password_hash: 'x', name: 'Ada', count: 3, at: 1504260000123 }),
    ).toEqual({ id: '<id>', userId: '<id>', createdAt: '<timestamp>', expires: '<timestamp>', token: '<secret>', password_hash: '<secret>', name: 'Ada', count: 3, at: '<timestamp>' });
    expect(normalizeJson([{ title: 'kept', updated_at: 'not a date' }])).toEqual([{ title: 'kept', updated_at: 'not a date' }]);
  });

  it('keeps behavioural headers and only the names of cookies', () => {
    expect(
      normalizeHeaders({ 'content-type': 'Application/JSON;charset=UTF-8', date: 'x', etag: 'W/"1"', 'set-cookie': ['sid=1; HttpOnly', 'csrf=2'], location: '/notes/59a8f0c2e4b0a1b2c3d4e5f6' }),
    ).toEqual({ 'content-type': 'application/json; charset=utf-8', location: '/notes/<objectid>', 'set-cookie': 'csrf, sid' });
  });

  it('parses JSON bodies even without a JSON content type, and falls back to text', () => {
    expect(normalizeBody('{"createdAt":"2017-09-01T00:00:00Z"}', 'text/html')).toEqual({ createdAt: '<timestamp>' });
    expect(normalizeBody('{oops', 'application/json')).toBe('{oops');
  });

  it('finds and blanks fields that differ between two identical requests', () => {
    const a = { items: [{ score: 0.1, name: 'a' }], ok: true };
    const b = { items: [{ score: 0.7, name: 'a' }], ok: true };
    expect(differingPaths(a, b)).toEqual(['/items/0/score']);
    expect(blank(a, ['/items/0/score'])).toEqual({ items: [{ score: '<volatile>', name: 'a' }], ok: true });
    expect(differingPaths([1], [1, 2])).toEqual(['/']);
    expect(blank('text', ['/'])).toBe('<volatile>');
  });
});

describe('inputs', () => {
  const routes: HttpRoute[] = [
    { method: 'GET', path: '/users/:id(\\d+)/posts/{post}', file: 'a.js', line: 1 },
    { method: 'POST', path: '/users', file: 'a.js', line: 2 },
    { method: 'ALL', path: '/files/*', file: 'a.js', line: 3 },
  ];

  it('fills path parameters and sends empty JSON to write routes by default', () => {
    expect(fillPath('/a/:id?/b/{x}/*')).toBe('/a/1/b/1/x');
    expect(defaultCases(routes)).toEqual([
      { route: 'GET /users/:id(\\d+)/posts/{post}', name: 'default', method: 'GET', path: '/users/1/posts/1', headers: {}, body: null },
      { route: 'POST /users', name: 'default', method: 'POST', path: '/users', headers: { 'content-type': 'application/json' }, body: '{}' },
      { route: 'ALL /files/*', name: 'default', method: 'GET', path: '/files/x', headers: {}, body: null },
    ]);
  });

  it('keeps model cases for known routes, strips credentials, and covers skipped routes', async () => {
    const model = new ScriptedModel({
      cases: [
        { route: 'POST /users', name: 'create', method: 'post', path: '/users', headers: [{ name: 'Cookie', value: 'a=b' }, { name: 'X-Thing', value: '1' }], body: '{"name":"ada"}' },
        { route: 'DELETE /made-up', name: 'invented', method: 'DELETE', path: '/made-up', headers: [], body: null },
      ],
    });
    const { cases } = await generateCases({ model, routes, snippets: new Map([['a.js:2', "router.post('/users', create)"]]), interview: null });
    expect(cases.map((c) => `${c.method} ${c.path} ${c.name}`)).toEqual(['POST /users create', 'GET /users/1/posts/1 default', 'GET /files/x default']);
    expect(cases[0]!.headers).toEqual({ 'x-thing': '1' });
    expect(model.requests[0]!.prompt).toContain("router.post('/users', create)");
    expect(model.requests[0]!.effort).toBe('low');
  });
});

describe('request runner', () => {
  it('sends cases in order, repeats safe requests, and reports connection errors', async () => {
    const cases = defaultCases([
      { method: 'POST', path: '/notes', file: 'a', line: 1 },
      { method: 'GET', path: '/lucky', file: 'a', line: 1 },
    ]);
    cases[0]!.body = '{"text":"x"}';
    const { stdout } = await run(process.execPath, ['-e', RUNNER], { env: { ...process.env, ...runnerEnv(cases, port) } });
    const raw = parseRunnerOutput(`npm noise\n${stdout}truncated @@necromancer-witness@@{"i":`);
    expect(raw.map((r) => [r.i, r.repeat, r.status])).toEqual([
      [0, 0, 201],
      [1, 0, 200],
      [1, 1, 200],
    ]);

    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    closed.close();
    const down = await run(process.execPath, ['-e', RUNNER], { env: { ...process.env, ...runnerEnv(cases.slice(0, 1), deadPort) } });
    expect(parseRunnerOutput(down.stdout)).toEqual([{ i: 0, repeat: 0, status: null, headers: {}, body: '', error: 'ECONNREFUSED' }]);
  });
});

describe('witness', () => {
  it('boots the revived app, records normalized snapshots, and runs the tests next to it', async () => {
    const { root, report: res } = await revived();
    const sandbox = new FakeSandbox({ exec: realRunner });
    const model = new ScriptedModel(modelCases);
    const report = await witness(root, { sandbox, resurrect: res, model });

    expect(report.routes).toEqual({ found: 3, exercised: 3, skipped: [] });
    expect(report.inputs).toEqual({ source: 'claude-api', model: 'scripted', tokens: 0 });
    const byName = Object.fromEntries(report.snapshots.map((s) => [s.case.name, s]));
    expect(Object.keys(byName)).toEqual(['create', 'missing text', 'lucky', 'default']);
    expect(byName.create!.response).toEqual({
      status: 201,
      headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'sid' },
      body: { _id: '<id>', text: 'hi', createdAt: '<timestamp>' },
      error: null,
    });
    expect(byName['missing text']!.response.status).toBe(400);
    expect(byName.lucky!.volatile).toEqual(['/n']);
    expect(byName.lucky!.response.body).toEqual({ n: '<volatile>', ok: true });
    expect(byName.default!.case.path).toBe('/notes/1');
    expect(byName.default!.response).toMatchObject({ status: 404, body: 'Not Found' });

    expect(report.tests).toMatchObject({ command: 'npm test', ok: true, summary: '3 passing, 1 pending' });
    const boot = sandbox.calls.find((c) => c.step === 'boot')!;
    expect(boot.boot).toMatchObject({ command: 'npm start', port: 3000 });
    const execs = sandbox.calls.filter((c) => c.step === 'exec');
    expect(execs.map((c) => c.namespace)).toEqual(['app-container', 'app-container']);
    expect(execs[1]!.command).toBe('sh -c npm test');
    expect(sandbox.cleaned).toBe(1);
  });

  it('falls back to placeholder requests when the model fails, and skips tests on request', async () => {
    const { root, report: res } = await revived();
    const report = await witness(root, { sandbox: new FakeSandbox({ exec: realRunner }), resurrect: res, model: new ScriptedModel(), runTests: false });
    expect(report.inputs.source).toBe('default');
    expect(report.warnings[0]).toMatch(/could not generate inputs .*ran out of answers/);
    expect(report.snapshots.map((s) => `${s.case.method} ${s.case.path} ${s.response.status}`)).toEqual(['POST /notes 400', 'GET /notes/1 404', 'GET /lucky 200']);
    expect(report.tests).toBeNull();
  });

  it('refuses a project that Resurrect could not bring back', async () => {
    const { root, report: res } = await revived();
    await expect(witness(root, { sandbox: new FakeSandbox({}), resurrect: { ...res, outcome: 'blocked', blockedReason: 'no fix' } })).rejects.toThrow(/BLOCKED: no fix/);
  });

  it('replays golden requests and reports only real behaviour changes', async () => {
    const { root, report: res } = await revived();
    const golden = await witness(root, { sandbox: new FakeSandbox({ exec: realRunner }), resurrect: res, model: new ScriptedModel(modelCases) });
    const again = await witness(root, { sandbox: new FakeSandbox({ exec: realRunner }), resurrect: res, cases: golden.snapshots.map((s) => s.case) });
    expect(again.inputs.source).toBe('replay');
    expect(compareWitness(golden, again)).toEqual([]);

    const changed: WitnessReport = structuredClone(again);
    changed.snapshots[1]!.response.status = 500;
    changed.snapshots[0]!.response.body = { _id: '<id>', text: 'HI', createdAt: '<timestamp>' };
    changed.snapshots.pop();
    changed.tests = { ...changed.tests!, ok: false, summary: '1 failing' };
    expect(compareWitness(golden, changed).map((d) => `${d.what} ${d.case}`)).toEqual([
      'body POST /notes (create)',
      'status POST /notes (missing text)',
      'missing GET /notes/1 (default)',
      'tests npm test',
    ]);
  });
});

describe('testSummary', () => {
  it('reads the summary line of common runners', () => {
    expect(testSummary('  12 passing (3s)\n  2 failing')).toBe('12 passing, 2 failing');
    expect(testSummary('Tests:       1 failed, 4 passed, 5 total')).toBe('1 failed, 4 passed, 5 total');
    expect(testSummary(' Tests  4 passed (4)\n')).toBe('4 passed (4)');
    expect(testSummary('# pass  7\n# fail  1')).toBe('7 passing, 1 failing');
    expect(testSummary('  3 tests passed')).toBe('3 tests passed');
    expect(testSummary('nothing here')).toBeNull();
  });
});
