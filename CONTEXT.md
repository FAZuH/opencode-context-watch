# CONTEXT.md — opencode-context-watch domain model

Ubiquitous language for the plugin. These terms name the seams the code is
split along; use them in code, docs and reviews.

| Term | Meaning |
|------|---------|
| **Session** | An opencode conversation; the unit the plugin watches. All per-session state (`model info cache`, rearm values) is keyed by sessionID. |
| **Context window** | The model's token limit, read from `model.limit.context` in `system.transform`. The plugin can also override it via the `windowTokens` config. |
| **Context usage** | How full the window is. Ground truth matches opencode's TUI context meter: the most recent completed assistant message's `input + output + reasoning + cache.read + cache.write`. Never sum `tokens.input` across messages. |
| **Threshold band** | One of two crossing conditions, OR'd: the **percent band** (`usage/window >= warnPercent`) needs a known window; the **tokens band** (`usage >= warnTokens`) is window-independent. |
| **Rearm** | Re-notification rule: a band re-fires the toast + verbose log only after rising `rearmPercent` points or `rearmTokens` tokens since the last notify. The rearm NEVER gates the injection. |
| **Warning injection** | The transient synthetic user message pushed into the current transform's in-memory messages while above a band. Never persisted, so it must be pushed on EVERY `messages.transform` call above threshold. |
| **Compaction** | Freeing context by summarizing the session. Triggered by the agent through the `compact_context` tool. |
| **Compaction strategy** | One way to compact, behind the `CompactStrategy` seam: `V2CompactStrategy` (awaited) then `V1SummarizeStrategy` (raced against a timeout to avoid the session-loop self-deadlock). A `Compactor` orchestrates the fallback chain and the agent-facing result string. |
| **Post-compaction message** | The real, persisted user message sent after compaction when `postCompactContinue` is on; the autocontinue hook always suppresses opencode's synthetic continue. |
| **Model info cache** | Per-session repository of `{ window, providerID, modelID }`, captured only in `system.transform` (the only hook with model metadata). Consumed by the transform (window) and the compactor (provider/model). |
| **Config problem** | A `{ key, message }` validation failure from `resolveOptions`; surfaced as an always-on error toast and app log. |

## Module map

| Module | Responsibility |
|--------|----------------|
| `src/config.ts` | Resolve options from file + env with per-key fallback; report problems. |
| `src/context.ts` | Pure context-usage assessment (`contextTokens`, `assess`, `renderMessage`). |
| `src/model-info.ts` | Per-session model metadata repository (`ModelInfoCache`). |
| `src/warning.ts` | Build the transient synthetic warning message. |
| `src/compaction.ts` | Compaction strategies, the `Compactor`, and the post-compaction resume. |
| `src/notify.ts` | TUI toast + app log behind one `Notifier` seam. |
| `src/index.ts` | Composition root: adapts opencode hook events to the domain modules. |
