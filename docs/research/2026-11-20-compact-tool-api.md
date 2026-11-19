# Findings: `compact_context` tool API on OpenCode 2.3.0

Research date: 2026-11-20. Target: the installed OpenCode 2.3.0 server plugin API, for the spec in `.scratch/2026-11-20_compact-tool/spec.md`. Every claim below cites a repo file, an OpenCode 2.3.0 source file at its release tag, or a read-only probe of the already-running service. No server was started, stopped, or mutated; no source file outside this report was edited.

## Live probe record

- `opencode --version` and `opencode api get /api/info` both report version 2.3.0. The service was already running; its HTTP URL came from `/api/info`, not from a guessed address.
- `opencode api get /openapi.json` (read-only) yields the server's own OpenAPI document (139 paths). Relevant routes:
  - `POST /api/session/{sessionID}/compact`, operation `session.compact`, body `{ id?, delivery? }`.
  - `POST /api/session/{sessionID}/prompt`, operation `session.prompt`, body requires `text`; `delivery` is optional.
  - `Session.Inbox.Delivery` is the string enum `"steer" | "queue"`.
- Direct `curl` to the service port returns `401 {"_tag":"UnauthorizedError"}`; the `opencode api` CLI supplies its own authorization. Binary strings name `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD` as the server password sources. A plugin has no `client` or `serverUrl` member in its context (see fact 2), so HTTP fallback needs out-of-band URL and auth discovery. The in-process `ctx.session` path avoids that entirely.

## Code map in this repo

- `src/config.ts:24-35`: `DEFAULTS`; the default `message` at `src/config.ts:31-34` tells the agent to replace `<session-id>` and run two `opencode api post` shell calls, first `/compact`, then `/prompt` with `{"delivery":"steer"}`. This is the block the spec replaces.
- `src/config.ts:136-146`: `message` option validation (non-empty string, else per-key fallback).
- `src/index.ts:35-38`: default export `{ id, setup(ctx) }`, the promise-style plugin entry.
- `src/index.ts:195-228`: the `ctx.session.hook("context", cb)` registration. Its callback receives `event.sessionID` and `event.model`, and appends the transient synthetic user message at `src/index.ts:223-227`. This is already a per-session source of the calling session ID.
- `src/index.ts:143-193`: event loop over `ctx.event.subscribe({ signal })`. Compaction handling: `session.compaction.started` adds the session to `compacting` (`src/index.ts:150-156`); `ended`/`failed` drop the usage, rearm, and compacting entries (`src/index.ts:157-170`); `session.deleted` prunes all per-session state (`src/index.ts:171-179`); `session.step.ended` refreshes the usage sample (`src/index.ts:180-187`).
- `src/index.ts:236-239`: cleanup aborts the event stream and disposes the hook registration.
- `src/types.ts:53-74`: structural `PluginContext` (`options`, `model.list`, `session.hook`/`session.get`, `event.subscribe`, optional `rpc.register`). No `tool` or `session.compact`/`prompt` member yet; these must be widened from the probe in fact 1 and 2.
- `src/context.ts:128-135`: `warningMessage()` builds the transient `{ role: "user", content: [{ type: "text", text }] }` injection.
- Tests: `tests/plugin.test.ts:171-454` covers warning, compaction events, and cleanup; `tests/plugin.test.ts:456-546` covers the status RPC; `tests/config.test.ts:6-113` covers option resolution including `message`; `tests/context.test.ts` covers usage/assessment/render; `tests/line.test.ts` covers sidebar rendering.
- Docs: `README.md:49-59` describes the warning, `README.md:87-92` documents `message`, `README.md:105-110` and `README.md:130` describe compaction as plugin-free, and `README.md:20-23` points at ADR-004. `CONTEXT.md:14` defines warning injection and `CONTEXT.md:16` defines compaction as owned by OpenCode. `docs/design.md:16-22` lists the probed context members, with `ctx.session.compact` marked absent at `docs/design.md:22` and the compaction state machine at `docs/design.md:109-117`.
- `docs/decisions/ADR-002-self-compact-tool-and-message.md:1-69`: the original tool (V1 SDK paths, `client.session.summarize`, `experimental.compaction.autocontinue`), superseded.
- `docs/decisions/ADR-004-v2-only-rewrite.md:29-32` records that on 2.0.16 `ctx.session.compact` did not exist and `ctx.session.command` had no compact command; `docs/decisions/ADR-004-v2-only-rewrite.md:64-71` rejects hand-rolled HTTP. `docs/decisions/ADR-004-v2-only-rewrite.md:53` removes the tool. On 2.3.0 the first of those premises no longer holds (fact 2).

