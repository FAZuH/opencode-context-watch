# ADR-001: Inject warnings as transient synthetic user messages

## Status
Superseded by [ADR-003](ADR-003-v2-only-rewrite.md) (2026-09-25). The decision
below stands: the warning is still a transient synthetic user message, injected
on every above-threshold request. What changed is the seam — the V2
`ctx.session.hook("context")` replaces `experimental.chat.messages.transform`,
so the rearm band now gates only the verbose log, and the window comes from the
model list instead of `system.transform`.

## Date
2026-08-05

## Context
We need the model to see a context-window warning so it can wrap up its step and prepare for compaction. The warning must reach the provider's assembled context, not just the user's screen. The plugin has two candidate visibility channels: a TUI toast (user-facing only) and a message injected into the conversation (model-facing).

Constraints discovered during implementation:

- `experimental.chat.messages.transform` runs every turn with the fully assembled message array, but nothing written to `output.messages` is persisted to the session store. The session loop re-reads messages from the store each step.
- `experimental.chat.system.transform` is the only hook that receives model metadata (`model.limit.context`), which is needed for a percentage-of-window check.
- The TUI context meter's number is the last completed assistant message's provider-reported `input + output + reasoning + cache.read + cache.write` — not a sum across messages.

## Decision

Use `experimental.chat.messages.transform` to compute the context size and push a synthetic `role: "user"` message (with `synthetic: true`) into `output.messages` so the warning is part of the conversation the provider sees. Because the injection is transient (never persisted), **push it on every transform call while above threshold**; use a per-session rearm band (`lastWarned`) to gate only the TUI toast and verbose log, not the injection.

Cache the model window per `sessionID` in `experimental.chat.system.transform`.

## Alternatives Considered

### Toast only (user-facing)
- Pros: Simple, no model interaction.
- Cons: The agent never sees the warning — the whole point is the agent should change behavior and prepare for compaction. Rejected.

### Persist the warning as a real message via the client SDK
- Pros: Warning would survive across turns without re-injection.
- Cons: Writing a message mid-request mutates session state concurrently with the running step; risk of races with the session loop; also heavier than needed. The transform path is the officially intended seam for modifying what the provider sees.

### Inject via the system prompt
- Pros: Persistent visibility.
- Cons: Only injected on the system turn; recomputing usage there is awkward, and it is not the seam designed for per-turn dynamic content. Rejected.

## Consequences
- The model reliably sees the warning on every step above threshold (verified: marker text echoed by the provider in smoke tests).
- No session-store writes, so no persistence races.
- Duplicate synthetic messages accumulate in a single turn's context while above threshold — acceptable, the text is short and it guarantees visibility.
- Developer must remember the transient-injection gotcha (documented in `AGENTS.md` and `docs/design.md`).
