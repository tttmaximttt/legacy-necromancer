import { useCallback, useEffect, useState, type DragEvent } from 'react';
import type { StoredRepo } from '@necromancer/core';
import { listRepos, loadRepo, readDroppedFiles, type Reports } from './api';
import { ArchitectureView } from './ArchitectureView';
import { GraveyardView } from './GraveyardView';
import { STATUS } from './palette';
import { useTheme } from './theme';

type Tab = 'architecture' | 'graveyard';

function readUrl(): { repo: string | null; tab: Tab } {
  const p = new URLSearchParams(location.search);
  return { repo: p.get('repo'), tab: p.get('tab') === 'graveyard' ? 'graveyard' : 'architecture' };
}

export function App() {
  const { mode, choice, cycle } = useTheme();
  const [repos, setRepos] = useState<StoredRepo[] | null | undefined>(undefined);
  const [slug, setSlug] = useState<string | null>(readUrl().repo);
  const [tab, setTab] = useState<Tab>(readUrl().tab);
  const [reports, setReports] = useState<Reports | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    void listRepos().then((list) => {
      setRepos(list);
      if (list?.length && !slug) setSlug(list[0]!.slug);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!slug) return;
    setError(null);
    loadRepo(slug).then(setReports, (e: Error) => setError(e.message));
  }, [slug]);

  useEffect(() => {
    const p = new URLSearchParams();
    if (slug) p.set('repo', slug);
    if (tab !== 'architecture') p.set('tab', tab);
    const q = p.toString();
    history.replaceState(null, '', q ? `?${q}` : location.pathname);
  }, [slug, tab]);

  // Default to whichever report exists.
  useEffect(() => {
    if (reports && tab === 'architecture' && !reports.exhume && reports.graveyard) setTab('graveyard');
  }, [reports, tab]);

  const onDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    try {
      const dropped = await readDroppedFiles(e.dataTransfer.files);
      setSlug(null);
      setReports((cur) => ({ exhume: dropped.exhume ?? cur?.exhume ?? null, graveyard: dropped.graveyard ?? cur?.graveyard ?? null }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const exhume = reports?.exhume ?? null;
  const graveyard = reports?.graveyard ?? null;
  const interview = reports?.interview ?? null;
  const source = exhume?.repo.source ?? graveyard?.repo.source ?? null;

  return (
    <div
      className={`app ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <h1>
          <span aria-hidden>☠</span> Necromancer
        </h1>
        {repos && repos.length > 0 && (
          <select value={slug ?? ''} onChange={(e) => setSlug(e.target.value || null)} aria-label="Repository">
            {!slug && <option value="">Dropped files</option>}
            {repos.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.source.replace(/^https?:\/\/(www\.)?github\.com\//, '')}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="ghost theme" onClick={cycle} title={`Theme: ${choice}`} aria-label={`Theme: ${choice}. Click to change.`}>
          {choice === 'system' ? 'Auto theme' : mode === 'dark' ? 'Dark' : 'Light'}
        </button>
      </header>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {!reports ? (
        <Empty loading={repos === undefined || (!!slug && !error)} hasApi={repos !== null} />
      ) : (
        <main>
          <section className="summary">
            <div className="summary-title">
              <h2>{source?.replace(/^https?:\/\/(www\.)?/, '') ?? 'Unknown repository'}</h2>
              <p className="muted">{graveyard?.era.summary ?? eraFromHistory(exhume)}</p>
              {interview && (
                <p className="intent">
                  <span className="intent-label">{interview.status === 'proposed' ? 'Proposed intent' : 'Intent'}</span> {interview.intent}
                  {interview.goals.length > 0 && <span className="muted"> · {interview.goals.length} goals</span>}
                </p>
              )}
            </div>
            <div className="tiles">
              {exhume && (
                <>
                  <Tile value={exhume.stats.files} label="source files" />
                  <Tile value={exhume.stats.loc.toLocaleString()} label="lines of code" />
                  <Tile value={exhume.clusters.length} label="clusters" />
                  <Tile value={exhume.history.commits.toLocaleString()} label={`commits by ${exhume.history.authors}`} />
                </>
              )}
              {graveyard && (
                <>
                  <Tile value={graveyard.summary.dead + graveyard.summary.dying} label={`of ${graveyard.summary.total} deps dead or dying`} tone="dead" />
                  <Tile value={graveyard.summary.vulnerable} label="deps with advisories" tone="ailing" />
                </>
              )}
            </div>
            {exhume && (exhume.caseMismatches.length > 0 || exhume.installScripts.some((f) => f.severity !== 'info')) && (
              <ul className="alerts">
                {exhume.installScripts
                  .filter((f) => f.severity !== 'info')
                  .map((f, i) => (
                    <li key={`s${i}`}>
                      <strong>{f.severity === 'high' ? '⚠ Suspicious' : 'Review'} install script</strong> in {f.manifest} ({f.hook}):{' '}
                      <code>{f.command}</code> — {f.reasons.join('; ')}
                    </li>
                  ))}
                {exhume.caseMismatches.map((m, i) => (
                  <li key={`c${i}`}>
                    <strong>Breaks on Linux:</strong> <code>{m.from}:{m.line}</code> imports <code>{m.specifier}</code> but the file is{' '}
                    <code>{m.target}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <nav className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'architecture'} disabled={!exhume} onClick={() => setTab('architecture')}>
              Architecture
            </button>
            <button type="button" role="tab" aria-selected={tab === 'graveyard'} disabled={!graveyard} onClick={() => setTab('graveyard')}>
              Graveyard
            </button>
          </nav>

          {tab === 'architecture' && exhume && <ArchitectureView report={exhume} mode={mode} />}
          {tab === 'graveyard' && graveyard && <GraveyardView report={graveyard} />}
          {tab === 'architecture' && !exhume && <Missing kind="exhume" source={source} />}
          {tab === 'graveyard' && !graveyard && <Missing kind="graveyard" source={source} />}
        </main>
      )}
    </div>
  );
}

function Tile({ value, label, tone }: { value: number | string; label: string; tone?: 'dead' | 'ailing' }) {
  return (
    <div className={`tile ${tone ? `tile-${tone}` : ''}`}>
      <span className="tile-value">
        {tone && <span aria-hidden>{STATUS[tone].icon} </span>}
        {value}
      </span>
      <span className="tile-label">{label}</span>
    </div>
  );
}

function eraFromHistory(exhume: Reports['exhume']): string {
  const h = exhume?.history;
  if (!h?.firstCommit || !h.lastCommit) return '';
  return `Lived ${h.firstCommit.slice(0, 4)}–${h.lastCommit.slice(0, 4)}.`;
}

function Missing({ kind, source }: { kind: 'exhume' | 'graveyard'; source: string | null }) {
  return (
    <p className="empty">
      No {kind} report saved for this repo yet. Run <code>necromancer {kind} --save {source ?? '<repo>'}</code>.
    </p>
  );
}

function Empty({ loading, hasApi }: { loading: boolean; hasApi: boolean }) {
  if (loading) return <p className="empty">Digging…</p>;
  return (
    <div className="welcome">
      <h2>Nothing exhumed yet</h2>
      <p>Run an autopsy on an abandoned repository:</p>
      <pre>
        <code>necromancer autopsy https://github.com/owner/repo</code>
      </pre>
      <p className="muted">
        {hasApi
          ? 'Reports appear here as soon as they are saved.'
          : 'This page is running without the necromancer server.'}{' '}
        You can also drop <code>exhume</code> and <code>graveyard</code> JSON files anywhere on this page.
      </p>
    </div>
  );
}
