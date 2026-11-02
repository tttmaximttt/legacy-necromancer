---
description: Rebuild and start an old repo in Docker on the Node version from its time
argument-hint: <git-url-or-path>
---

Call the necromancer `resurrect` tool on $ARGUMENTS. It needs Docker running on this machine and takes a few minutes.

When it finishes, tell me whether it came back to life. If it did, say which Node image and databases it runs on and which fixes it needed. If it's BLOCKED, give the reason and the last error, and suggest what I could change by hand. Offer to show the generated Dockerfile and compose file.