## Fact 1: registering the tool and the `execute` input

**VERIFIED, with one assumption noted.** The promise plugin context exposes `tool: ToolDomain` (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/plugin/src/promise/plugin.ts#L27-L56`). `ToolDomain.transform` accepts a callback over a `ToolEditor`, and `ToolEditor.add(definition)` is the registration call (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/plugin/src/promise/tool.ts#L32-L36`, `...#L72-L78`). The wiring is in the promise adapter (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/plugin/src/promise/adapter.ts#L514-L540`); the adapter passes the tool definition through to the host with an `execute(input, context)` wrapper. The compiled 2.3.0 CLI contains the same pattern in its own built-in tools (`e.tool.transform((editor) => editor.add({ name, description, input, output, execute }))`), matching the memory that this path worked earlier.

Exact `execute` shape: `execute(input, context) => Promise<Tool.Result>`, where `context` is `ToolContext`. The input is the first argument; the calling session ID is **not** in it. It is the second argument: `context.sessionID`, alongside `agent`, `messageID`, `id` (call ID), `signal`, and `progress` (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/plugin/src/promise/tool.ts#L11-L30`; the underlying effect context is at `https://github.com/anomalyco/opencode/blob/v2.3.0/packages/schema/src/tool.ts#L26-L33`). The adapter forwards `sessionID` unchanged (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/plugin/src/promise/adapter.ts#L701-L729`). Built-in tools rely on this: the compiled `session_rename` and `session_move` tools read `y.sessionID` from the context. So a tool whose schema is only `{ message: string }` can resolve the session without the model passing one.

`OPENCODE_SESSION_ID` in tool shell env: **VERIFIED** for shell tools on 2.3.0. The compiled CLI sets `env.OPENCODE_SESSION_ID = context.sessionID` before running a shell command, and that variable is present in the tool shell environment during this probe. It is not needed for a TypeScript plugin tool, which reads `context.sessionID` directly.

`Tool.Result` is a string or `{ title?, output, metadata?, attachments? }` (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/schema/src/tool.ts#L103-L108`). Returning a short string from `execute` is valid and lets the tool report failure without throwing into the session loop. **SUPERSEDED: see Follow-up below; on 2.3.0 `execute` returns `{ content: <string> }`, not a bare string.**

## Fact 2: compacting a session from inside the tool

**VERIFIED.** `ctx.session.compact` exists on the 2.3.0 promise context. `SessionDomain` includes `"compact"` (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/plugin/src/promise/session.ts#L219-L239`), and the promise adapter wires `compact: adaptApiMethod(SessionEndpoints["session.compact"], host.session.compact)` (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/plugin/src/promise/adapter.ts#L629-L658`); the host maps that to `sessions.compact` (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/plugin/src/plugin/host.ts#L567-L590`). This supersedes ADR-004's 2.0.16 observation; that ADR's HTTP objection no longer applies.

Signature: `ctx.session.compact({ sessionID, id?, delivery? })`, with `delivery?: "steer" | "queue"` (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/client/src/promise/generated/types.ts#L3517-L3523`). It returns an admitted `SessionInbox.Compaction` item, or rejects with `CompactionConflictError` when a compaction is already pending (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session.ts#L238-L241`, `...#L259-L277`). The implementation admits the item and calls `execution.wake(sessionID)` before returning; it does not wait for the compaction to finish. The protocol description states the same: "Durably admit a session compaction request. Steers by default: it runs at the next step boundary instead of waiting behind queued prompts." (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/protocol/src/groups/session.ts#L450-L458`). That is the async path the spec needs; no subprocess and no synchronous `opencode api` call.

HTTP route, as an alternative: `POST /api/session/{sessionID}/compact` with `{}` is confirmed by the read-only OpenAPI probe and by the generated client (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/client/src/promise/generated/client.ts#L815-L826`). A plugin doing raw HTTP would need URL and auth discovery, and the context has no `client`/`serverUrl` member; prefer `ctx.session.compact`.

The 2026-09-13 memory that a synchronous `opencode api` call inside `execute` deadlocks was **not re-tested** (it would risk a live session). It is consistent with the admit-and-wake design: the safe path is the in-process call, not a blocking subprocess.

## Fact 3: posting the continuation text as a steer prompt

**VERIFIED.** `ctx.session.prompt` is on the same context (`SessionDomain` includes `"prompt"`, adapter wires it at `https://github.com/anomalyco/opencode/blob/v2.3.0/packages/plugin/src/promise/adapter.ts#L629-L658`). Signature: `ctx.session.prompt({ sessionID, text, id?, files?, agents?, skills?, metadata?, delivery?, resume? })`; `delivery?: "steer" | "queue" | null` (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/client/src/promise/generated/types.ts#L3435-L3465`). Passing `delivery: "steer"` is the direct equivalent of the current shell command. The implementation prepares the user message, admits it, and wakes the runner unless `resume === false` (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/session.ts#L155-L190`). It can reject with `PromptConflictError`, so the tool should catch it and return a string.

Ordering is guaranteed by the inbox: pending steers are sorted with a compaction control moved ahead of earlier steers, so the compaction runs first and the steer text stays verbatim after the checkpoint rather than inside its summary (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/inbox.ts#L562-L586`, `...#L608-L620`). Call `compact` first, then `prompt` with `delivery: "steer"`; both enqueue in that order from the tool.

The HTTP equivalent is `POST /api/session/{sessionID}/prompt` with `{"text": ..., "delivery": "steer"}` (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/client/src/promise/generated/client.ts#L744-L762`), also confirmed by the live OpenAPI probe.

## Fact 4: hazards when compaction runs during a live turn

- **Events, VERIFIED.** Event types are `session.compaction.started`, `.delta`, `.ended`, and `.failed` (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/schema/src/session-event.ts#L598-L645`). Manual (tool-triggered) compaction publishes `started` at the step boundary when the runner delivers the compaction inbox item (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/runner/llm.ts#L95-L107`); automatic compaction publishes its own `started` (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/compaction.ts#L320-L327`), and `ended`/`failed` are published with reason and usage (`...#L905-L935`). This plugin's existing event loop already suppresses warnings and clears the stale sample on those events (`src/index.ts:150-170`, `tests/plugin.test.ts:262-289`).
- **Transcript persistence, VERIFIED.** The events are projected into persisted messages: `session.compaction.started` appends a `compaction` message with status `running`; `ended` updates it to `completed` with the summary text; `failed` records a failed compaction (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/message-updater.ts#L427-L485`, `https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/projector.ts#L1118-L1128`). Compaction replaces the older history with a checkpoint, keeping a recent tail verbatim (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/compaction.ts#L450-L470`).
- **Steer message survives, VERIFIED from source.** The steer prompt is a separate, admitted user message promoted after the compaction control, so it becomes the next user turn with its text unchanged (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/inbox.ts#L608-L620`). Unlike the plugin's transient warning (`src/context.ts:128-135`), it is durable.
- **Tool result, PARTIALLY VERIFIED.** The tool call and its result are persisted as part of the assistant message (`Tool.Success`/`Tool.Failed` are projected at `https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/projector.ts#L1113-L1117`). Compaction summarizes earlier history, so the result may end up inside the checkpoint rather than verbatim. The design explicitly keeps steer text after the checkpoint to avoid that fate. Treat the success string as a short acknowledgement only; put the real continuation text in `message`.
- **End-to-end behavior, UNVERIFIED.** No live compaction was triggered during this research because that mutates a running session. The ordering and event claims above come from source, not from an observed call.

## Recipe for the live validation step (not performed here)

1. Load the plugin in a test session on the installed 2.3.0 server and drive it over the window threshold so the warning is injected.
2. Have the agent call `compact_context` with a distinctive continuation string. Confirm the tool result string is returned without an exception.
3. Read the session transcript read-only after the runner settles: expect a persisted `compaction` message with status `completed`, then a user message containing the exact continuation string.
4. Watch the plugin's event stream (`session.compaction.started`, `.ended`) and confirm warnings are suppressed while compacting and that the first post-compaction request has no stale usage sample.
5. If the tool returns a conflict error, retry once; `CompactionConflictError` and `PromptConflictError` are expected when a compaction or steer is already pending.

## Confidence summary

- High: tool registration via `ctx.tool.transform(...).add(...)`; `execute(input, context)` with `context.sessionID`; `ctx.session.compact` and `ctx.session.prompt({ delivery: "steer" })`; async admit-and-wake behavior; event names and transcript projection; steer-after-compaction ordering. Each is backed by 2.3.0 source and, for the routes, by the read-only live OpenAPI.
- Medium: `OPENCODE_SESSION_ID` in shell tool env (verified from the compiled binary and the live environment, but not from a dedicated source file read).
- Not verified live: the full in-turn tool call, survival of the tool result through an actual compaction, and the sync-CLI deadlock memory. These need the recipe above.

## Follow-up (2026-11-20): tool schema shape and transform callback

### `input` and `output` on `ToolEditor.add`

**VERIFIED.** The `input` field is `Tool.ValueSchema`, a union of three accepted families: an Effect Schema codec, a `StandardSchemaV1` object (Zod v3.24+ and v4 expose `~standard`), or a raw JSON Schema object (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/schema/src/tool.ts#L61`, `https://github.com/anomalyco/opencode/blob/v2.3.0/packages/plugin/src/promise/tool.ts#L22-L29`). The runtime dispatches on that shape: `~standard` schemas are converted with `toJSONSchema` (Zod included), Effect Schemas through `Schema.toJsonSchemaDocument`, and anything else is passed through as a JSON Schema object; `undefined`/`null` become `{}` (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/tool/runtime.ts#L158-L167`, `...#L170-L178`). So Zod is valid, but it is not the only shape.

Minimal copied example, the built-in `artifact_read` tool with one string argument (`id`). It uses an Effect Schema:

```ts
export const ReadToolInput = Schema.Struct({
  id: Artifact.ID.annotate({ description: "Artifact ID (art_...) to read." }),
})
```

Source: `https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/tool/plugin/artifact.ts#L25-L27`; the tool definition uses `input: ReadToolInput` at `...#L98-L106`. A JSON Schema object such as `{ type: "object", properties: { message: { type: "string" } }, required: ["message"] }` is also accepted by the same field, but the copied built-in example above is the canonical form.

`output` is **optional**: `Tool.Info.output?` (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/schema/src/tool.ts#L109-L119`), the runtime emits `outputSchema` only when it is defined (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/tool/runtime.ts#L20-L30`), and a built-in command tool omits it (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/tool/plugin/schedule.ts#L156-L166`).

Correction to the "Fact 1" paragraph above: its description of `Tool.Result` came from the locally installed V1 `@opencode-ai/plugin@1.18.30` types, not from 2.3.0. On 2.3.0 `execute` returns `Promise<Tool.Result>`, where `Result` is an object with optional `content` (string or content parts), `output`, and `metadata` (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/schema/src/tool.ts#L103-L108`, `https://github.com/anomalyco/opencode/blob/v2.3.0/packages/plugin/src/promise/tool.ts#L1-L2`, `...#L22-L29`). Return `{ content: "Compaction requested." }`, not a bare string.

### `ctx.tool.transform` callback

**VERIFIED: synchronous only.** The public type is `Transform<Input> = (callback: (input: Input) => void) => Promise<Registration>` (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/plugin/src/promise/registration.ts#L21`). Internally `TransformCallback<Editor> = (editor: Editor) => void`, documented as "A synchronous, replayable edit to the current domain state" (`https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/state.ts#L6-L11`), and a rebuild applies each `transform.run(editor)` directly without awaiting a returned value (`...#L197-L199`). An `async` callback would register successfully while its post-`await` edits land later, against a stale editor or after registration. Await `ctx.tool.transform(...)` itself in `setup`; keep the callback body synchronous.
