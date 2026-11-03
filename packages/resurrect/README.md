# @necromancer/resurrect

Phase 5. Gets an abandoned project installing, building and booting again,
inside Docker, on the Node version of its era.

## What it does

1. **Dates the build.** The Node image comes from `.nvmrc` if there is one.
   Otherwise it's the LTS line people deployed at the project's era (from the
   `graveyard` report, or the last commit), moved to the nearest line that
   `engines.node` allows. A project last touched in September 2017 gets
   `node:6`.
2. **Finds its services.** Dependencies such as `mongoose`, `redis` or `pg`,
   and connection strings in the source, add a database container pinned to
   the same era (`mongo:3.4`, `redis:4.0`, `postgres:9.6`…). The services
   share the app's network namespace, so old code that connects to
   `localhost:27017` works unchanged. `process.env` names that look like
   their URL, host or port are set.
3. **Writes a recipe**, not a Dockerfile. Fixes are ops on the recipe
   (`setNodeImage`, `aptInstall`, `setDependency`, `addInstallFlags`…), each
   validated: only official `node` image tags, no variables that look like
   credentials, one-line commands. The Dockerfile and a compose file are
   rendered from it. The repo is never edited; dependency changes go into
   the build copy's `package.json` and are listed at the top of the
   Dockerfile.
4. **Loops.** Each attempt runs `docker build` (install only), the build
   script, and then boots the app until its port accepts a connection. A
   library has no start command, so it passes if `require('.')` loads. After
   a failure, the next change comes from:
   1. the **known-fix table** (`KNOWN_FIXES`): Debian archive mirrors,
      node-gyp needing Python, node-sass, fibers on Node 16+, phantomjs
      downloads, git over SSH, husky, peer dependencies, lockfile
      integrity, unpublished versions, OpenSSL 3 and webpack 4, yarn, bower;
   2. the **fix cache**: fixes the model found before, keyed by an error
      signature that ignores paths, versions and numbers
      (`~/.necromancer/fix-cache.json`);
   3. the **model**: Claude gets the log tail, the recipe, what was already
      tried, the project's intent and goals from the interview the run
      started with, and the owner's decisions so far. It
      returns ops to try, a question for the owner when only they can
      settle it, or `blocked` with a reason when nothing anyone could say
      would fix it.

   The loop stops with `BLOCKED: <reason>` when nothing applies, the model
   says so, the same error survives two fixes, the attempts run out
   (default 10), the token budget is spent (default 150,000), the model
   asks a fourth question about one failure after the owner answered three,
   or the owner declined three fixes for one failure. A fix is never dropped
   without being shown: approving one doesn't count against either limit.

## The owner's part

Some fixes change the project rather than the sandbox, so they wait for the
owner's OK, whichever source they came from. These are risky:

- moving to another Node major (for 0.x, another release line: 0.10 to 0.12
  counts), or to a tag with no version in it, like `lts` or `argon`;
- changing the base image's variant on the same Node line (`16` to
  `16-alpine`, `10.24-stretch` to `10.24-buster`, `0.10` to `0.10-slim`),
  since that changes the OS underneath;
- installing Debian packages, or a package globally;
- changing `package.json` (setting or removing a dependency) or dropping the
  lockfile;
- every install flag except the few on an allow-list (below). Flags with a
  known effect say what it is: they skip install scripts or dependency
  types (`--ignore-scripts`, `--production`, `--omit=…`, `--only=…`,
  `--no-optional`), ignore or rewrite the lockfile (`--no-package-lock`,
  `--no-lockfile`, `--pure-lockfile`…), change TLS checks (`--strict-ssl`,
  `--cafile`), the proxy (`--proxy`, `--https-proxy`) or the registry, skip
  integrity checks (`--force`, `--skip-integrity-check`), or change what
  runs (`--unsafe-perm`, `--script-shell`). Any other flag is shown as
  "changes how packages are installed". A fix can only add flags as single
  `--name` or `--name=value` entries;
- every variable except the few on an allow-list (below). Those with a known
  effect say what it is: `NODE_ENV` (with `production`, npm skips
  devDependencies), every other `NODE_*` (such as `NODE_OPTIONS`,
  `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_PATH`), `npm_config_*`, `yarn_*`,
  `PATH`, `LD_*`, and the proxy variables in any case (`HTTP_PROXY`,
  `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`). Any other is shown as "sets
  `<NAME>` for install, build and run": the variable is in the environment of
  every step, so a name we don't know could change any of them;
- running a command before install, or changing or skipping the build or
  start command.

Applied without asking:

- install flags that only change npm's or yarn's output, or how strictly
  peer dependencies and engines are checked: `--legacy-peer-deps`,
  `--ignore-engines`, `--no-audit`, `--no-fund`, `--no-progress`,
  `--no-color`, `--loglevel=…`, `--network-timeout=…`, `--prefer-offline`,
  `--no-update-notifier` and yarn's `--non-interactive`;
