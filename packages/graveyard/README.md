# @necromancer/graveyard

Phase 2. Dates the project and puts a tombstone on every dependency.

## Date

`dateRemains` combines three kinds of evidence:

- **Git history**: first and last commit. This is the strongest signal.
- **Dependency floor**: for each range in `package.json`, the publish date
  of the lowest version it allows; the newest of those dates is the
  earliest the manifest could have been written. This still works on a
  tarball or a squashed one-commit repo.
- **`engines.node`**: the Node release line it targets.

## Tombstones

Each dependency gets a version, a status, its causes and, where one is
known, a successor.

**Version resolution**, in order:

1. Use the lockfile (`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`).
2. Otherwise (`era`), use the newest version matching the range that was
   published **before the last commit**, which is what `npm install`
   would have picked back then.
3. Otherwise (`latest`), use the newest version matching the range today.

**Status:**

| Status | Causes |
| --- | --- |
| `dead` | deprecated at `latest`, GitHub repo archived, or gone from the registry |
| `dying` | no release in 3+ years |
| `ailing` | known advisories, this version deprecated, or 2+ majors behind |
| `alive` | none of the above |
| `unknown` | the registry lookup failed |

**Successors** come from a curated table (`request` → fetch/undici,
`node-sass` → `sass`, `phantomjs` → Playwright, …) and, failing that, from
the deprecation notice ("use X instead", "renamed to X").

## Data sources

| Source | Used for | Notes |
| --- | --- | --- |
| npm registry | versions, publish times, deprecations, repo URL | |
| npm bulk advisories (default) | vulnerabilities | Same GitHub Advisory Database `npm audit` uses, hosted on registry.npmjs.org |
| OSV.dev (`--advisories osv`) | vulnerabilities | Merges more databases; two round trips |
| GitHub API | `archived` flag | Set `GITHUB_TOKEN` or `GH_TOKEN`. Without one, only packages with no release in 2+ years are checked, to stay under 60 requests an hour |

Lookups that fail show up as `failed` or `partial` in `report.sources`, with
the reason in `warnings`. A missing cause can mean the lookup failed, not
that the package is healthy.
