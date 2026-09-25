# AGENTS.md - opencode-context-watch

## Overview

An OpenCode **V2** plugin that warns when a session's context window usage crosses
a configurable threshold, injecting a synthetic user message so the model can
prepare for compaction. V1 support is removed (see `docs/decisions/ADR-004-v2-only-rewrite.md`).

## Build Commands

```bash
# Install (bun.lock is the only lockfile)
bun install

# Tests (bun:test, tests/ dir)
bun test

# Typecheck (src only)
npx tsc --noEmit

# Test typecheck (tests typechecked separately)
npx tsc -p tsconfig.test.json --noEmit

# Format (biome, auto-fix)
bunx biome format --write .

# Lint + format check (auto-fix with --write)
bunx biome check --write .

# Bundle check
bun build src/index.ts --outdir dist
```

## Verified V2 runtime facts (OpenCode 2.0.16, probed 2026-09-25)

- A plain object default export `{ id, setup(ctx) }` with no runtime OpenCode
  package import loads under `.opencode/plugins/<name>/index.ts` and from the
  `plugins: [{ package, options }]` config form. `setup` may be async; the value
  it returns is called on cleanup.
- `ctx.options` is the object from `plugins[].options`; absent when the config
  form carries no `options`.
- `await ctx.model.list()` resolves `{ location, data: Model.Info[] }`, NOT a
  bare array. `Model.Info` has `id`, `providerID`, and `limit.context`.
- `ctx.session.hook("context", cb)` resolves a registration with `dispose()`.
  The event carries `sessionID`, `model: { id, providerID, variant }`,
  `messages`, `system`, `tools`, `options`, `agent`.
- Appending `{ role: "user", content: [{ type: "text", text }] }` to
  `event.messages` is accepted and the model sees it.
- `ctx.event.subscribe({ signal })` yields `{ type, data }` events.
  `session.step.ended` data has `sessionID` and
  `tokens: { input, output, reasoning, cache: { read, write } }` for the latest
  step. `session.usage.updated` is cumulative session consumption, NOT the
  current context size — ignore it.
- `ctx.session.compact` does not exist. `ctx.session.command` requires
  `{ name }` and there is no compact command. Do not add a compaction tool.
- `ctx.tool.transform` custom tools take object definitions and return
  `{ content }`, but this plugin needs no tool.

## Critical Implementation Notes

- The injected warning is TRANSIENT — it is appended to the current hook call's
  in-memory messages array and is never persisted. The session loop re-reads
  messages from the store each step, so the warning must be appended on EVERY
  above-threshold `context` hook call. The rearm band (`lastWarned`) gates only
  the verbose log, NOT the injection.
- Token ground truth is the most recent completed step's
  `input + output + reasoning + cache.read + cache.write` (matches the context
  meter). Do not sum `input` across steps — each step's `input` is the whole
  context at request time and would overcount.
- The usage cache is ONE model request behind: verified live on 2.0.16,
  `session.step.ended` can be published after the next `context` hook has
  already run, so the first one or two requests of a session have no sample and
  cannot warn. Do not "fix" this with a per-hook `ctx.session.context` call — it
  re-serializes the whole transcript on every request.
- `ctx.session.get({ sessionID }).tokens` is the CUMULATIVE session total (it
  equals `session.usage.updated`), not the per-step context size. It is not a
  usable sample.
- Plugin `console.log`/`console.error` do not reach `opencode2 run --print-logs`
  output; the `verbose` line is only visible in a real service log.
- Config comes only from `ctx.options`, resolved once at setup. There is no
  config file, no env parsing, and no watcher. Invalid values fall back per key;
  each problem is `console.error`-logged and the good keys still apply.
- Options are read at `setup`, so a config change needs an opencode restart.
- The model-window map is built once at setup from `ctx.model.list().data`. A
  failed list is tolerated: the percent band is disabled and the tokens band
  still fires. Windows are keyed `providerID/modelID` from `event.model`.
- The plugin has no runtime dependency on `@opencode/*` or `@opencode-ai/*`. The
  V2 context members it calls are declared structurally in `src/types.ts`;
  widen them only from a live probe, never from a package type.
- The event loop must never reject into the session: it is wrapped, and it exits
  quietly when the abort signal fires. Setup's cleanup aborts the stream and
  disposes the hook registration.

## Code Style

- TypeScript, strict mode, `tsconfig.json` at repo root (lib es2022 + dom, types
  node). Biome formats with tabs.
- No comments unless they explain non-obvious behavior (transient injection,
  step.ended vs usage.updated); keep those, drop narration.
- Conventional Commits with `changelog:` body key per `docs/dev/commit-changelog.md`
  conventions; scopes per `docs/dev/commit-scopes.md`.

## License

MIT
