import { useMemo, useState } from 'react';
import type { GraveyardReport, Tombstone, TombstoneStatus } from '@necromancer/core';
import { STATUS } from './palette';

const STATUSES: TombstoneStatus[] = ['dead', 'dying', 'ailing', 'alive', 'unknown'];

export function GraveyardView({ report }: { report: GraveyardReport }) {
  const [show, setShow] = useState<Set<TombstoneStatus>>(new Set(['dead', 'dying', 'ailing', 'unknown']));
  const [query, setQuery] = useState('');
  const [includeDev, setIncludeDev] = useState(true);

  const visible = useMemo(
    () =>
      report.tombstones.filter(
        (t) => show.has(t.status) && (includeDev || !t.dev) && (!query || t.name.toLowerCase().includes(query.toLowerCase())),
      ),
    [report, show, query, includeDev],
  );

  const toggle = (s: TombstoneStatus) =>
    setShow((cur) => {
      const next = new Set(cur);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const degraded = Object.entries(report.sources).filter(([k, v]) => k !== 'advisoryProvider' && (v === 'failed' || v === 'partial'));

  return (
    <div className="graveyard">
      <div className="toolbar" role="toolbar" aria-label="Graveyard filters">
        <div className="chips" role="group" aria-label="Status">
          {STATUSES.filter((s) => report.summary[s] > 0).map((s) => (
            <button key={s} type="button" className={`chip ${show.has(s) ? 'on' : ''}`} aria-pressed={show.has(s)} onClick={() => toggle(s)}>
              <span className="status-dot" style={{ background: STATUS[s].color }} aria-hidden />
              {STATUS[s].icon} {STATUS[s].label} <span className="count">{report.summary[s]}</span>
            </button>
          ))}
        </div>
        <input type="search" placeholder="Find a package…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a package" />
        <label className="check">
          <input type="checkbox" checked={includeDev} onChange={(e) => setIncludeDev(e.target.checked)} />
          Include dev dependencies
        </label>
      </div>

      {degraded.length > 0 && (
        <p className="notice" role="status">
          Some lookups failed ({degraded.map(([k, v]) => `${k}: ${v}`).join(', ')}), so some causes may be missing. {report.warnings[0]}
        </p>
      )}

      {visible.length === 0 ? (
        <p className="empty">No dependencies match these filters.</p>
      ) : (
        <ul className="stones">
          {visible.map((t) => (
            <Stone key={t.name} t={t} />
          ))}
        </ul>
      )}

      {report.nonRegistry.length > 0 && (
        <section className="non-registry">
          <h3>Not from the registry</h3>
          <p className="muted small">Git, file and tarball dependencies can't be checked automatically.</p>
          <ul>
            {report.nonRegistry.map((d) => (
              <li key={d.name}>
                <code>{d.name}</code> <span className="muted">{d.spec}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stone({ t }: { t: Tombstone }) {
  const s = STATUS[t.status];
  const worst = t.advisories[0];
  return (
    <li className={`stone stone-${t.status}`} style={{ ['--status' as string]: s.color }}>
      <div className="stone-status">
        <span aria-hidden>{s.icon}</span> {s.label}
        {t.dev && <span className="tag">dev</span>}
      </div>
      <h3 className="stone-name">
        {t.name}
        {t.resolved && <span className="version">@{t.resolved}</span>}
      </h3>
      {t.causes.length > 0 ? (
        <ul className="causes">
          {t.causes.map((c, i) => (
            <li key={i}>
              <strong>{c.kind}</strong> {c.detail}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Nothing wrong found.</p>
      )}
      {worst && (
        <p className="advisory small">
          {worst.url ? (
            <a href={worst.url} target="_blank" rel="noreferrer">
              {worst.title}
            </a>
          ) : (
            worst.title
          )}{' '}
          <span className="sev">({worst.severity})</span>
          {t.advisories.length > 1 && <span className="muted"> +{t.advisories.length - 1} more</span>}
        </p>
      )}
      {t.replacement && (
        <p className="successor">
          <span className="muted">Successor:</span> <strong>{t.replacement.name}</strong>
          <span className="muted small"> · {t.replacement.reason}</span>
        </p>
      )}
      <dl className="stone-facts small">
        <dt>declared</dt>
        <dd>
          <code>{t.declared}</code>
        </dd>
        {t.latest && (
          <>
            <dt>latest</dt>
            <dd>{t.latest}</dd>
          </>
        )}
        {t.lastPublished && (
          <>
            <dt>last release</dt>
            <dd>{t.lastPublished.slice(0, 10)}</dd>
          </>
        )}
        {t.resolvedFrom && (
          <>
            <dt>version from</dt>
            <dd>{t.resolvedFrom === 'era' ? 'what npm picked back then' : t.resolvedFrom}</dd>
          </>
        )}
      </dl>
    </li>
  );
}
