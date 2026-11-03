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
      tried, the interview's goals and the owner's decisions so far. It
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
- installing Debian packages, or a package globally;
- changing `package.json` (setting or removing a dependency) or dropping the
  lockfile;
- install flags that skip safety checks or change where packages come from:
  `--ignore-scripts`, `--force`/`-f`, `--registry`, `--unsafe-perm`;
- variables that change how packages are installed or how Node runs:
  `npm_config_*`, `yarn_*`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_OPTIONS`;
- running a command before install, or changing or skipping the build or
  start command.

Other variables, the port, the Debian archive mirrors, a different image of
the same Node line and flags that only relax resolution
(`--legacy-peer-deps`, `--ignore-engines`) are applied without asking.

When the owner declines a fix, the loop looks for another one and doesn't
offer the declined one again. When the model asks a question, the owner's
answer goes into the next request, and a fix built on that answer is kept
out of the shared fix cache, since it is a choice about this project.

With nobody to ask (no terminal, or the MCP host's turn ended), the run
stops as `needs-you` and the report holds the pending fix or question and
the state to carry on from. `resurrect --resume` with an approval, a
rejection or an answer continues with the next attempt, keeping the attempt
count and limit, the token spend and budget, and the fixes already declined.
A resume can set a new limit or budget; either way it gets at least one
attempt to try the fix it settles on. Answering a question
needs a model, so a resume with an answer and no model fails before
anything runs. If the repo moved to another commit since the pause, the
report warns that the saved recipe was worked out against the old one.

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
