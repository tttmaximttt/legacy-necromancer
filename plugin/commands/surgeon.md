---
description: Upgrade a revived app one dependency at a time, keeping only upgrades that don't change its behaviour
argument-hint: <git-url-or-path>
---

Call the necromancer `surgeon` tool on $ARGUMENTS. It needs Docker running on this machine and can take a while: every step rebuilds the app and replays its recorded requests. The repo must have been through `resurrect` and `witness` first; if it hasn't, offer to run those.

When it finishes, list the steps it kept, the ones it rolled back (with where they failed and what changed), and the ones it skipped (with the reason). Then give the final status:

- COMPLETE: say which Node image and versions it ends on, and offer to show the final Dockerfile.
- BLOCKED: give the reason and the steps it didn't reach, and say which budget to raise if one ran out.
- NEEDS YOU: show me the fix or question it is waiting on and its choices. Once I've answered, call `surgeon` again with `resume: true` and `approve` (true or false) for a fix, or `answer` for a question. Never approve a fix for me.
