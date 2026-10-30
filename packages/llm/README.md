# @necromancer/llm

The model client for stages that need one. It does structured output only:
`generate()` returns a value that matches the zod schema you pass, or throws
an `LlmError` whose `kind` says what went wrong (`credentials`, `refusal`,
`truncated`, `unparsed`, `rate_limit`, `overloaded` or `api`).

- `ClaudeModel` calls the Anthropic Messages API with the official SDK. It
  defaults to `claude-opus-5-5` with adaptive thinking, an explicit effort
  (`medium` unless the caller asks for more), and the schema as
  `output_config.format`. Server-side fallbacks are on: if the model
  declines, the API retries on Anthropic's recommended fallback model, and
  the result's `model` and `fellBack` say which one answered. Pass
  `fallbacks: false` to turn that off. Credentials come from
  `ANTHROPIC_API_KEY`.
- `ScriptedModel` replays canned answers (values, functions of the request,
  or errors) and validates them against the schema. Tests use it, so no API
  key or network is needed.
