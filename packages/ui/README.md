# @necromancer/ui

Phase 3: the interactive architecture map and the dependency graveyard,
rendered from saved reports.

```sh
necromancer autopsy https://github.com/owner/repo --open   # analyse, save, open
necromancer ui --open                                      # browse everything saved so far
```

Reports live in `~/.necromancer/reports/<repo>/{exhume,graveyard}.json`.
Change the location with `--reports <dir>` or `NECROMANCER_REPORTS`. The CLI
(`--save`) and the MCP tools both write there, so anything Claude exhumes
shows up here. You can also drop report JSON files onto the page.

## Architecture

- The import graph is drawn with [sigma.js](https://www.sigmajs.org/) and
  laid out by ForceAtlas2 in a web worker, starting from cluster positions.
- Colour is the Louvain cluster. The first eight clusters get fixed,
  colour-blind-checked hues; the rest fold into grey.
- Node size is the load-bearing score. The top files get labelled chips.
- Hover or click a file to see what it imports and what imports it. Click a
  cluster in the legend to hide it. Tests are hidden by default.

## Graveyard

Each dependency is a tombstone showing its status (dead, dying, ailing,
alive; each shown as an icon plus a word, never colour alone), its causes,
the worst advisory and a suggested successor. You can filter by status and
search by name, with or without dev dependencies. When a lookup failed, the
page says so instead of showing the package as healthy.

## Development

```sh
necromancer ui              # API on :4173
pnpm --filter @necromancer/ui dev   # Vite on :5173, proxies /api to :4173
```
