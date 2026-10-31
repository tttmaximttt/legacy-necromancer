import type { WitnessCase } from '@necromancer/core';

export const MARKER = '@@necromancer-witness@@';

export interface RawResponse {
  i: number;
  /** 0 for the first send, 1 for the repeat of a safe request. */
  repeat: number;
  status: number | null;
  headers: Record<string, string | string[]>;
  body: string;
  error: string | null;
}

/**
 * The request runner, executed with the app image's own node inside the app's network namespace. Written in
 * ES5 with only `http`, so it runs on every Node from 0.10. Reads the cases from WITNESS_CASES (base64 JSON),
 * sends them in order, repeats GET/HEAD requests once to spot volatile fields, and prints one marked line per
 * response.
 */
export const RUNNER = `
var http = require('http');
var cases = JSON.parse(new Buffer(process.env.WITNESS_CASES, 'base64').toString('utf8'));
var port = Number(process.env.WITNESS_PORT);
var queue = [];
cases.forEach(function (c, i) {
  queue.push([c, i, 0]);
  if (c.method === 'GET' || c.method === 'HEAD') queue.push([c, i, 1]);
});
function emit(o) { console.log('${MARKER}' + JSON.stringify(o)); }
function next() {
  var item = queue.shift();
  if (!item) return process.exit(0);
  var c = item[0];
  var headers = c.headers || {};
  if (c.body !== null && c.body !== undefined) headers['content-length'] = Buffer.byteLength(c.body);
  var done = false;
  var req = http.request({ host: '127.0.0.1', port: port, method: c.method, path: c.path, headers: headers }, function (res) {
    var chunks = [];
    var size = 0;
    res.on('data', function (d) { if (size < 65536) { chunks.push(d); size += d.length; } });
    res.on('end', function () {
      if (done) return;
      done = true;
      emit({ i: item[1], repeat: item[2], status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8').slice(0, 65536), error: null });
      next();
    });
  });
  req.setTimeout(15000, function () { req.abort(); });
  req.on('error', function (e) {
    if (done) return;
    done = true;
    emit({ i: item[1], repeat: item[2], status: null, headers: {}, body: '', error: String(e.code || e.message) });
    next();
  });
  if (c.body !== null && c.body !== undefined) req.write(c.body);
  req.end();
}
next();
`;

export function runnerEnv(cases: WitnessCase[], port: number): Record<string, string> {
  return { WITNESS_CASES: Buffer.from(JSON.stringify(cases)).toString('base64'), WITNESS_PORT: String(port) };
}

export function parseRunnerOutput(log: string): RawResponse[] {
  const out: RawResponse[] = [];
  for (const line of log.split(/\r?\n/)) {
    const at = line.indexOf(MARKER);
    if (at < 0) continue;
    try {
      out.push(JSON.parse(line.slice(at + MARKER.length)) as RawResponse);
    } catch {
      // A truncated line; the case shows up as missing.
    }
  }
  return out;
}
