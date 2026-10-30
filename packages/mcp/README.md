# @necromancer/mcp

An MCP server that exposes Necromancer to Claude, or any other MCP client,
as tools. Claude decides when to call a stage while you talk to it, for
example "look at this old repo and tell me if it's worth reviving".

The server uses stdio and runs on your machine. It needs `git` on `PATH`.

## Tools

| Tool | What it does |
| --- | --- |
| `exhume` | Phase 1 report: clusters, load-bearing files, history span, external packages, install-script audit, case-mismatched imports. Read-only. |
| `graveyard` | Phase 2 report: era estimate and a tombstone per dependency (dead / dying / ailing / alive, advisories, successor). Read-only; calls the npm registry, the advisory database and GitHub. |

`graveyard` takes `source`, `advisories` (`npm`, `osv` or `none`), `github`
(default true) and `detail`. In `summary` mode, healthy dependencies are
listed by name only. Set `GITHUB_TOKEN` in the server's `env` to check every
dependency's repo for the archived flag.

`exhume` takes `source` (a git URL or local path), `top` (default 5),
`includeTests` (default false) and `detail`. With the default `summary`,
cluster file lists and low-severity findings are trimmed so the report stays
around 5 to 10k characters. With `full`, everything is returned. The server
sends progress notifications while it works.

Both tools save their full report (pass `save: false` to skip), so you can
browse anything Claude dug up with `necromancer ui`.

There is also an `autopsy` prompt that asks Claude to exhume a repo and give
a verdict. In Claude Code it appears as `/mcp__necromancer__autopsy`.

Later stages (`resurrect`, …) become tools here as they are built. They aren't stubbed yet, because a tool that does nothing only
confuses the agent.

## Setup

Build first, from the repo root:

```sh
pnpm install && pnpm build
```

### Claude Code

Inside this repo, it's already configured: the root `.mcp.json` registers the
server, and Claude Code asks you to approve it the first time.

To use it from any directory:

```sh
claude mcp add --scope user necromancer -- node /absolute/path/to/necromancer/packages/mcp/dist/bin.js
```

Check it with `claude mcp list`, or with `/mcp` inside a session.

### Claude Desktop

Open **Settings → Developer → Edit Config** and add the server to
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "necromancer": {
      "command": "node",
      "args": ["/absolute/path/to/necromancer/packages/mcp/dist/bin.js"]
    }
  }
}
```

Restart Claude Desktop. If the tool fails with `spawn git ENOENT` or
`spawn node ENOENT`, the app can't see your shell's `PATH`. Use the absolute
path to `node` as the `command` (`which node`), and add
`"env": { "PATH": "/usr/local/bin:/usr/bin:/bin" }`, adjusted to wherever
`git` lives.

### Behind a proxy

MCP clients start servers with a minimal environment, so proxy variables
from your shell don't reach Necromancer. If `graveyard` says it could not
reach the npm registry, pass them explicitly in the server config, for
example `"env": { "HTTPS_PROXY": "http://proxy:3128", "NODE_USE_ENV_PROXY": "1" }`.
`NODE_USE_ENV_PROXY` makes Node's built-in `fetch` honour the proxy
(Node 22.21+ / 24+).

### Options

| Env var | Default | Meaning |
| --- | --- | --- |
| `NECROMANCER_WORKDIR` | OS temp dir | Where remote repos are cloned (deleted after each call) |
| `GITHUB_TOKEN` / `GH_TOKEN` | unset | GitHub API token for the archived check; without one only quiet packages are checked |
