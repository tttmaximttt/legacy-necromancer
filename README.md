# ☠ Necromancer

Revive abandoned JavaScript and TypeScript projects.

Point it at an old repo and it maps the code, tells you which dependencies
are dead, asks what the project was for, rebuilds and starts it in Docker on
the Node version from its time, and records how its routes behave so you can
upgrade it without breaking anything.

## Getting started

You need Node 22+ and git. `resurrect` and `witness` also need Docker running.
An Anthropic API key is optional: it lets Claude write fixes and test
inputs. [Setting your API key](#setting-your-api-key) shows where it goes.

### In Claude Code (plugin)

```text
/plugin marketplace add tttmaximttt/legacy-necromancer
/plugin install necromancer@legacy-necromancer
```

Restart Claude Code, then try:

```text
/necromancer:autopsy https://github.com/tttmaximttt/node-orm2
/necromancer:interview https://github.com/tttmaximttt/node-orm2
/necromancer:resurrect https://github.com/tttmaximttt/node-orm2
/necromancer:witness https://github.com/tttmaximttt/node-orm2
```

Or just ask in plain words: "exhume this repo and tell me if it's worth
reviving".

The plugin starts the MCP server with `npx`, which downloads the package the
first time. On a slow connection that can take longer than Claude Code waits
for a server to start, and `/mcp` shows it as failed. Wait a minute and
reconnect it from `/mcp`, or start Claude Code once with
`MCP_TIMEOUT=120000 claude`. You can also install it up front with
`npm install -g legacy-necromancer`, which makes every start instant.

### In Claude Code (MCP server only)

```sh
claude mcp add necromancer -- npx -y legacy-necromancer mcp
```

Claude Desktop and other clients are covered in the
[MCP README](packages/mcp/README.md).

### From the terminal

```sh
npx legacy-necromancer autopsy https://github.com/tttmaximttt/node-orm2 --open
```

or install it once with `npm install -g legacy-necromancer` and run
`necromancer <command>`. A typical session:

```sh
necromancer autopsy <repo> --open   # map + dependency graveyard, opens the UI
necromancer interview <repo>        # confirm what the project is for
necromancer resurrect <repo>        # get it running in Docker
necromancer witness <repo>          # record how it behaves
# ...upgrade something...
necromancer witness <repo> --check  # did the behaviour change?
```

Reports are saved in `~/.necromancer/reports`, and `necromancer ui` browses
them. `autopsy` opens it straight away:

![Architecture map of node-orm2](docs/screenshots/architecture.png)

![Dependency graveyard of node-orm2](docs/screenshots/graveyard.png)

## Setting your API key

Three commands call Claude: `interview` asks what the project is for,
`resurrect` asks for a fix when no known fix applies, and `witness` asks
for test requests. Everything else works without a key, and so do these
three, just with less help:

- `interview` in the terminal needs the key to make a proposal (answering a
  saved one with `--reuse` doesn't). Through the MCP server it doesn't: the
  Claude you're talking to writes the proposal instead.
- `resurrect` only tries the known fixes.
- `witness` sends one placeholder request per route.

Create a key at [platform.claude.com](https://platform.claude.com/settings/keys).
Calls are billed to that API account, not to a Claude subscription.

Necromancer takes the first key it finds here:

1. `NECROMANCER_ANTHROPIC_API_KEY` in its environment (the plugin setting
   ends up here)
2. `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN`, in its environment
3. the same variables in the file `~/.necromancer/.env`

Only that one key is used. `ANTHROPIC_BASE_URL` is read from the same place
as the key, so a key from your shell is never sent to a gateway set in the
file, or the other way round.

### One file for everything

The file works the same way for the terminal, the plugin, the MCP server and
Claude Desktop, so it's the simplest option:

```sh
mkdir -p ~/.necromancer
touch ~/.necromancer/.env
chmod 600 ~/.necromancer/.env
```

Open it in an editor and add:

```sh
ANTHROPIC_API_KEY=sk-ant-...
```

Variables that are already set in the environment win over the file. Other
settings can go there too, such as `GITHUB_TOKEN` for `graveyard`. Settings
that Node reads when it starts, such as `NODE_USE_ENV_PROXY` or
`NODE_EXTRA_CA_CERTS`, don't work from the file.

### Claude Code plugin

`/plugin install` asks for the key. The field is optional, and it needs
Claude Code 2.1.119 or later (`claude update`). Claude Code
keeps it in secure storage (the macOS Keychain, or `~/.claude/.credentials.json`
on Linux) and passes it only to the Necromancer server. To add or change it
later, run `/plugin configure necromancer@legacy-necromancer` and restart
Claude Code.

Don't export `ANTHROPIC_API_KEY` in the shell you start `claude` from just
for Necromancer. Claude Code would then use that key for itself and bill
your API account instead of your Claude subscription. Use the plugin
setting or the file instead.

### Claude Code, MCP server only

```sh
claude mcp add necromancer -e NECROMANCER_ANTHROPIC_API_KEY=sk-ant-... -- npx -y legacy-necromancer mcp
```

If you already added the server, remove it first with
`claude mcp remove necromancer`. This saves the key in plain text in
`~/.claude.json`. The file above keeps it out of your Claude Code config.

### Claude Desktop

Claude Desktop doesn't pass your shell's variables to servers. Use the file,
or add the key to the server in `claude_desktop_config.json`:

```json
"env": { "NECROMANCER_ANTHROPIC_API_KEY": "sk-ant-..." }
```

### Terminal

```sh
export ANTHROPIC_API_KEY=sk-ant-...
```

That lasts for one shell session. Use the file to keep it. If you also run
Claude Code from that shell, export `NECROMANCER_ANTHROPIC_API_KEY` instead,
for the reason above.

### CI

Save the key as a secret and pass it as a variable. In a GitHub Actions job
on `ubuntu-latest`, which has Docker:

```yaml
- run: npx -y legacy-necromancer resurrect .
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Through an API gateway

If your company sends Anthropic traffic through its own gateway, set
`ANTHROPIC_BASE_URL` to it, plus `ANTHROPIC_AUTH_TOKEN` if it expects a
bearer token instead of a key. Put both in `~/.necromancer/.env` rather than
the shell you start Claude Code from, which would point Claude Code at the
gateway too. The gateway has to pass requests to Anthropic unchanged,
including beta headers and the model name `claude-opus-5-5`. Other
providers, such as Bedrock, Vertex or OpenAI, aren't supported yet.

## Commands

| Command | Does |
| --- | --- |
| `autopsy <repo> [--open]` | `exhume` + `graveyard`, saves both, optionally opens the UI |
| `exhume <repo> [--save]` | Architecture report (JSON) |
| `graveyard <repo> [--save]` | Era and dependency report (JSON) |
| `interview <repo>` | Claude proposes what the repo is for, with file:line evidence; you confirm or correct it and pick goals |
| `resurrect <repo>` | Builds and boots it in Docker on its era's Node, fixing failures until it runs or is `BLOCKED` |
| `witness <repo> [--check]` | Calls every route on the revived app and records normalized golden snapshots, runs its tests; `--check` compares a new run |
| `ui [--open]` | Serves the UI over saved reports on localhost |
| `mcp` | Runs the MCP server on stdio, for Claude Code or any MCP client |

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

## `necromancer interview <git-url | path>`

Before anything gets revived, someone has to say what the project is for.
`interview` shows Claude the README, the manifest, the entry points, the
load-bearing files from `exhume` and one file per cluster, with line
numbers, and asks for a structured answer: a summary, what the project
does, what a revival must keep working, suggested goals and open questions.
Every claim cites `file:line` and quotes the lines. Necromancer then checks
each quote against the repo: quotes on the wrong lines are moved, and
quotes it can't find are marked "not found" and flagged.

You then confirm the summary or replace it with your own words, pick
suggested goals by number and add your own. Later stages read the result
(`intent` and `goals` in `interview.json`).

```sh
export ANTHROPIC_API_KEY=…   # or see "Setting your API key"
necromancer interview https://github.com/tttmaximttt/node-orm2              # asks interactively
necromancer interview --reuse <repo> --yes --accept-goals 1,2 --goal "…"   # or answer with flags
```

It uses `claude-opus-5-5` at medium effort by default (`--model`,
`--effort`). If the model declines, the API retries once on Anthropic's
recommended fallback model (`--no-fallbacks` turns that off), and the
report notes which model answered. Through MCP, the `interview` tool works
without an API key too: the agent you're talking to gets the evidence and
writes the proposal itself, and `record_interview` checks its citations the
same way. Details are in the [package README](packages/interview/README.md).

## `necromancer resurrect <git-url | path>`

Builds the project in Docker on the Node version of its era, with its
databases alongside, and boots it until its port answers. A 2017 Express
and Mongoose app gets `node:6` and `mongo:3.4`. When a step fails, the
next change comes from a table of known fixes (node-gyp needing Python,
node-sass, end-of-life Debian mirrors, phantomjs downloads, peer
dependencies…), then from fixes the model found for the same error before,
then from Claude. It stops after 10 attempts, at a token budget, or when no
fix applies, with `BLOCKED: <reason>`.

```sh
necromancer resurrect https://github.com/owner/old-app --out-dir ./revived
```

`--out-dir` also writes `Dockerfile.necromancer` and
`docker-compose.necromancer.yml` with the same limits, for running it
yourself. Without `ANTHROPIC_API_KEY` only known fixes are tried
(`--no-llm` forces that). The exit code is 2 when blocked. Details,
including the sandbox, are in the [package README](packages/resurrect/README.md).

## `necromancer witness <git-url | path>`

Boots the app the way `resurrect` got it running and calls every route that
`exhume` found. Claude writes the requests from the handler code (one to
three per route), or each route gets one placeholder request without
`ANTHROPIC_API_KEY`. The responses are saved as golden snapshots, with
timestamps, ids, tokens and anything else that changes between two
identical requests blanked. The project's own `test` script runs next to the
app.

```sh
necromancer witness https://github.com/owner/old-app
# later, after changing something:
necromancer witness https://github.com/owner/old-app --check
```

`--check` re-sends the saved requests, prints what changed (status, headers,
body, tests), exits 1 on any difference, and keeps the golden snapshots.
Details are in the [package README](packages/witness/README.md).

## Safety

Excavate only reads. It never installs dependencies or runs repo code.
Resurrect does run repo code, including install scripts, but only in
containers: no host mounts, no credentials, network only while installing,
and CPU, memory, process and time limits on everything.
Witness runs the app in the same sandbox and sends requests to it from
inside. Interview sends the files it picked (up to about 2,400 lines) to the
Anthropic API, and Witness sends about 30 lines around each route handler;
don't run them on code you can't share with it. Don't point any of it at
shared environments or production.
