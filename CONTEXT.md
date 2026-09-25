# CONTEXT.md — opencode-context-watch domain model

Ubiquitous language for the plugin. These terms name the seams the code is
split along; use them in code, docs and reviews.

| Term | Meaning |
|------|---------|
| **Session** | An OpenCode conversation; the unit the plugin watches. All per-session state (cached usage, rearm values) is keyed by `sessionID`. |
| **Context window** | The model's token limit, read from `model.limit.context` in the setup-time model list. `windowTokens` overrides it. |
| **Context usage** | How full the window is: the last completed step's `input + output + reasoning + cache.read + cache.write` (what opencode's context meter shows). Never sum `input` across steps — each step's `input` is the whole context at request time. |
| **Step sample** | The `session.step.ended` usage for a session. Cumulative `session.usage.updated` events are not a sample. No sample yet means no warning. |
| **Threshold band** | One of two crossing conditions, OR'd: the **percent band** (`usage/window >= warnPercent`) needs a known window; the **tokens band** (`usage >= warnTokens`) is window-independent. |
| **Rearm** | Log rule: a band re-logs only after rising `rearmPercent` points or `rearmTokens` tokens since the last log. The rearm NEVER gates the injection. |
| **Warning injection** | The transient synthetic user message appended to the current hook call's message list while above a band. Never persisted, so it is appended on EVERY above-threshold request. |
| **Config problem** | A `{ key, message }` validation failure from `resolveOptions`; console-logged, the key falls back to its default. |
| **Compaction** | Freeing context by summarizing the session. Owned by OpenCode; the plugin registers no trigger for it. |

## Module map

| Module | Responsibility |
|--------|----------------|
| `src/config.ts` | Pure validation of `ctx.options` with per-key fallback; reports problems. |
| `src/context.ts` | Pure usage totals, threshold assessment, warning text, synthetic message. |
| `src/types.ts` | Narrow structural types for the V2 context members the plugin calls. |
| `src/index.ts` | Composition root: model-window map, usage cache, context hook, cleanup. |
