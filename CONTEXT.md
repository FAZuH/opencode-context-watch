# CONTEXT.md — opencode-context-watch domain model

Ubiquitous language for the plugin. These terms name the seams the code is
split along; use them in code, docs and reviews.

| Term | Meaning |
|------|---------|
| **Session** | An opencode conversation; the unit the plugin watches. All per-session state (`model info cache`, rearm values) is keyed by sessionID. |
| **Context window** | The model's token limit: read from `model.limit.context` in `system.transform` (v1) or resolved through the catalog model lookup (v2). The plugin can also override it via the `windowTokens` config. |
| **Context usage** | How full the window is. Ground truth matches opencode's TUI context meter: the most recent completed assistant message's `input + output + reasoning + cache.read + cache.write`. Never sum `tokens.input` across messages. |
| **Threshold band** | One of two crossing conditions, OR'd: the **percent band** (`usage/window >= warnPercent`) needs a known window; the **tokens band** (`usage >= warnTokens`) is window-independent. |
| **Rearm** | Re-notification rule: a band re-fires the toast + verbose log only after rising `rearmPercent` points or `rearmTokens` tokens since the last notify. The rearm NEVER gates the injection. |
| **Warning injection** | The transient synthetic user message pushed into the current transform's in-memory messages while above a band (`messages.transform` on v1, `session.hook("context")` on v2). Never persisted, so it must be pushed on EVERY hook call above threshold. |
| **Compaction** | Freeing context by summarizing the session. Triggered by the agent through the `compact_context` tool. |
| **Compaction strategy** | One way to compact, behind the `CompactStrategy` seam: `V2CompactStrategy` (awaited) then `V1SummarizeStrategy` (raced against a timeout to avoid the session-loop self-deadlock) on v1; `V2BetaCompactStrategy` (own client, never throws) on v2. A `Compactor` orchestrates the fallback chain and the agent-facing result string. |
| **Post-compaction message** | The real, persisted user message sent after compaction when `postCompactContinue` is on; the autocontinue hook always suppresses opencode's synthetic continue. |
| **Live config state** | The mutable `LiveConfig` in `src/live.ts`: the resolved options object is mutated in place on `reload` so every per-event hook reference stays live; `enabled` is a config-backed gate (the settings tool's disable/enable persist it to the config file); `notifyFlags` is shared with the `Notifier`. |
| **Settings tool** | The `context_watch_settings` tool (actions `reload`/`disable`/`enable`/`status`); the live command surface for reloading config or disabling the context warning without an opencode restart. The TUI command-palette commands are a second surface over the same state: they write the config file, and the config-file watcher applies the change. |
| **Model info cache** | Per-session repository of `{ window, providerID, modelID }`: captured in `system.transform` (v1) or resolved through the catalog (v2). Consumed by the transform (window) and the compactor (provider/model). |
| **Config problem** | A `{ key, message }` validation failure from `resolveOptions`; surfaced as an always-on error toast and app log. |

## Module map

| Module | Responsibility |
|--------|----------------|
| `src/index.ts` | Entry: the plain-object `{ id, server, setup }`; the loader contract selects the backend. |
| `src/backend/types.ts` | Backend seams (`BackendSeams`) and the state-first `RuntimeBackend` port (`live: LiveConfig`). |
| `src/backend/v1.ts` | `V1Backend`: v1 hooks (messages.transform, system.transform, autocontinue, compact_context, context_watch_settings) onto the port. |
| `src/backend/v2.ts` | `V2Backend`: v2 events (session.hook, event.subscribe, catalog.transform, tool.transform, session.prompt, context_watch_settings) onto the port. |
| `src/live.ts` | Live config state: `LiveConfig`, the `handleSettingsAction` switch, shared tool constants, the `settingsSummary` text shared by tool status and TUI status. |
| `src/config.ts` | Resolve options from file + env (+ v2 `ctx.options` overlay) with per-key fallback; report problems. Also `readConfigFile`/`updateConfigFile`: the TUI-side atomic read-modify-write of the config file. |
| `src/watch.ts` | Config-file watcher: parent-dir watch + basename filter + debounce, feeding live reloads into both backends. |
| `src/tui.ts` | TUI command-palette plugin (`{ id, tui }` entry): four context-watch commands that read/write the config file directly (the file is the bridge to server-side live state). |
| `src/context.ts` | Pure context-usage assessment (`contextTokens`, `assess`, `renderMessage`); the shared `notifyWarning` helper and `tokensFromUsage`. |
| `src/model-info.ts` | Per-session model metadata repository (`ModelInfoCache`). |
| `src/warning.ts` | Build the transient synthetic warning message. |
| `src/compaction.ts` | Compaction strategies (`V2CompactStrategy`, `V1SummarizeStrategy`, `V2BetaCompactStrategy`), the `Compactor`, and the post-compaction resume. |
| `src/notify.ts` | TUI toast + app log behind one `Notifier` seam. |

`zod@^4.1.8` is now a runtime dependency (used for the v1 settings-tool args).
