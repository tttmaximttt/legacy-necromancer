# legacy-necromancer

Revive abandoned Node.js projects. Point it at a repo and it maps the code, tells you which
dependencies are dead, rebuilds and starts the app in Docker on the Node version from its time,
and records how its routes behave so you can upgrade it safely.

```sh
npx legacy-necromancer autopsy https://github.com/owner/old-app --open
```

Use it from Claude Code:

```sh
claude mcp add necromancer -- npx -y legacy-necromancer mcp
```

Needs Node 22+, git, and Docker for `resurrect` and `witness`. Set `ANTHROPIC_API_KEY` to let Claude
write fixes and request inputs.

Full docs: https://github.com/tttmaximttt/legacy-necromancer
