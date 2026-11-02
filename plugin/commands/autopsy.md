---
description: Dig up an abandoned repo and say whether it's worth reviving
argument-hint: <git-url-or-path>
---

Run the necromancer `exhume` and `graveyard` tools on $ARGUMENTS.

From the two reports, tell me:

- what the project is and how it's structured (name the clusters by what they do, not by folder)
- which files are load-bearing and why
- when it was last alive
- which dependencies are dead or dangerous, and what replaces them
- anything risky in its install scripts or imports
- whether it looks worth reviving

Quote numbers from the reports and don't guess beyond them. Finish by mentioning that `necromancer ui` shows the map and the graveyard in the browser.
