import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { ReportStore } from '@necromancer/core';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

/**
 * Serves the built UI and a read-only JSON API over the report store.
 * Binds to localhost only: reports describe private code.
 */
export function createUiServer(store: ReportStore, staticDir: string | null): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'read-only' });

    if (url.pathname === '/api/reports') return send(200, await store.list());
    const one = /^\/api\/reports\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const reports = await store.load(decodeURIComponent(one[1]!));
      return reports ? send(200, reports) : send(404, { error: 'not found' });
    }
    if (url.pathname.startsWith('/api/')) return send(404, { error: 'not found' });

    if (!staticDir) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      return res.end('UI not built. Run `pnpm build` in the necromancer repo.');
    }
    const resolved = path.resolve(staticDir, `.${decodeURIComponent(url.pathname)}`);
    const inside = resolved === staticDir || resolved.startsWith(staticDir + path.sep);
    let file = inside ? resolved : path.join(staticDir, 'index.html');
    const info = await stat(file).catch(() => null);
    // SPA fallback.
    if (!info?.isFile()) file = path.join(staticDir, 'index.html');
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  });
}
