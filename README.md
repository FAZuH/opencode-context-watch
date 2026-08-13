# opencode-context-watch

Warn when a session's context window usage crosses a configurable threshold. An [opencode](https://opencode.ai) plugin that injects a warning into the conversation so the agent can wrap up the current step or prepare for compaction before the window is full.

## Install

Install locally for the current OpenCode project:

```bash
opencode plugin opencode-context-watch
```

Install globally:

```bash
opencode plugin -g opencode-context-watch
```

OpenCode detects both package entrypoints and writes the plugin into the server and TUI config targets.

## Configuration

Config file (optional): `~/.config/opencode/opencode-context-watch.json`

```json
{
  "warnPercent": 0.75,
  "warnTokens": 150000,
  "rearmPercent": 2,
  "postCompactContinue": true,
  "postCompactMsg": "[context-watch] Session context was compacted. Continue your work from where you left off, keeping replies concise.",
  "message": "[context-watch] Context window usage is at {percent}% ({tokens}/{window} tokens). The session is getting full: wrap up the current step soon, keep replies concise, avoid re-reading large files, and be ready to prepare for compaction if you continue."
}
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `warnPercent` | `0.77` | 0..1, or percent (e.g. 77) if > 1. Warn when usage reaches this fraction of the model window |
| `warnTokens` | `150000` | Warn when session reaches this many tokens |
| `rearmPercent` | `5` | Re-warn after this many percentage-point rise |
| `rearmTokens` | `5000` | Re-warn after this many more tokens |
| `toast` | `true` | Show a TUI toast when a band is crossed |
| `verbose` | `false` | Log context estimates to the opencode log |
| `message` | — | Template; placeholders `{percent}` `{tokens}` `{window}` |
| `postCompactContinue` | `false` | Send a message after compaction |
| `postCompactMsg` | `[context-watch] Session context was compacted. Continue your work from where you left off, keeping replies concise.` | Text of the post-compaction message |

### Env overrides

`CONTEXT_WATCH_PERCENT`, `CONTEXT_WATCH_TOKENS`, `CONTEXT_WATCH_WINDOW`, `CONTEXT_WATCH_REARM`, `CONTEXT_WATCH_REARM_TOKENS`, `CONTEXT_WATCH_MESSAGE`, `CONTEXT_WATCH_NO_TOAST`, `CONTEXT_WATCH_POST_COMPACT_CONTINUE`, `CONTEXT_WATCH_POST_COMPACT_MSG`

### Notes

- The warning fires when **either** threshold is crossed (whichever comes first). Both thresholds can be active at once.
- The percent threshold requires the model window to be known (cached by `system.transform` in the live TUI; pass `CONTEXT_WATCH_WINDOW` when using `opencode run`). When the window is unknown, only the tokens threshold applies; `{percent}`/`{window}` render `0`/`unknown`.
- The plugin reads the config file once at load. To apply changes without restarting opencode, use the `context_watch_settings` tool with `action: reload`. It re-reads the file and env overrides and applies the new values live.
- `disable` is a runtime-only gate. It survives a reload and resets when opencode restarts. It is not a config key.

### Configuration errors

If the config file or an env override is invalid — bad JSON, wrong types, out-of-range values, or unknown keys — the plugin falls back to the default for each bad value and shows a TUI error toast listing exactly what is wrong. The full list is also written to the opencode log. The plugin keeps running with the defaults for the broken keys.

## How it works

- `experimental.chat.messages.transform` reads the real context size from the most recent completed assistant message's provider-reported token counts (the same number opencode's TUI context meter shows), then — when the threshold is crossed — pushes a synthetic user message into `output.messages` so the warning is visible to the model as part of the conversation.
- `experimental.chat.system.transform` caches the model's context window from `model.limit.context` because the messages transform does not receive model info.
- The plugin registers a `compact_context` tool the agent can call to compact its own session when the window is full. When `postCompactContinue` is enabled, a successful compaction posts `postCompactMsg` as a real user message (suppressing opencode's synthetic continue) so the session resumes on the configured instruction. When it is off, no message is sent after compaction.
- The plugin registers a `context_watch_settings` tool for live control, on both runtimes. The `action` argument is one of: `reload` (re-read the config file and env overrides, then apply them live), `disable` (stop warning injection), `enable` (resume warning injection), `status` (show current settings). Tell the model, for example, "reload the context-watch config" or "disable the context warning".

## Development

```sh
./dev.sh format lint typecheck
./dev.sh all
```

## License

MIT
