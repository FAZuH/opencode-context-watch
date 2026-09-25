# ADR-002: Self-compact tool and post-compaction user message injection

## Status
Superseded by [ADR-004](ADR-004-v2-only-rewrite.md) (2026-09-25). The `compact_context`
tool and both `postCompact*` options are removed: OpenCode 2.0.16 exposes no
compaction trigger on the plugin context, and V2 owns the post-compaction resume.

## Date
2026-08-06

## Context
We want the agent to compact its own session when the context window gets full. The plugin already warns the model (ADR-001), but the agent has no way to trigger compaction itself — only a human can press the `/compact` keybind.

We also want control over what happens after compaction. opencode's default behavior injects a synthetic "continue" message so the session resumes. That message is generic; the user cannot customize it, and it cannot carry a specific instruction.

Constraints discovered during implementation:

- The v2 SDK client must be imported from `@opencode-ai/sdk/v2/client` (the client-only subpath). The full `/v2` entry imports cross-spawn and child_process, which breaks `bun build` in browser mode.
- In SDK 1.18.11, the v2 `compact` method lives on `v2Client.v2.session` (the `Session3` client), not on the top-level `v2Client.session`.
- The v1 `command` and `promptAsync` methods live on the top-level `client.session.*`, not on `client.app.session.*` (`App` only has `log` and `agents`).
- `PluginInput.serverUrl` is a `URL` object. `createOpencodeClient` takes `baseUrl?: string`, so the plugin passes `serverUrl?.href`.
- Unlike the transient warning injection, a post-compaction message must persist. The session loop re-reads messages from the store, so only a persisted message becomes the next user turn.

## Decision

Add a `compact_context` plugin tool that the agent calls to compact its own session. The tool is always registered; there is no opt-out config. Its `execute` calls `triggerCompact(ctx.sessionID)`, which prefers the v2 client: `await v2Client.v2.session.compact({ sessionID })`. On any v2 failure or resolved-error it falls back to the v1 summarize path: `client.session.summarize({ path: { id: sessionID }, body: { providerID, modelID, auto: true } })`. The `providerID` and `modelID` come from the per-session model cache captured by the `experimental.chat.system.transform` hook (`input.model.providerID`, `input.model.id`). If the cache has no model for the session, the tool returns `"Compaction failed: <detail>"` without calling summarize. `auto: true` makes opencode's `experimental.compaction.autocontinue` hook fire, so tool-triggered compactions post the configured continue message. The tool never throws; it returns `"Compaction requested."` or `"Compaction failed: <detail>"`.

Add two config keys: `postCompactContinue` (boolean, default `false`) and `postCompactMsg` (string). When `postCompactContinue` is on, the `experimental.compaction.autocontinue` hook sets `output.enabled = false` to suppress opencode's synthetic continue. It then injects `postCompactMsg` as a real, persisted user message via fire-and-forget `client.session.promptAsync({ path: { id: input.sessionID }, body: { agent: input.agent, parts: [{ type: "text", text }] } })`. A `.catch` handler logs any failure; a failed injection is tolerated, not raised. When `postCompactContinue` is off, the hook still sets `output.enabled = false` (so opencode's synthetic continue is suppressed too) but sends no message at all.

### Update (2026-08-06): v1 fallback changed to `session.summarize`

- Context: research proved the original v1 fallback is dead on opencode 1.18.11. The v2 `session.compact` endpoint is a server-side hard stub; it resolves `ServiceUnavailableError` ("Session compact is not available yet"). The v1 command call that the `/compact` keybind uses resolves `UnknownError`. The only working programmatic compaction path is `client.session.summarize`.
- Decision: replace the v1 command fallback with `client.session.summarize({ path: { id: sessionID }, body: { providerID, modelID, auto: true } })`, using the per-session model info cached by `experimental.chat.system.transform` (`providerID` from `input.model.providerID`, `modelID` from `input.model.id`). If the cache has no model for the session, return `"Compaction failed: <detail>"` without calling summarize. Send `auto: true` so the `experimental.compaction.autocontinue` hook fires for tool-triggered compactions.
- Consequences: on opencode 1.18.11 the summarize fallback is the path that actually compacts. The tool no longer mirrors the `/compact` keybind. A session with no cached model fails honestly.

## Alternatives Considered

### Status quo: human-only compaction
- Pros: No new code; the `/compact` keybind already works.
- Cons: The agent cannot self-compact, so a full window still waits for a human. The synthetic continue after compaction is generic and uncustomizable. Rejected.

### V2-only compact call
- Pros: One code path, no fallback.
- Cons: The v2 client can be unavailable (import failure, older SDK); the plugin must degrade gracefully. The full `/v2` entry breaks the bundle, so the client-only subpath is required regardless. Rejected.

### Reuse the transient transform injection for the post-compaction message
- Pros: Reuses the existing injection seam from ADR-001.
- Cons: The transform injection is never persisted, so the session loop would not process it as the next user turn. The post-compaction message must persist. Rejected.

### Keep the synthetic continue and append the configured text
- Pros: Minimal code change.
- Cons: The session receives two continuation messages; the duplicate wastes a turn. The hook suppresses the synthetic one instead. Rejected.

## Update (2026-08-07): rename to `postCompactContinue`/`postCompactMsg`; suppress synthetic continue even when off

- Context: the user reported the post-compaction config names read awkwardly, and that with `compactMessage: false` an empty message was still sent after compaction (opencode's native synthetic continue).
- Decision: rename `compactMessage` → `postCompactContinue` and `compactMessageText` → `postCompactMsg` (env `CONTEXT_WATCH_POST_COMPACT_CONTINUE`, `CONTEXT_WATCH_POST_COMPACT_MSG`). The `experimental.compaction.autocontinue` hook now always sets `output.enabled = false`; the configured text is injected only when `postCompactContinue` is on. When off, no message is sent at all after compaction.

### Persist via a direct message-create call
- Pros: Direct control over the stored message.
- Cons: Writing a message mid-request races with the session loop (ADR-001 rejected this). `promptAsync` is the SDK's intended path for submitting a user prompt, and it starts the loop as a normal turn. Rejected.

## Consequences
- An agent can compact its own session on demand, so a full window no longer waits for a human.
- With `postCompactContinue` on, the session resumes on the configured instruction instead of the generic synthetic continue. When off, no message is sent after compaction.
- The v2/v1 fallback keeps the tool working when the v2 client is unavailable. Failures surface to the agent as a tool result string, never as an uncaught error.
- The post-compaction injection is fire-and-forget: a failed `promptAsync` is logged and the session still continues. A race here is tolerated by design.
- The tool is always registered; there is no opt-out config (scope per request; revisit if users ask).
- Developers must remember the SDK path gotchas (documented in `AGENTS.md` and `docs/design.md`).
