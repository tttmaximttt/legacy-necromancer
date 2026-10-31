import type { ExhumeReport, GraveyardReport, InterviewReport, ResurrectReport, StoredRepo, WitnessReport } from '@necromancer/core';

export interface Reports {
  exhume: ExhumeReport | null;
  graveyard: GraveyardReport | null;
  /** Only from the server; dropped files never include it. */
  interview?: InterviewReport | null;
  resurrect?: ResurrectReport | null;
  witness?: WitnessReport | null;
}

/** null means there is no API (the UI was opened as static files); the user can still drop JSON in. */
export async function listRepos(): Promise<StoredRepo[] | null> {
  try {
    const res = await fetch('/api/reports');
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
    return (await res.json()) as StoredRepo[];
  } catch {
    return null;
  }
}

export async function loadRepo(slug: string): Promise<Reports> {
  const res = await fetch(`/api/reports/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`could not load ${slug} (${res.status})`);
  return (await res.json()) as Reports;
}

/** Accepts any mix of exhume/graveyard JSON files, as written by the CLI. */
export async function readDroppedFiles(files: Iterable<File>): Promise<Reports> {
  const out: Reports = { exhume: null, graveyard: null };
  for (const file of files) {
    const json = JSON.parse(await file.text()) as Record<string, unknown>;
    if ('tombstones' in json) out.graveyard = json as unknown as GraveyardReport;
    else if ('clusters' in json && 'graph' in json) out.exhume = json as unknown as ExhumeReport;
    else if ('clusters' in json) throw new Error(`${file.name} is an exhume report without graph data; re-run it with this version of necromancer`);
    else throw new Error(`${file.name} is not a necromancer report`);
  }
  return out;
}