- variables that tune the sandbox or only turn off a hook installer, a
  banner or output: `PORT`, `HOST`, `CI`, `TZ`, `LANG`, `LC_ALL`, `HUSKY`
  and `HUSKY_*`, `ADBLOCK`, `DISABLE_OPENCOLLECTIVE`, `OPENCOLLECTIVE_HIDE`,
  `NO_UPDATE_NOTIFIER`, `NO_COLOR`, `FORCE_COLOR`, `bower_allow_root`, and
  `npm_config_loglevel`, `_progress`, `_fund`, `_audit`, `_update_notifier`
  and `_color` (in any case, as npm reads them). Names are matched exactly
  otherwise: `husky` is not `HUSKY`;
- the port, and a newer or older version of the same Node line and image
  variant (`10-stretch` to `10.24-stretch`);
- the Debian archive mirrors (`useDebianArchive`): it only points apt at
  archive.debian.org, Debian's own archive, for a release that is
  end-of-life, where the regular mirrors no longer have it.

Of the known fixes, only `debian-archive`, `husky`, `peer-deps` and
`yarn-engines` go through without asking. `phantomjs-cdn` asks, since it
sets `PHANTOMJS_CDNURL`, which changes where a binary is downloaded from.

When the owner declines a fix, the loop looks for another one. A declined
fix is not offered again for the rest of the run, for this failure or any
later one, whichever source it would come from. Fixes are matched by their
effect on the recipe: optional fields count as their defaults (`dev` as
false), apt packages and install flags count as one set however they are
split across ops or ordered, a repeated op counts once, of the ops that set
one thing (the image, a variable, a dependency, a command, the port) only
the last counts, and the order of the ops doesn't matter, except for the
commands run before install, which run in sequence. So the model can't
bring back a declined known or cached fix in another form: the `node-sass`
fix (`removeDependency node-sass`, `setDependency sass ^1.32.0`) stays
declined when the model proposes `setDependency sass ^1.32.0` then
`removeDependency node-sass`. A fix declined before a pause stays declined
after `--resume`, even when risky fixes are otherwise applied without
asking. When the model asks a question, the owner's answer goes into the
next request. From the first answer on, no model fix from that run goes
into the shared fix cache, since any of them may rest on a choice about
this project.

With nobody to ask (no terminal, or the MCP host's turn ended), the run
stops as `needs-you` and the report holds the pending fix or question and
the state to carry on from. `resurrect --resume` with an approval, a
rejection or an answer continues with the next attempt as the same run: the
attempt count and limit, the token spend and budget, the model (or known
and cached fixes only), the sandbox limits, the CA file, the sandbox setup
(build proxy, health timeout), whether images are kept, the workdir, the
era, the services, what the model is told of the interview (the project's
intent and the owner's goals, saved with the paused run) and the fixes
already declined all come from the paused run, never from the options or
reports of the resuming call. A resume can set a new attempt limit, token
budget, sandbox limits, sandbox setup, model (or none), image cleanup or
workdir; what it sets is saved again if the run pauses later. Either way it
gets at least one attempt to try the fix it settles on.

`resumeSettings` and `checkResumable` return the settings the resumed run
will have, so a front-end can build its sandbox and the model they name
(none when it is null) the same way. `checkResumable` checks a saved report
before anyone is asked anything, and throws a `ResumeError` whose `code`
says what is wrong, so a front-end can say what to change:

| code | the resume |
|---|---|
| `not-paused` | is of a run that did not end needs-you |
| `no-state` | is of a needs-you report without the state to carry on from |
| `model-without-budget` | names a model, but its token budget is 0 |
| `budget-spent` | answers a question, and the budget is spent |
| `no-model` | answers a question, and its settings name no model |
| `model-null` | is handed no model, and its settings name one |
| `model-mismatch` | is handed a model its settings don't name |
| `wrong-kind` | approves a pending question or answers a pending fix |
| `needs-approve` | has no approve true or false for a pending fix |
| `needs-answer` | has no answer for a pending question |

`resurrect` throws the same errors, and checks the last three too. A resume
handed a sandbox set up differently from its settings (the paused run's,
with any the resume changes) warns. If the repo moved to another commit
since the pause, the report warns that the saved recipe was worked out
against the old one.

## Sandbox

As in the plan's security section:

- Builds and runs only in containers, never on the host.
- No host mounts. The repo is copied into the image.
- No credentials. Variables that look like tokens, secrets or passwords are
  rejected.
- Network access only while installing dependencies (`docker build`). The
  build script and the app run with no network. Services share the app's
  localhost and nothing else.
- Every container has CPU, memory, process-count and time limits (defaults:
  2 CPUs, 2 GB, 512 processes, 15 minutes per step). The app and build steps
  also drop all capabilities and set `no-new-privileges`. Database images
  keep the capabilities they need to switch users.

## Behind a proxy

`--build-proxy` passes the host's `HTTP(S)_PROXY` to the install step, and
`--ca-file` adds a CA for a TLS-intercepting proxy. A proxy on the host's
loopback is only reachable with host networking, which the install step then
uses. Neither ends up in the saved Dockerfile.

## Testing

`Sandbox` is an interface. The loop's tests use a scripted sandbox and
`ScriptedModel`, and `DockerSandbox` is tested against a fake dockerode, so
the suite needs neither Docker nor an API key.
