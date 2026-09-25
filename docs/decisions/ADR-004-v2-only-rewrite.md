# ADR-004: OpenCode V2 only

## Status
Accepted. Supersedes [ADR-001](ADR-001-inject-warnings.md),
[ADR-002](ADR-002-self-compact-tool-and-message.md), and
[ADR-003](ADR-003-runtime-autodetection.md).

## Date
2026-09-25

## Context

The plugin shipped a dual-runtime implementation: a V1 `Plugin` factory with
`experimental.chat.*` hooks, a V1 `client` for toasts and logging, a lazily
built `@opencode-ai/sdk/v2` client, and a config file plus `CONTEXT_WATCH_*`
environment overrides. That surface was pinned to opencode 1.18.11.

OpenCode 2.0.16 does not load it. The supported plugin contract is now a plain
default export `{ id, setup(ctx) }` with no runtime OpenCode package import, and
the useful seams moved:

- `ctx.options` carries the options object from `plugins: [{ package, options }]`.
- `await ctx.model.list()` resolves `{ location, data }`, so the context window
  for every model is known at setup.
- `ctx.session.hook("context", cb)` runs per model request and its `event.messages`
  array can be appended to.
- `ctx.event.subscribe({ signal })` streams `{ type, data }` events; a
  `session.step.ended` event carries one step's own token usage.
- `ctx.session.compact` does not exist, and `ctx.session.command` only lists the
  commands that exist — there is no compact command to invoke.

Verified on a live 2.0.16 probe on 2026-09-25.

## Decision

Target OpenCode V2 only and delete the V1 code rather than branch on the
runtime.

- The entry is a plain `{ id, setup }` object typed against narrow local
  structural types (`src/types.ts`). No `@opencode/plugin`, no `@opencode-ai/*`
  runtime dependency, no dual-shape export.
- Configuration comes from `ctx.options` only. The config file, the env
  overrides, the config watcher, and the config-error toast are gone; invalid
  values fall back per key and are written to the console log.
- Context usage is the `session.step.ended` sample for the session.
  `session.usage.updated` is cumulative session consumption, not the current
  context size, so it is ignored.
- The model window comes from the setup-time model list, overridden by
  `windowTokens`.
- The warning is still a transient synthetic user message appended to
  `event.messages` on every above-threshold request. The rearm band gates the
  verbose log only.
- No compaction tool and no post-compaction message.

## Alternatives Considered

### Keep both runtimes behind a version check

- Pros: V1 users keep working.
- Cons: the V1 half is the larger half of the code and none of it can be
  exercised on 2.0.16; every fix would have to be written and tested twice
  against an API that no longer exists on the target. Rejected.

### Drive compaction over the public HTTP route

- Pros: keeps a self-compact control for the model.
- Cons: `ctx.session.compact` is absent, so the tool would have to read the
  private service registration and hand-roll authenticated HTTP against a
  route the plugin context cannot reach — exactly the maintenance burden this
  rewrite removes. Rejected; opencode's automatic compaction stays the
  compaction path.

### Poll the messages API for usage instead of subscribing to events

- Pros: immune to event-delivery gaps.
- Cons: an older beta failed to deliver session events to *external* server
  plugins, so polling was the workaround then. On 2.0.16 the local plugin form
  receives `session.step.ended` directly, and a poll loop would add a
  subprocess or HTTP call per tick for data that is pushed. Rejected.

## Consequences

- The plugin runs on OpenCode 2.x only. Using it on 1.x is a no-op.
- Configuration moves into `opencode.json` under `plugins[].options`; the old
  `~/.config/opencode/opencode-context-watch.json` and every `CONTEXT_WATCH_*`
  variable are ignored. There is nothing to migrate on the target machines.
- `toast`, `postCompactContinue`, and `postCompactMsg` are removed options.
- The model must be in the setup-time model list for the percent band to work.
  A failed list is survivable: the tokens band still fires.
- The usage cache trails by one model request, because `session.step.ended` is
  published after the next `context` hook has run. The first one or two requests
  of a session can miss the warning; after that every above-threshold request is
  injected. Accepted: a "wrap up soon" hint that is one request late is far
  cheaper than a per-hook `ctx.session.context` call that re-serializes the whole
  transcript on every request.
- There is no V1 SDK to upgrade, and no SDK gotcha list to maintain.
