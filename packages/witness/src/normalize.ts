/**
 * Snapshots are only useful if the same behaviour always snapshots the same. These rules blank what
 * legitimately changes between runs (clocks, generated IDs, tokens) while keeping shapes, types and the values
 * that are behaviour.
 */

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?\b/g;
const HTTP_DATE = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT\b/g;
const JS_DATE = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}( \([^)]*\))?/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const OBJECT_ID = /\b[0-9a-f]{24}\b/g;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g;
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;
/** Epoch milliseconds between 2001 and 2033. */
const EPOCH_MS = /^1[0-9]{12}$/;

const ID_KEY = /^(_?id|uuid|guid|.*[_-]id|.*Id|.*ID)$/;
const TIME_KEY = /^(.*_at|.*At|.*_on|.*On|.*date|.*Date|.*time|.*Time|timestamp|ts|expires|exp|iat)$/;
const SECRET_KEY = /^(.*token|.*Token|.*secret|.*Secret|.*hash|.*Hash|.*salt|.*Salt|nonce|csrf.*|session.*|sid)$/;

export function normalizeText(text: string): string {
  return text
    .replace(JWT, '<jwt>')
    .replace(UUID, '<uuid>')
    .replace(ISO_DATE, '<timestamp>')
    .replace(HTTP_DATE, '<timestamp>')
    .replace(JS_DATE, '<timestamp>')
    .replace(OBJECT_ID, '<objectid>')
    .replace(LONG_HEX, '<hash>');
}

/** Recursively normalizes a parsed JSON value. Keys decide first, then the shape of the value. */
export function normalizeJson(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => normalizeJson(v, key));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalizeJson(v, k);
    return out;
  }
  if (typeof value === 'string') {
    if (key && SECRET_KEY.test(key) && value) return '<secret>';
    if (key && TIME_KEY.test(key) && !Number.isNaN(Date.parse(value))) return '<timestamp>';
    if (key && ID_KEY.test(key) && /^[0-9a-f-]{8,}$|^\d+$/i.test(value)) return '<id>';
    return normalizeText(value);
  }
  if (typeof value === 'number') {
    if (key && TIME_KEY.test(key) && value > 1e9) return '<timestamp>';
    if (EPOCH_MS.test(String(value))) return '<timestamp>';
    if (key && ID_KEY.test(key)) return '<id>';
  }
  return value;
}

/** Headers that carry behaviour; everything else (Date, ETag, X-Response-Time, Content-Length…) is noise. */
const KEPT_HEADERS = ['content-type', 'location', 'cache-control', 'access-control-allow-origin', 'www-authenticate', 'x-powered-by', 'allow', 'content-disposition'];

export function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const v = headers[name];
    if (v === undefined) continue;
    const value = Array.isArray(v) ? v.join(', ') : v;
    out[name] = name === 'content-type' ? value.toLowerCase().replace(/;\s*charset=/, '; charset=') : normalizeText(value);
  }
  // Which cookies are set is behaviour; their values are not.
  const cookies = headers['set-cookie'];
  if (cookies) {
    const list = Array.isArray(cookies) ? cookies : [cookies];
    out['set-cookie'] = list.map((c) => c.split('=')[0]!.trim()).sort().join(', ');
  }
  return out;
}

export function normalizeBody(raw: string, contentType: string | undefined): unknown {
  const looksJson = /json/i.test(contentType ?? '') || /^\s*[[{]/.test(raw);
  if (looksJson) {
    try {
      return normalizeJson(JSON.parse(raw));
    } catch {
      // Not JSON after all.
    }
  }
  return normalizeText(raw);
}

/**
 * Paths where two normalized responses to the same request still differ: random values the rules above
 * didn't catch. Returns JSON-pointer-like paths, e.g. "/items/0/score".
 */
export function differingPaths(a: unknown, b: unknown, at = ''): string[] {
  if (a === b) return [];
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [at || '/'];
    return a.flatMap((v, i) => differingPaths(v, b[i], `${at}/${i}`));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => differingPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}/${k}`));
  }
  return [at || '/'];
}

/** Replaces the value at each path with "<volatile>". */
export function blank(value: unknown, paths: string[]): unknown {
  let out = structuredClone(value);
  for (const p of paths) {
    if (p === '/') {
      out = '<volatile>';
      continue;
    }
    const parts = p.split('/').slice(1);
    let node = out as Record<string, unknown> | unknown[];
    for (const part of parts.slice(0, -1)) node = (node as Record<string, unknown>)[part] as Record<string, unknown>;
    if (node && typeof node === 'object') (node as Record<string, unknown>)[parts.at(-1)!] = '<volatile>';
  }
  return out;
}
