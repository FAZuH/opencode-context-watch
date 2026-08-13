# opencode-context-watch: Design & Technical Reference

An [opencode](https://opencode.ai) plugin that warns the agent when a session's context window usage crosses a threshold, so it can wrap up the current step or prepare for compaction before the window fills.

## Architecture

One package runs on opencode v1 (1.18.x) and opencode v2 (2.0 beta). The entry point is a plain object, not a function:

```ts
export default {
  id: "opencode-context-watch",
  server: async (input, pluginOptions) => createV1Backend(input, pluginOptions),
  setup: (ctx) => V2Backend.create(ctx as V2PluginContext),
};
```

The loader's calling convention selects the backend. No version-detection code runs. The v1 loader calls `server(input, options)` and receives the v1 Hooks object. The v2 loader validates the object, reads `id`, and calls `setup(ctx)`.

Both backends build the same domain core (config, context, model-info, warning, compaction, notify). Each backend adapts its runtime's events, tool registration, and compact client onto the shared `RuntimeBackend` port (`src/backend/types.ts`). The port is state-first: `compact`, `postCompact`, `notifier`, `modelCache`, `lastWarned`, and the optional `seams?`. The domain modules stay version-free.

| Backend | File | Runtime surface it adapts |
|---------|------|---------------------------|
| `V1Backend` | `src/backend/v1.ts` | `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `experimental.compaction.autocontinue`, the `compact_context` tool |
| `V2Backend` | `src/backend/v2.ts` | `session.hook("context")`, `event.subscribe()`, `catalog.transform` (window), `tool.transform`, own `@opencode-ai/client/promise` compact client, `session.prompt` |

Key v2 facts (probe-verified on opencode2 next-17155):

- Context-hook messages carry `content` parts, not the v1-style `parts`; the warning is hand-built to that shape.
- The model window comes from `catalog.transform(draft => draft.model.get(providerID, modelID))`; the draft callback runs synchronously.
- The tool seam is `add({ name, description, input, options: { codemode: false }, execute })`; `execute` must return `{ content: string }`.
- Notification is console-only; the v2 beta has no server-side toast.

### v1 flow (opencode 1.18.x)

The v1 backend hooks two experimental opencode lifecycle events in one turn:

```
model request ──► experimental.chat.system.transform ──► experimental.chat.messages.transform ──► provider
                        │                                          │
                        └─ cache window (per sessionID)             └─ read context tokens,
                             from input.model.limit.context             check thresholds,
                                                                         inject synthetic warning
```

| Hook | Role |
|------|------|
| `experimental.chat.system.transform` | Runs once per turn with model metadata. Caches `input.model.limit.context` (the model's context window) per `sessionID`. This is the ONLY place model info is available under v1. |
| `experimental.chat.messages.transform` | Runs with the fully assembled message list. Computes the current context size, compares against thresholds, and pushes a synthetic user message into `output.messages` so the warning reaches the provider as part of the conversation. |

### Context-size ground truth

`contextTokens()` (`src/context.ts`) walks the message list from the most recent assistant message backwards and returns the first completed one's:

```
input + output + reasoning + cache.read + cache.write
```

This is the same number opencode's TUI context meter shows. Two correctness rules follow from this:

- **Never sum `tokens.input` across messages.** Each assistant message's `tokens.input` is the *whole context at request time* (a snapshot), so summing overcounts badly.
- Skip any assistant message whose `tokens.input` or `tokens.output` is `<= 0` (in-flight/empty) — only a completed message is a valid sample.

### Threshold model: dual band, OR semantics

The plugin warns when **either** band is crossed (`assess` in `src/context.ts`):

- **Percent band** — `tokens / window >= warnPercent`. Requires a known model window; when the window is unknown this band is disabled.
- **Tokens band** — `tokens >= warnTokens`. Absolute, window-independent.

This means `warnPercent: 0.77` with `warnTokens: 150000` warns whichever comes first. For a 200k window model, 0.77 is 154k tokens — the percent band fires first. On a small-window model, the tokens band can fire first.

### Rearm band

`lastWarned` maps `sessionID → { pct, tokens }` (last value each band was notified at). A band re-notifies (toast + verbose log) only after rising by `rearmPercent` points or `rearmTokens` tokens since the last notify. **The rearm band does NOT gate the model injection** — see the critical gotcha below.

### Warning injection

When above threshold, the plugin pushes a synthetic user message (`role: "user"`, `synthetic: true`) carrying the rendered template (`{percent}` `{tokens}` `{window}` placeholders replaced). The message ID/time are generated fresh each push (`msg_cw_<base36 timestamp>`). The agent/model metadata are cloned from the last real user message when available, so the synthetic message looks like a normal user turn to the provider.

## Compact_context tool and post-compaction message

The plugin also gives the agent a way to compact its own session, plus a way to control what the session does after compaction.

### Compact_context tool

The plugin registers a `compact_context` tool. The tool is always registered; there is no opt-out config. The agent calls it when the session is getting full. Each backend registers the tool with its own runtime: `src/backend/v1.ts` (the v1 tool) and `src/backend/v2.ts` (the v2 tool). The tool's `execute` calls `backend.compact(...)`, the `compact` method on the shared `RuntimeBackend` port (`src/backend/types.ts`), which works like this:

1. v2 path: `await v2Client.v2.session.compact({ sessionID })`. The v2 client is built lazily once at load from `@opencode-ai/sdk/v2/client`.
2. v1 fallback: on any v2 failure or resolved-error, `client.session.summarize({ path: { id: sessionID }, body: { providerID, modelID, auto: true } })`. The `providerID` and `modelID` come from the per-session model cache captured by `experimental.chat.system.transform` (`input.model.providerID`, `input.model.id`; the window is `input.model.limit.context`). If the cache has no model for the session, the tool returns `"Compaction failed: <detail>"` and does NOT call summarize. `auto: true` makes opencode's `experimental.compaction.autocontinue` hook fire, so a tool-triggered compaction still posts the configured continue message. The v2 `session.compact` endpoint is a server-side hard stub on opencode 1.18.11 (`ServiceUnavailableError` — "Session compact is not available yet"), so on that build the summarize fallback is the path that actually compacts. The old v1 command fallback is dropped: research proved it is dead (`UnknownError` on 1.18.11), so the tool no longer mirrors the `/compact` keybind.
3. The tool never throws. It returns `"Compaction requested."` on success or `"Compaction failed: <detail>"` on failure, so the agent sees the outcome as the tool result.

### Post-compaction message

When `postCompactContinue` is on, the `experimental.compaction.autocontinue` hook runs after a successful compaction. The hook is wired in `src/backend/v1.ts` (the v1 backend; the v2 backend has no equivalent hook). It runs like this:

- `output.enabled = false` suppresses opencode's synthetic "continue" message.
- `client.session.promptAsync({ path: { id: input.sessionID }, body: { agent: input.agent, parts: [{ type: "text", text: opts.postCompactMsg }] } })` injects the configured text as a real, persisted user message. The call is fire-and-forget with a `.catch` log; a race here is tolerated by design.
- When `postCompactContinue` is off, the hook still sets `output.enabled = false` (so opencode's synthetic continue is suppressed too) but sends no message at all.

The injected message is REAL, unlike the transient warning injection. It is persisted to the session store, so the session loop processes it as the next user turn.

## Critical design gotchas

### The injection is transient — push on EVERY turn

The synthetic message is pushed into the *current transform call's in-memory* message array. It is **never persisted to the session store**; the session loop re-reads messages from the store on each step. Therefore, if the plugin injected only on the first turn above threshold, the warning would appear in that step's assembled context but vanish on the next step (tool calls, follow-ups). **The warning must be pushed on every `messages.transform` call while above threshold.** `lastWarned` gates only the toast and verbose log, never the injection.

### Config is read once at load

`loadOptions()` runs when the plugin module loads; the file `~/.config/opencode/opencode-context-watch.json` is read a single time. **Changes require an opencode restart.**

### Percent mode needs a known window

- Live TUI: window is cached per session via `system.transform` automatically.
- `opencode run` (headless/CI): no TUI, so no cache — pass `CONTEXT_WATCH_WINDOW` explicitly, or the percent band silently stays disabled (tokens band still applies).

### The v2 client import must be the client-only subpath

- Import the v2 client from `@opencode-ai/sdk/v2/client`, never the full `/v2` entry. The full entry imports cross-spawn and child_process and breaks `bun build` browser-mode.
- `compact` lives on `v2Client.v2.session` (the `Session3` client), not on the top-level `v2Client.session` (the `Session2` client lacks it).
- The v1 `command` and `promptAsync` methods live on the top-level `client.session.*`, not on `client.app.session.*` (`App` only has `log` and `agents`).
- `PluginInput.serverUrl` is a `URL` object; pass `serverUrl?.href` as `baseUrl`.

## Configuration

Config file (optional): `~/.config/opencode/opencode-context-watch.json`. Read once at load; restart to apply.

| Key | Default | Description |
|-----|---------|-------------|
| `warnPercent` | `0.77` | 0..1, or percent (e.g. `77`) if > 1. Warn when `tokens/window` crosses this. |
| `warnTokens` | `150000` | Warn when the session reaches this many tokens (absolute). |
| `windowTokens` | `null` | Override the model's context window (tokens). |
| `rearmPercent` | `5` | Re-warn after this many percentage-point rise (percent band). |
| `rearmTokens` | `5000` | Re-warn after this many more tokens (tokens band). |
| `toast` | `true` | Show a TUI toast when a band is crossed. |
| `verbose` | `false` | Log context estimates to the opencode log (`client.app.log`). |
| `message` | default template | Injection template; placeholders `{percent}` `{tokens}` `{window}`. |
| `postCompactContinue` | `false` | Send a message after compaction. |
| `postCompactMsg` | `[context-watch] Session context was compacted. Continue your work from where you left off, keeping replies concise.` | Text of the post-compaction message. |

### Environment overrides (win over file)

`CONTEXT_WATCH_PERCENT`, `CONTEXT_WATCH_TOKENS`, `CONTEXT_WATCH_WINDOW`, `CONTEXT_WATCH_REARM`, `CONTEXT_WATCH_REARM_TOKENS`, `CONTEXT_WATCH_MESSAGE`, `CONTEXT_WATCH_NO_TOAST`, `CONTEXT_WATCH_POST_COMPACT_CONTINUE`, `CONTEXT_WATCH_POST_COMPACT_MSG`.

`warnPercent` normalization: values > 1 are divided by 100 (so `77` and `0.77` both mean 77%). `windowTokens` values <= 0 are treated as unknown (`null`). `CONTEXT_WATCH_POST_COMPACT_CONTINUE` accepts literal `true`, `false`, or a numeric string (non-zero means `true`); anything else pushes a problem and falls back to file/default.

## Verification

```sh
# Typecheck
npx tsc --noEmit

# Bundle check
bun build src/index.ts --outdir dist

# Smoke test — inject a warning on the first turn (expect the marker echoed)
cd /tmp/opencode/ctxwatch-runtest && \
  CONTEXT_WATCH_PERCENT=0.001 CONTEXT_WATCH_WINDOW=200000 \
  CONTEXT_WATCH_MESSAGE="...CWVERIFIED..." \
  opencode run --print-logs "Read hello.txt and tell me what it says"
```

## Model window reference

- `opencode/deepseek-v4-flash-free`: **200k** window (NOT 1M — that is `deepseek/deepseek-v4-flash`).
