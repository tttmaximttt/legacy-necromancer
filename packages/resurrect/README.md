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
      tried and the interview's goals, and returns ops or `blocked` with a
      reason.

   The loop stops with `BLOCKED: <reason>` when nothing applies, the model
   says so, the same error survives two fixes, the attempts run out
   (default 10) or the token budget is spent (default 150,000).

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
