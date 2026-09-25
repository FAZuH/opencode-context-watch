# opencode-context-watch

Warn when a session's context window usage crosses a configurable threshold. An
[OpenCode](https://opencode.ai) **V2** plugin that injects a warning into the
conversation, so the agent wraps up the current step or prepares for compaction
before the window is full.

## Install

Add the package to `opencode.json`; opencode hands its `options` object to the
plugin:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/opencode-context-watch",
      "options": {
        "warnPercent": 0.7
      }
    }
  ]
}
```

`package` takes the package name once it is published, or a path to a clone or
symlink of this repository while you develop it. Restart opencode after editing
`opencode.json`.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `warnPercent` | `0.77` | 0..1, or percent (e.g. `77`) if > 1. Warn when usage reaches this fraction of the model window |
| `warnTokens` | `150000` | Warn when the session reaches this many tokens |
| `windowTokens` | — | Override the model's context window |
| `rearmPercent` | `5` | Log again after this many percentage-point rise |
| `rearmTokens` | `5000` | Log again after this many more tokens |
| `verbose` | `false` | Log every context warning to the service log |
| `message` | — | Template; placeholders `{percent}` `{tokens}` `{window}` |

A bad value falls back to its default; the other options still apply. The
problem is written to the OpenCode service log with `console.error`, as
`[context-watch] <key>: <what is wrong>`. Headless `opencode2 run
--print-logs` does not print plugin console output, so you only see these lines
in a service log or terminal run.

## How it works

- On load the plugin reads the model list and remembers each model's context
  window.
- It listens for `session.step.ended` and keeps the token usage of the last
  completed step per session. That sample — `input + output + reasoning +
  cache.read + cache.write` — is the same number opencode's context meter shows.
  Cumulative `session.usage.updated` events are ignored on purpose.
- On every model request above a threshold it appends a synthetic user message
  to the request, so the model reads the warning as part of the conversation.
  The message is never stored, so it is added on every above-threshold request,
  not just the first.
- `rearmPercent` and `rearmTokens` only limit how often the service log repeats.

Notes:

- Either threshold can fire first; both can be active at once.
- The percent band needs a known window. Without one only the token band
  applies, and `{percent}`/`{window}` render as `0`/`unknown`.
- The first one or two model requests of a session cannot warn. OpenCode
  publishes a step's token usage after the next request has already been
  assembled, so on a cold start there is no sample yet. After that, every
  above-threshold request is warned. That is fine for a "wrap up soon" hint,
  and it is why the plugin does not ask OpenCode for the transcript on every
  request.
- Compaction is opencode's job. The plugin adds no tool of its own.

## Development

```sh
bun install
bun test
npx tsc --noEmit
npx tsc -p tsconfig.test.json --noEmit
bunx biome format --write .
bunx biome check --write .
bun build src/index.ts --outdir dist
```

## License

MIT
