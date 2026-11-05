# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Necromancer revives abandoned JavaScript/TypeScript projects. It's a pnpm workspace (Node 22+, ESM, TypeScript project references) that ships as a CLI and MCP server (`legacy-necromancer` on npm) and as a Claude Code plugin.

## Commands

```sh
pnpm install
pnpm build          # tsc -b for all packages, then the Vite UI build
pnpm typecheck      # sources + tests (tsconfig.test.json), then the UI
pnpm test           # vitest, all packages
pnpm vitest run packages/mcp/test/server.test.ts            # one file
pnpm vitest run packages/mcp/test/server.test.ts -t "witness"  # tests whose name matches
pnpm necromancer <command> ...   # run the built CLI (after pnpm build)

# npm bundle (needs pnpm build first)
pnpm --filter legacy-necromancer build
pnpm --filter legacy-necromancer smoke

# UI dev server on :5173, proxying /api to a running `necromancer ui` (port 4173, or $NECROMANCER_PORT)
pnpm --filter @necromancer/ui dev
```

CI (`.github/workflows/ci.yml`) runs install, build, typecheck, test, the bundle build and smoke, then `node .github/scripts/plugin-version.mjs check`. There is no linter.

Vitest aliases every `@necromancer/*` import to `packages/*/src/index.ts`, so tests don't need a build. `vitest.config.ts` also clears the Anthropic key variables and points `HOME` at an empty directory, so tests never reach the real API. Keep it that way: tests inject models and sandboxes instead.

## Architecture

The product is a pipeline of stages. Each stage is its own package, and each writes a report type defined in `packages/core/src/types.ts`:

1. **excavate** (`exhume`): clones or reads the repo. It parses imports with web-tree-sitter (`.wasm` grammars), builds an import graph with graphology (Louvain clusters with a seeded RNG, so results are deterministic), and adds git churn and an install-script audit. Read-only: it never installs or runs repo code.
2. **graveyard**: dates the project and checks every dependency against the npm registry, advisories (npm or OSV) and GitHub.
3. **interview**: collects evidence (README, manifest, entry points, load-bearing files), gets a proposal of what the project is for, and checks every `file:line` citation against the repo. The proposal comes from Claude, or from the MCP host when there is no key.
4. **resurrect**: builds and boots the app in Docker on its era's Node version, with database sidecars. A failure is fixed from a table of known fixes (`fixes.ts`), then a fix cache, then the LLM (`agent.ts`), within iteration and token budgets. The build state is a `BuildRecipe` that changes through validated ops (`recipe.ts`) and is rendered to a Dockerfile and compose file.
5. **witness**: boots the resurrected app and records normalized golden snapshots of every route. `--check` replays those requests and diffs the responses (`compare.ts`).
6. **surgeon**: plans upgrade steps (dead, dying and ailing dependencies, then Node) and tries each on a copy of the resurrect recipe: an inner `resurrect` with at most one fix, then a witness replay of the golden requests. A step is kept only when nothing differs, and rolled back otherwise. It stops blocked when a budget runs out, and needs-you (resumable) when a fix waits on the owner.

Later stages build on earlier ones through `ReportStore` (`core/src/store.ts`). Reports are saved as `~/.necromancer/reports/<slugFor(source)>/<kind>.json` (or `$NECROMANCER_REPORTS`), and each stage loads the saved reports for the same source. For example, `witness` needs a saved `resurrect` report.

Shared building blocks:
- **llm**: the `StructuredModel` interface. `ClaudeModel` returns zod-validated structured output and maps SDK errors to `LlmError` kinds. Tests use `ScriptedModel`. `findCredentials()` picks one key, in this order: `NECROMANCER_ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, first in the environment, then in `~/.necromancer/.env` (read by `core/src/env.ts`). The key is passed straight to the SDK client and never copied into `process.env`. `ANTHROPIC_BASE_URL` comes from the same place as the key.
- **resurrect `Sandbox`**: an interface whose real implementation is `DockerSandbox` (dockerode). Tests use `FakeSandbox` (`packages/resurrect/test/helpers.ts`). Containers only get the env the code builds explicitly: no host mounts, network only during install, resource limits on every step.

Front-ends: **cli** (commander, plus `server.ts`, a localhost-only server for the saved reports and the UI) and **mcp** (`@modelcontextprotocol/sdk`, stdio). Both wrap the same stage functions, so a change to a stage's options or output usually needs both updated. MCP tools return summaries (`summarize`, `summarizeGraveyard`) to keep the agent's context small. **ui** is a React + sigma browser app that reads the CLI server's `/api/reports`. It must only import *types* from `@necromancer/core`, because the core index pulls in `node:fs`.

## Packaging and release

- `packages/legacy-necromancer/build.mjs` bundles `packages/cli/dist/bin.js` and all workspace packages into one file with esbuild, and copies the UI build and the tree-sitter `.wasm` grammars next to it. Third-party dependencies stay external. The script fails unless every runtime dependency of the bundled packages appears in `packages/legacy-necromancer/package.json` with the exact range the workspace uses. When you add or bump a dependency in any package, mirror it there. The tree-sitter grammar packages stay devDependencies.
- Releasing: push a `v<version>` tag on main that matches `packages/legacy-necromancer/package.json`. `release.yml` checks the tag and reruns the CI steps, including the bundle build and smoke; it does not publish. The owner publishes to npm by hand (`npm publish` in `packages/legacy-necromancer` after the bundle build). Don't add an npm token or a publish step to CI.
- The plugin (`plugin/`, listed in `.claude-plugin/marketplace.json`) runs `npx legacy-necromancer@<pinned version>`. The pin in `plugin/.mcp.json` and `plugin/.claude-plugin/plugin.json` must name a published version (CI checks this). Move it only after a publish, with `node .github/scripts/plugin-version.mjs set <version>`. The plugin passes its optional key setting as `NECROMANCER_ANTHROPIC_API_KEY`.
