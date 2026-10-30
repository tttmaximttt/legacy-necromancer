# ☠ Necromancer

An AI archaeologist for abandoned JavaScript and TypeScript projects.

Point it at an old repository. It reconstructs the architecture, finds the
files everything else leans on, audits what would run on `npm install`, and
(in later phases) works out what it takes to bring the project back to life
and how to modernise it safely.

```sh
pnpm install
pnpm build
pnpm necromancer exhume https://github.com/tttmaximttt/node-orm2 > report.json
```

## Design

A pipeline in which only two steps are agents. Everything else is
deterministic, seeded, and testable without an LLM.

| Phase | Package | Kind | Status |
| --- | --- | --- | --- |
| 1. Excavate | [`excavate`](packages/excavate) | deterministic | **working** |
| 2. Date + Graveyard | [`graveyard`](packages/graveyard) | deterministic | **working** |
| 3. Map | [`ui`](packages/ui) | UI | stub |
| 4. Resurrect | [`resurrect`](packages/resurrect) | agent (known-fix table first) | stub |
| 5. Witness | [`witness`](packages/witness) | deterministic | stub |
| Stretch: Operate | [`surgeon`](packages/surgeon) | agent | stub |

## Use it from Claude

[`packages/mcp`](packages/mcp) is an MCP server that exposes each stage as a
tool, so Claude Code or Claude Desktop can run Necromancer as part of a
conversation. In Claude Code, inside this repo, run `pnpm build` and it's
picked up from `.mcp.json`. Then ask "exhume
https://github.com/tttmaximttt/node-orm2 and tell me if it's worth reviving".
Setup for Claude Desktop and other directories is in the
[package README](packages/mcp/README.md).

Shared code lives in [`core`](packages/core) (report types, seeded RNG) and
[`llm`](packages/llm) (model client for the agent phases). The command line is
[`cli`](packages/cli), and the MCP server is [`mcp`](packages/mcp).

Phases 1 to 3 are the first demo: no Docker, no LLM, just "here's what this
dead repo is and what's rotting in it".

## `necromancer exhume <git-url | path>`

Clones the repo (partial clone, symlinks disabled, nothing executed), then:

1. Parses every JS/TS file with **web-tree-sitter** and extracts `import`,
   `export … from`, `require()`, `import()` and `import x = require()`.
2. Resolves specifiers the way Node would: extensions, `index` files,
   `package.json` `main`, TS-style `./x.js` → `./x.ts`.
3. Builds a directed import graph with **graphology**.
4. Clusters it with **Louvain** (seeded, so reports are reproducible).
5. Ranks **load-bearing** files by blast radius, betweenness centrality and
   git churn (from **simple-git**).
6. Audits install-time lifecycle scripts in every `package.json` (and the JS
   files they run), plus lockfile dependencies that have install scripts.
7. Flags imports that only resolve on case-insensitive filesystems: they
   work on the original author's Mac and break in a Linux container.

Test files are excluded from clusters and rankings by default; pass
`--include-tests` to keep them. Run `necromancer exhume --help` for every
option.

Trimmed output for `node-orm2`, a 2012 to 2017 ORM:

```json
{
  "stats": { "files": 114, "loc": 18760, "internalEdges": 209, "unresolvedImports": 2, "caseMismatchedImports": 1, "testFiles": 70 },
  "history": { "commits": 1337, "authors": 72, "firstCommit": "2012-11-26T17:50:49+00:00", "lastCommit": "2017-09-19T12:29:34+00:00" },
  "clusters": [
    { "id": 0, "label": "lib", "size": 15, "cohesion": 0.763, "files": ["lib/AggregateFunctions.js", "lib/Associations/Extend.js", "…"] },
    { "id": 2, "label": "lib/Drivers/DML", "size": 7, "cohesion": 1, "files": ["…"] }
  ],
  "loadBearing": [
    { "path": "lib/ORM.js", "score": 0.737, "blastRadius": 9, "betweenness": 0.094, "fanIn": 4, "fanOut": 10, "churn": 102 },
    { "path": "lib/Model.js", "score": 0.637, "blastRadius": 10, "betweenness": 0.05, "fanIn": 1, "fanOut": 12, "churn": 142 }
  ],
  "caseMismatches": [{ "from": "lib/ErrorCodes.js", "specifier": "./error", "line": 2, "target": "lib/Error.js" }]
}
```

## `necromancer graveyard <git-url | path>`

Dates the project (git history, dependency publish dates, `engines.node`)
and puts a tombstone on every dependency. It records the version the
project actually used (from the lockfile, or else the version `npm install`
would have picked the day the project died), a status of **dead**,
**dying**, **ailing** or **alive** with the reasons, known advisories, and
a suggested successor. Data comes from the npm registry, the advisory
database `npm audit` uses (or OSV.dev with `--advisories osv`), and GitHub
for archived repos. Set `GITHUB_TOKEN` to check every dependency's repo.
Details are in the [package README](packages/graveyard/README.md).

For node-orm2 it finds 22 dependencies: 1 dead, 6 dying, 13 ailing and 2
alive. lodash 4.17.4 has 10 advisories (worst critical). Its summary
reads "Lived 2012–2017; manifest written no earlier than 2017-08
(sinon@3.2.1)".

## Safety

Excavate only reads. It never installs dependencies or runs repo code. Later
phases that do (Resurrect, Witness, Operate) must run in a throwaway
container, never on your machine, against shared environments, or in
production.

## Development

Node 22+, pnpm 10.

```sh
pnpm build        # tsc -b across all packages
pnpm test         # vitest
pnpm necromancer  # run the built CLI
```
