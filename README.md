<div align="center">

# opencode-context-watch

**Warn an OpenCode agent before its context window fills, so it can wrap up or compact in time.**

[![npm](https://img.shields.io/npm/v/opencode-context-watch)](https://www.npmjs.com/package/opencode-context-watch)
[![Release](https://img.shields.io/github/v/release/FAZuH/opencode-context-watch)](https://github.com/FAZuH/opencode-context-watch/releases)
[![License](https://img.shields.io/github/license/FAZuH/opencode-context-watch)](https://github.com/FAZuH/opencode-context-watch/blob/main/LICENSE)

</div>

<hr>

<div align="center">
● <a href="#installation">Installation</a> ﻿ ● <a href="#usage">Usage</a> ﻿ ● <a href="#options">Options</a><br>
● <a href="#how-it-works">How it works</a> ﻿ ● <a href="#docs">Docs</a> ﻿ ● <a href="#license">License</a>
</div>

> [!warning]
> This plugin targets **OpenCode 2.x only**. On OpenCode 1.x it is a silent no-op:
> there is no V1 support and no fallback path. Verified against OpenCode 2.0.16 —
> see [ADR-004](docs/decisions/ADR-004-v2-only-rewrite.md).

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
`opencode.json`. Nothing loads on OpenCode 1.x.

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

### Sidebar

In the TUI the plugin adds a **Context Watch** section to the sidebar for the
session on screen: usage against the model window, the band that will warn, and
whether a compaction is running. The title turns yellow over the band. It reads
its own `context-watch.status` RPC and follows the plugin's `changed` event, so
it needs no other plugin installed.

`/context-watch` toggles the section.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `warnPercent` | `0.77` | 0..1, or percent (e.g. `77`) if > 1. Warn when usage reaches this fraction of the model window. `null` disables this band |
| `warnTokens` | `150000` | Warn when the session reaches this many tokens. `null` disables this band |
| `windowTokens` | — | Override the model's context window |
| `rearmPercent` | `5` | Log again after this many percentage-point rise |
| `rearmTokens` | `5000` | Log again after this many more tokens |
| `verbose` | `false` | Log every context warning to the service log |
| `message` | — | Template with the placeholders `{usage}`, `{percent}`, `{tokens}`, `{window}` |

Either band can fire first, and either can be disabled with `null`. The percent
band needs a known window; without one only the token band applies and `{usage}`
renders the token count alone. `{percent}` and `{window}` still render as `0` and
`unknown` when the window is unavailable.

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
- It listens for `session.compaction.started`, `session.compaction.ended`, and
  `session.compaction.failed`. Warnings are suppressed while compaction runs,
  and the pre-compaction sample and rearm state are dropped when it ends or
  fails, so the first post-compaction request waits for a fresh sample.
- It drops the per-session sample, rearm state, and compacting mark on
  `session.deleted`.
- It registers a read-only `context-watch` RPC when the host has
  `ctx.rpc.register`: `status({ sessionID })` returns the sample, the model
  window, the active bands, and the compacting flag, and `changed` fires on
  every completed step and compaction transition. The window comes from the
  session's model record when the instance answering never ran the context
  hook. The report plugin's sidebar reads it; hosts without RPC registration
  keep the warning path unchanged.
- `rearmPercent` and `rearmTokens` only limit how often the service log repeats
  the warning, never the warning itself.

Two limits worth knowing:

- The first one or two model requests of a session cannot warn. OpenCode
  publishes a step's token usage after the next request has already been
  assembled, so a cold start has no sample yet. After that every
  above-threshold request is warned. The first request after a compaction also
  cannot warn, because the pre-compaction sample is dropped. That is fine for a
  "wrap up soon" hint, and it is why the plugin does not ask OpenCode to
  re-serialize the transcript on every request.
- Compaction is opencode's job. The plugin adds no tool of its own.

## Docs

- [Design and Technical Reference](docs/design.md) — runtime contracts, event ordering, the threshold model, and error handling
- [Architecture decisions](docs/decisions/) — the ADR series, including why the plugin is V2-only
- [Agent and development guide](AGENTS.md) — build commands, `./dev.sh all`, and the verified OpenCode 2.0.16 facts
- [Commit and changelog conventions](docs/dev/commit-changelog.md) — how commits turn into release notes

## License

MIT
