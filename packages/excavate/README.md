# @necromancer/excavate

Phase 1. Turns a repository into an `ExhumeReport` (types in
`@necromancer/core`). Only reads files; it never executes anything from the
repo.

| Module | Does |
| --- | --- |
| `clone.ts` | Partial clone with `core.symlinks=false`, or use a local path as is |
| `files.ts` | `git ls-files`, minus vendored, built and minified code |
| `parser.ts` | tree-sitter (JS, TS, TSX grammars as wasm) → raw import specifiers, plus string literals that look like package names (for packages loaded by name) |
| `resolve.ts` | Specifier → internal file, npm package, Node builtin or unresolved; no filesystem access |
| `graph.ts` | Import graph, Louvain clusters, load-bearing ranking, orphans |
| `churn.ts` | One `git log` pass → commits and authors per file |
| `install-scripts.ts` | Lifecycle-script audit and dependency summary |
| `exhume.ts` | Runs all of the above |

## Load-bearing score

```
score = 0.5 × blastRadius / max  +  0.3 × betweenness / max  +  0.2 × log(1 + commits) / max
```

- **Blast radius** counts files that depend on this one, directly or
  transitively, so it measures what breaks if this file breaks. This is
  the main term.
- **Betweenness** (directed, normalised) finds the files that connect
  otherwise separate parts of the codebase.
- **Churn** marks where past maintainers spent their effort, which is
  usually where the bugs and the business logic are.

Each component is returned alongside the score so the ranking can be
explained, and the weights are exported as `SCORE_WEIGHTS`.

## Install-script audit

Hooks that run on `npm install` are checked: `preinstall`, `install`,
`postinstall`, the `prepare` family, and `prepublish` (npm < 5 ran it on
install). Commands are matched against rules (`curl | sh`, eval or base64,
credential paths, raw IPs, PowerShell, `rm -rf ~`, encoded blobs). When a
hook runs `node some/file.js`, that file is checked too. A file that both
makes network calls and spawns processes is rated `high`. Well-known steps
such as `node-gyp rebuild` and `husky install` are reported as `info`.

These are heuristics meant to triage, not a malware scanner.
