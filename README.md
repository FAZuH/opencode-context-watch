<div align="center">

# opencode-context-watch

**Warn an OpenCode agent before its context window fills, so it can wrap up or compact in time.**

</div>

<hr>

<div align="center">
● <a href="#installation">Installation</a> ﻿ ● <a href="#usage">Usage</a> ﻿ ● <a href="#options">Options</a><br>
● <a href="#how-it-works">How it works</a> ﻿ ● <a href="#docs">Docs</a> ﻿ ● <a href="#license">License</a>
</div>

## Installation

Add the package to `opencode.json`. Opencode hands the `options` object to the
plugin, so this one edit is the whole install:

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

`package` takes the published package name, or a path to a clone or symlink of
this repository while you develop it. Restart opencode after editing
`opencode.json`.

## Usage

There is no command to run. Once loaded, the plugin watches every session and on
each model request whose context usage is over a threshold it adds a warning to
the conversation:

```
[context-watch] Context window usage is at 78% (102,400/128,000 tokens). The session is getting full: wrap up the current step soon, …
```

The agent reads that as part of the conversation, so it finishes its current step
compactly instead of drifting into a full window. Set `options` to taste, then
restart opencode.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `warnPercent` | `0.77` | 0..1, or percent (e.g. `77`) if > 1. Warn when usage reaches this fraction of the model window |
| `warnTokens` | `150000` | Warn when the session reaches this many tokens |
| `windowTokens` | — | Override the model's context window |
| `rearmPercent` | `5` | Log again after this many percentage-point rise |
| `rearmTokens` | `5000` | Log again after this many more tokens |
| `verbose` | `false` | Log every context warning to the service log |
| `message` | — | Template with the placeholders `{percent}`, `{tokens}`, `{window}` |

Either band can fire first, and both can be active at once. The percent band
needs a known window; without one only the token band applies and `{percent}` /
`{window}` render as `0` / `unknown`.

A bad value falls back to its default and the other options still apply. The
problem is written to the OpenCode service log as
`[context-watch] <key>: <what is wrong>`. Headless `opencode2 run --print-logs`
does not print plugin console output, so those lines only show up in a service
log or a terminal run.

## How it works

- On load the plugin reads the model list and remembers each model's context
  window.
- It listens for `session.step.ended` and keeps the token usage of the last
  completed step per session. That sample — `input + output + reasoning +
  cache.read + cache.write` — is the number opencode's own context meter shows.
  Cumulative `session.usage.updated` events are ignored on purpose.
- On every model request over a threshold it appends a synthetic user message to
  that request. The message is never stored, which is why it is added on every
  above-threshold request rather than only the first.
- `rearmPercent` and `rearmTokens` only limit how often the service log repeats
  the warning, never the warning itself.

Two limits worth knowing:

- The first one or two model requests of a session cannot warn. OpenCode
  publishes a step's token usage after the next request has already been
  assembled, so a cold start has no sample yet. After that every
  above-threshold request is warned. That is fine for a "wrap up soon" hint, and
  it is why the plugin does not ask OpenCode to re-serialize the transcript on
  every request.
- Compaction is opencode's job. The plugin adds no tool of its own.

## Docs

- [Design and Technical Reference](docs/design.md) — runtime contracts, event ordering, the threshold model, and error handling
- [Architecture decisions](docs/decisions/) — the ADR series, including why the plugin is V2-only
- [Agent and development guide](AGENTS.md) — build commands, `./dev.sh all`, and the verified OpenCode 2.0.16 facts
- [Commit and changelog conventions](docs/dev/commit-changelog.md) — how commits turn into release notes

## License

MIT
