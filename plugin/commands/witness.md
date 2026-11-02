---
description: Record how a revived app behaves, or check it against the saved snapshots
argument-hint: <git-url-or-path> [check]
---

Arguments: $ARGUMENTS

Call the necromancer `witness` tool on the repo given in the first argument. If the second argument is `check`, pass `check: true`. The repo must have been through `resurrect` first; if it hasn't, offer to run that.

Without check: summarise how many routes were called, anything that errored or returned 5xx, and the project's own test result.

With check: say clearly whether behaviour changed. If it did, list each difference in plain words.
