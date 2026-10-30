import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExhumeReport, GraveyardReport, InterviewReport, ResurrectReport } from './types.js';

export type ReportKind = 'exhume' | 'graveyard' | 'interview' | 'resurrect';

export const REPORT_KINDS: readonly ReportKind[] = ['exhume', 'graveyard', 'interview', 'resurrect'];

export interface StoredReports {
  exhume: ExhumeReport | null;
  graveyard: GraveyardReport | null;
  interview: InterviewReport | null;
  resurrect: ResurrectReport | null;
}

export interface StoredRepo {
  slug: string;
  source: string;
  savedAt: string;
  kinds: ReportKind[];
}

export function defaultReportsDir(): string {
  return process.env.NECROMANCER_REPORTS ?? path.join(os.homedir(), '.necromancer', 'reports');
}

/** `https://github.com/a/b.git` → `a__b`, `/home/me/proj` → `proj`. Stable, filesystem-safe. */
export function slugFor(source: string): string {
  const cleaned = source.replace(/\.git$/, '').replace(/\/+$/, '');
  const m = /(?:github\.com|gitlab\.com|bitbucket\.org)[/:]([^/]+)\/([^/]+)$/.exec(cleaned);
  const raw = m ? `${m[1]}__${m[2]}` : (cleaned.split(/[/\\:]/).filter(Boolean).at(-1) ?? 'repo');
  return raw.replace(/[^\w.-]/g, '_').replace(/^\.+/, '_').slice(0, 80) || 'repo';
}

/** One directory per repo with one JSON file per report kind. Later runs overwrite earlier ones. */
export class ReportStore {
  constructor(readonly dir: string = defaultReportsDir()) {}

  async save(kind: ReportKind, report: ExhumeReport | GraveyardReport | InterviewReport | ResurrectReport): Promise<string> {
    const slug = slugFor(report.repo.source);
    const dir = path.join(this.dir, slug);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${kind}.json`);
    await writeFile(file, JSON.stringify(report));
    return file;
  }

  async list(): Promise<StoredRepo[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const repos: StoredRepo[] = [];
    for (const slug of entries) {
      const kinds: ReportKind[] = [];
      let source = slug;
      let savedAt = '';
      for (const kind of REPORT_KINDS) {
        const file = path.join(this.dir, slug, `${kind}.json`);
        const info = await stat(file).catch(() => null);
        if (!info) continue;
        kinds.push(kind);
        if (info.mtime.toISOString() > savedAt) savedAt = info.mtime.toISOString();
        if (source === slug) source = (await this.readSource(file)) ?? slug;
      }
      if (kinds.length) repos.push({ slug, source, savedAt, kinds });
    }
    return repos.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async load(slug: string): Promise<StoredReports | null> {
    if (slug !== slugFor(slug) || slug.includes('..')) return null;
    const read = async <T>(kind: ReportKind) => {
      const text = await readFile(path.join(this.dir, slug, `${kind}.json`), 'utf8').catch(() => null);
      return text ? (JSON.parse(text) as T) : null;
    };
    const [exhume, graveyard, interview, resurrect] = await Promise.all([
      read<ExhumeReport>('exhume'),
      read<GraveyardReport>('graveyard'),
      read<InterviewReport>('interview'),
      read<ResurrectReport>('resurrect'),
    ]);
    return exhume || graveyard || interview || resurrect ? { exhume, graveyard, interview, resurrect } : null;
  }

  private async readSource(file: string): Promise<string | null> {
    try {
      // Reports can be large; the source is in the first few hundred bytes.
      const head = (await readFile(file, 'utf8')).slice(0, 2000);
      return /"source":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1] ?? null;
    } catch {
      return null;
    }
  }
}
