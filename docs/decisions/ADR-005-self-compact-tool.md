# ADR-005: Self-compact tool on the V2 plugin context

## Status

Accepted. Supersedes the "No compaction tool" decision in
[ADR-004](ADR-004-v2-only-rewrite.md), which was based on OpenCode 2.0.16.
[ADR-002](ADR-002-self-compact-tool-and-message.md) added the original V1 tool.
ADR-004 removed it. This ADR restores the capability on the in-process V2 plugin
context API, not the client SDK that ADR-002 used.

## Date

2026-11-20

## Context

The default warning injects a transient message. It tells the agent to compact
with two `opencode api post` shell calls: `/compact`, then a steer `/prompt` with
the continuation text. The session ID must be pasted into each command. This
block is at `src/config.ts:31-34` and is described in
[the research file](../research/2026-11-20-compact-tool-api.md).

The goal is one plugin-provided tool that takes only a continuation message and
resolves the calling session itself.

On OpenCode 2.3.0 the plugin context exposes the seams this needs:

- `ctx.tool.transform((editor) => editor.add(definition))` registers a tool.
- `execute(input, context)` receives the calling session as `context.sessionID`.
  The input carries no session ID.
- `ctx.session.compact({ sessionID })` admits a compaction control and wakes the
  runner. It returns before the compaction finishes. It rejects with
  `CompactionConflictError` when a compaction is already pending.
- `ctx.session.prompt({ sessionID, text, delivery: "steer" })` enqueues the
  continuation after the compaction control. It rejects with
  `PromptConflictError` when a steer is already pending.

These facts are verified in [the research file](../research/2026-11-20-compact-tool-api.md).
ADR-004 rejected a tool because on 2.0.16 `ctx.session.compact` did not exist.
That premise no longer holds.

## Decision

Add a `compact_context` tool. Its `input` is a raw JSON Schema object that
requires only `message`. `output` is optional. The tool does not take a session
ID. Register it with `ctx.tool.transform`. Await the transform in `setup`. Keep
the callback body synchronous. During `execute` the tool:

1. calls `ctx.session.compact({ sessionID })` with the ID from `context.sessionID`.
2. calls `ctx.session.prompt({ sessionID, text: message, delivery: "steer" })`.
3. catches `CompactionConflictError` and `PromptConflictError` and returns
   `{ content: <short string> }` in every case.

The tool never throws into the session loop. Change the default warning so it
tells the agent to call `compact_context` with one continuation message.

Use the in-process context APIs only. No shell subprocess, no HTTP fallback, and
no runtime `@opencode/*` import. Keep `src/types.ts` structural and widen it
only from the probed shapes.

## Alternatives Considered

### Keep the two shell calls

- Pros: no new code. The current default warning already works.
- Cons: every compaction needs two `opencode api post` calls, and the agent must
  paste the session ID into each one. A synchronous `opencode api` call inside
  `execute` can deadlock the request thread. Rejected.

### Hand-rolled authenticated HTTP

- Pros: the server exposes HTTP routes for compact and prompt.
- Cons: the plugin context has no `client` or `serverUrl` member, and a direct
  request returns 401. The plugin must discover the URL and the server password
  out of band. Rejected.

### Keep no tool, the ADR-004 status quo

- Pros: no change.
- Cons: on 2.3.0 `ctx.session.compact` exists, so the reason ADR-004 removed the
  tool is gone. The agent still needs two shell calls. Rejected.

## Consequences

- The 2.0.16 premise in ADR-004 aged out. The capability returns through the V2
  in-process context API rather than the V1 client SDK.
- Compaction and the steer prompt are asynchronous. The tool returns when the
  items are admitted and the runner wakes, not when compaction finishes.
- The tool result can be summarized into the checkpoint. Put the real
  continuation text in `message`, which is admitted as a steer after the
  compaction control.
- The full in-turn call was validated in an isolated local service with a
  temporary configuration and a throwaway session. The service did not touch the
  global configuration or user sessions.
- The existing compaction event cleanup stays in place. `session.compaction.started`
  still suppresses warnings, and `ended` and `failed` still clear the stale
  usage sample.
