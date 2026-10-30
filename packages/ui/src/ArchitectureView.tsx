import forceAtlas2 from 'graphology-layout-forceatlas2';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import { useEffect, useMemo, useRef, useState } from 'react';
import Sigma from 'sigma';
import type { ExhumeReport, LoadBearingFile } from '@necromancer/core';
import { buildDisplayGraph, neighbourhood, type NodeAttrs } from './graph-model';
import { clusterColor, MAX_COLORED_CLUSTERS, type Mode } from './palette';
import { useCssVar } from './theme';

const LAYOUT_MS = 3000;

export function ArchitectureView({ report, mode }: { report: ExhumeReport; mode: Mode }) {
  const [showTests, setShowTests] = useState(false);
  const [hiddenClusters, setHiddenClusters] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [layoutRunning, setLayoutRunning] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma<NodeAttrs> | null>(null);
  const layoutRef = useRef<FA2Layout | null>(null);

  const ink = useCssVar('--text-primary', mode);
  const muted = useCssVar('--edge', mode);
  const dim = useCssVar('--dim', mode);
  const chip = useCssVar('--chip', mode);
  const chipShadow = useCssVar('--chip-shadow', mode);

  const graph = useMemo(() => buildDisplayGraph(report, { showTests, mode }), [report, showTests, mode]);

  // Everything the reducers read lives in a ref so hover doesn't rebuild sigma.
  const view = useRef({ hiddenClusters, selected, hovered, query, ink, muted, dim, chip, chipShadow });
  view.current = { hiddenClusters, selected, hovered, query, ink, muted, dim, chip, chipShadow };

  useEffect(() => {
    if (!container.current) return;
    const renderer = new Sigma<NodeAttrs>(graph, container.current, {
      // sigma 4 freezes the viewport after the first frame by default; the force layout keeps growing, so keep rescaling.
      settings: { autoRescale: true, itemSizesReference: 'screen', labelDensity: 0.6, labelRenderedSizeThreshold: 7, minCameraRatio: 0.05, maxCameraRatio: 4 },
      nodeReducer: (key, _data, attrs) => {
        const v = view.current;
        if (v.hiddenClusters.has(attrs.cluster)) return { visibility: 'hidden' };
        const focus = v.selected ?? v.hovered;
        const near = focus && graph.hasNode(focus) ? neighbourhood(graph, focus) : null;
        const matches = v.query.length >= 2 && key.toLowerCase().includes(v.query.toLowerCase());
        const out: Partial<import('sigma/types').NodeDisplayData> = { labelColor: v.ink };
        if (attrs.loadBearingRank >= 0) {
          // The same chip sigma draws on hover, kept on permanently for the top-ranked files.
          out.labelVisibility = 'visible';
          out.backdropVisibility = 'visible';
          out.backdropColor = v.chip;
          out.backdropShadowColor = v.chipShadow;
          out.backdropShadowBlur = 10;
          out.backdropPadding = 5;
          out.zIndex = 2;
        }
        if (near && !near.has(key)) {
          out.color = v.dim;
          out.labelVisibility = 'hidden';
          out.backdropVisibility = 'hidden';
          out.zIndex = 0;
        } else if (near) {
          out.labelVisibility = 'visible';
          out.zIndex = 3;
        }
        if (matches) {
          out.labelVisibility = 'visible';
          out.highlighted = true;
          out.zIndex = 4;
        }
        return out;
      },
      edgeReducer: (key) => {
        const v = view.current;
        const [s, t] = graph.extremities(key);
        const sa = graph.getNodeAttributes(s);
        const ta = graph.getNodeAttributes(t);
        if (v.hiddenClusters.has(sa.cluster) || v.hiddenClusters.has(ta.cluster)) return { visibility: 'hidden' };
        const focus = v.selected ?? v.hovered;
        if (focus && graph.hasNode(focus)) {
          return s === focus || t === focus ? { color: v.ink, size: 1.6, zIndex: 2 } : { visibility: 'hidden' };
        }
        return { color: v.muted, size: 0.6 };
      },
    });
    renderer.on('enterNode', ({ node }) => setHovered(node));
    renderer.on('leaveNode', () => setHovered(null));
    renderer.on('clickNode', ({ node }) => setSelected((cur) => (cur === node ? null : node)));
    renderer.on('clickStage', () => setSelected(null));
    sigmaRef.current = renderer;

    const layout = new FA2Layout(graph, {
      settings: { ...forceAtlas2.inferSettings(graph), gravity: 1, scalingRatio: 8, barnesHutOptimize: graph.order > 400 },
    });
    layoutRef.current = layout;
    layout.start();
    setLayoutRunning(true);
    const timer = setTimeout(() => {
      layout.stop();
      setLayoutRunning(false);
    }, LAYOUT_MS);

    return () => {
      clearTimeout(timer);
      layout.kill();
      renderer.kill();
      sigmaRef.current = null;
      layoutRef.current = null;
    };
  }, [graph]);

  useEffect(() => {
    sigmaRef.current?.refresh({ skipIndexation: true });
  }, [hiddenClusters, selected, hovered, query, ink, muted, dim, chip, chipShadow]);

  // Drop a selection that a filter just hid.
  useEffect(() => {
    if (selected && !graph.hasNode(selected)) setSelected(null);
  }, [graph, selected]);

  const relayout = () => {
    const layout = layoutRef.current;
    if (!layout || layout.isRunning()) return;
    layout.start();
    setLayoutRunning(true);
    setTimeout(() => {
      layout.stop();
      setLayoutRunning(false);
    }, LAYOUT_MS);
  };

  const focusOn = (file: string) => {
    setSelected(file);
    const renderer = sigmaRef.current;
    if (!renderer || !graph.hasNode(file)) return;
    const pos = renderer.getNodeDisplayData(file);
    if (pos) renderer.getCamera().animate({ x: pos.x, y: pos.y, ratio: 0.35 }, { duration: 500 });
  };

  const toggleCluster = (id: number) =>
    setHiddenClusters((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const otherClusters = report.clusters.slice(MAX_COLORED_CLUSTERS);
  const testCount = report.graph.nodes.filter((n) => n.isTest).length;

  return (
    <div className="architecture">
      <div className="toolbar" role="toolbar" aria-label="Graph controls">
        <input
          type="search"
          placeholder="Find a file…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const hit = graph.findNode((n) => n.toLowerCase().includes(query.toLowerCase()));
            if (hit) focusOn(hit);
          }}
          aria-label="Find a file"
        />
        <label className="check">
          <input type="checkbox" checked={showTests} onChange={(e) => setShowTests(e.target.checked)} disabled={!testCount} />
          Show {testCount} test files
        </label>
        <button type="button" onClick={relayout} disabled={layoutRunning}>
          {layoutRunning ? 'Arranging…' : 'Re-run layout'}
        </button>
        <span className="hint">Node size = load-bearing score · labelled chips = top {report.loadBearing.length} · click a file for details</span>
      </div>

      <div className="architecture-body">
        <div className="canvas" ref={container} aria-label="Import graph" role="img" />

        <aside className="side">
          {selected && graph.hasNode(selected) ? (
            <FileDetails file={selected} report={report} graph={graph} onPick={focusOn} onClose={() => setSelected(null)} />
          ) : (
            <LoadBearingList files={report.loadBearing} onPick={focusOn} mode={mode} />
          )}

          <section>
            <h3>Clusters</h3>
            <ul className="legend">
              {report.clusters.slice(0, MAX_COLORED_CLUSTERS).map((c) => (
                <li key={c.id}>
                  <button type="button" className={hiddenClusters.has(c.id) ? 'off' : ''} onClick={() => toggleCluster(c.id)} aria-pressed={!hiddenClusters.has(c.id)}>
                    <span className="swatch" style={{ background: clusterColor(c.id, mode) }} />
                    <span className="legend-label">{c.label}</span>
                    <span className="legend-meta">
                      {c.size} files · {Math.round(c.cohesion * 100)}% internal
                    </span>
                  </button>
                </li>
              ))}
              {otherClusters.length > 0 && (
                <li>
                  <span className="legend-static">
                    <span className="swatch" style={{ background: clusterColor(-1, mode) }} />
                    <span className="legend-label">
                      {otherClusters.length} smaller clusters, tests and orphans
                    </span>
                  </span>
                </li>
              )}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

function LoadBearingList({ files, onPick, mode }: { files: LoadBearingFile[]; onPick: (f: string) => void; mode: Mode }) {
  return (
    <section>
      <h3>Load-bearing files</h3>
      <p className="muted small">What breaks the most if it breaks: blast radius, centrality and churn.</p>
      <ol className="ranked">
        {files.map((f) => (
          <li key={f.path}>
            <button type="button" onClick={() => onPick(f.path)}>
              <span className="swatch" style={{ background: clusterColor(f.cluster, mode) }} />
              <span className="path">{f.path}</span>
              <span className="score">{f.score.toFixed(2)}</span>
              <span className="meta">
                {f.blastRadius} dependants · {f.churn} commits · in {f.fanIn} / out {f.fanOut}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function FileDetails({
  file,
  report,
  graph,
  onPick,
  onClose,
}: {
  file: string;
  report: ExhumeReport;
  graph: ReturnType<typeof buildDisplayGraph>;
  onPick: (f: string) => void;
  onClose: () => void;
}) {
  const attrs = graph.getNodeAttributes(file);
  const n = attrs.data;
  const cluster = report.clusters.find((c) => c.id === n.cluster);
  const imports = graph.outNeighbors(file).sort();
  const importers = graph.inNeighbors(file).sort();
  return (
    <section className="details">
      <div className="details-head">
        <h3 title={file}>{file}</h3>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </div>
      <dl className="facts">
        <dt>Cluster</dt>
        <dd>{cluster ? cluster.label : n.isTest ? 'tests' : 'unclustered'}</dd>
        <dt>Load-bearing</dt>
        <dd>{n.score === null ? '—' : `${n.score.toFixed(2)}${attrs.loadBearingRank >= 0 ? ` (#${attrs.loadBearingRank + 1})` : ''}`}</dd>
        <dt>Blast radius</dt>
        <dd>{n.blastRadius ?? '—'} files</dd>
        <dt>Commits</dt>
        <dd>{n.churn}</dd>
        <dt>Lines</dt>
        <dd>{n.loc}</dd>
      </dl>
      <FileList title={`Imports (${imports.length})`} files={imports} onPick={onPick} />
      <FileList title={`Imported by (${importers.length})`} files={importers} onPick={onPick} />
    </section>
  );
}

function FileList({ title, files, onPick }: { title: string; files: string[]; onPick: (f: string) => void }) {
  if (!files.length) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className="files">
        {files.map((f) => (
          <li key={f}>
            <button type="button" onClick={() => onPick(f)}>
              {f}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
