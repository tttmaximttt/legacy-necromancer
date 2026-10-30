export type Fetch = typeof globalThis.fetch;

/** Runs `fn` over `items` with at most `limit` in flight. Keeps registries from rate-limiting us. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`${status} from ${url}`);
  }
}

export async function getJson<T>(fetch: Fetch, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });
  if (!res.ok) throw new HttpError(res.status, url);
  return (await res.json()) as T;
}
