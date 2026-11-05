# express-era-app

The fixture for `pnpm e2e` (see `e2e/run.mjs`): a tiny Express 4 API from 2018 that targets Node 8. It has two JSON
routes, a deprecated `left-pad` and an Express with known advisories, so the graveyard has dependencies to flag and
surgeon has steps to run without a model. The e2e script copies it to a temp directory and commits it there with a
2018 date, so the era is fixed.
