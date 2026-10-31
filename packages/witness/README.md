# @necromancer/witness

Phase 6. Records how the revived app behaves today, so that any later change
(a dependency upgrade, a Node bump, a refactor) can be checked against it.

## What it does

1. **Finds the routes.** Exhume extracts them from the source: Express,
   Restify, Koa-router and Hapi registrations, `.route('/p').get().post()`
   chains, and routers mounted with `app.use('/api', router)`, including
   routers required from other files. At most 80 routes are exercised.
2. **Writes the requests.** With a model, Claude reads about 30 lines of
   each handler and writes one to three requests per route: the normal case,
   then the most telling edge case. `Authorization` and `Cookie` headers are
   dropped, cases for routes that don't exist are dropped, and routes it
   skipped get a default. Without a model, each route gets one request with
   path parameters set to `1` and an empty JSON body for writes.
3. **Boots the app** from Resurrect's saved recipe, with its era databases,
   under the same sandbox (see [resurrect](../resurrect/README.md#sandbox)).
4. **Sends the requests from inside the sandbox.** A small ES5 script runs
   with the app image's own `node` in the app's network namespace, so it
   works on every Node from 0.10 and the app stays off the network. GET and
   HEAD requests are sent twice.
5. **Normalizes the responses.** Timestamps, UUIDs, Mongo ObjectIds, JWTs and
   long hashes are blanked wherever they appear; JSON keys that name ids,
   times or secrets (`userId`, `createdAt`, `token`…) are blanked by key.
   Only headers that carry behaviour are kept (`content-type`, `location`,
   `cache-control`, CORS, `www-authenticate`…); `set-cookie` keeps only the
   cookie names. Anything that still differs between the two sends of a safe
   request is marked `<volatile>`.
6. **Runs the project's tests** with its package manager, next to the running
   app so tests that expect a database on localhost find one, and keeps the
   summary line (Mocha, Jest, Vitest, tap, AVA) and the log tail. The npm
   placeholder `test` script is skipped.

The result is a `WitnessReport`: the snapshots, the volatile paths, the test
run and warnings.

## Checking against it

`compareWitness(golden, current)` lists differences in status, kept headers,
body, connection errors, missing or new requests, and the tests going from
passing to failing. Volatile paths from the golden run are ignored. To make
a fair comparison, re-send the golden requests with `cases`:

```ts
const again = await witness(source, { sandbox, resurrect, cases: golden.snapshots.map((s) => s.case) });
const differences = compareWitness(golden, again);
```

`necromancer witness --check` and the MCP tool's `check: true` do exactly
this.

## Testing

The suite runs the real request runner against a local HTTP server through
the scripted sandbox, and generates inputs with `ScriptedModel`, so it needs
neither Docker nor an API key.
