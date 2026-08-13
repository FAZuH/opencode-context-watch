# Plan: DDD refactor + opencode v2 port

> **ARCHIVED 2026-08-13.** The DDD-refactor part of this plan shipped on
> `main`. The v2-port part (a separate `v2` branch with a v2-only entry) was
> SUPERSEDED by the autodetect approach implemented on `main`: one plain-object
> entry `{ id, server, setup }` plus the `src/backend/` seam (`V1Backend` +
> `V2Backend` behind the `RuntimeBackend` port). See
> `docs/plan/autodetect-v1-v2.md` and
> `docs/decisions/ADR-003-runtime-autodetection.md`. This file remains a record
> of the DDD module layout that shipped.

## Objective

1. **Refactor first (DDD)** — split the `src/index.ts` monolith (686 lines) into domain modules: config, context, model-info, warning, compaction, notify, behind a thin composition root. Verified behavior-preserving (all existing tests green).
2. **Create a branch named `v2`** from the refactored `main`.
3. **Modify the plugin for opencode v2** — the plugin currently targets opencode 1.18.x (experimental hooks, v1 client + v2 compact client). Port the hooks/tool/client wiring to the opencode v2 plugin API on the `v2` branch.

Driven by the `improve-codebase-architecture` skill (candidates 1–4 of the review report).

## Decisions & constraints

- **Module layout** (the refactor that shipped):
  - `src/config.ts` — `resolveOptions(raw, env)` (pure, exported), `loadOptions(configPath)`, `ContextWatchOptions`, `ConfigProblem`, `CONFIG_PATH`, defaults. Env > file > default precedence; each bad value → `{ key, message }` problem.
  - `src/context.ts` — pure domain: `contextTokens(messages)` (TUI-meter ground truth), `assess(opts, tokens, window, last)` (dual-band OR + rearm rule; returns `{ pct, overPercent, overTokens, shouldInject, shouldNotify, next }`), `renderMessage`.
  - `src/model-info.ts` — `ModelInfoCache` repository (`capture(sessionID, model)` / `get(sessionID)`), `ModelInfo`/`ModelMetadata` types.
  - `src/warning.ts` — `createWarning(sessionID, text, lastUser)` builds the transient synthetic user message; returns `{ info, parts }`.
  - `src/compaction.ts` — `V2CompactClient` type, `extractError`, `CompactStrategy` seam, `V2CompactStrategy` (awaited), `V1SummarizeStrategy` (raced vs `timeoutMs` to avoid the self-deadlock), `Compactor` (fallback chain + result string), `requestPostCompact(prompt, input, text)` (fire-and-forget post-compaction message).
  - `src/notify.ts` — `Notifier` seam over `client.tui.showToast` + `client.app.log`; `toast(text, variant): Promise<boolean>` (error toasts always fire), `log` (verbose-gated), `alwaysLog`.
  - `src/index.ts` — composition root: `ContextWatchPlugin` factory wires hook events → domain modules; re-exports `resolveOptions`, `ConfigProblem`, `ContextWatchOptions`, `V2CompactClient` for the public API/tests.
- **Test seams preserved**: `plugin({ client }, { configPath, createOpencodeClientV2, summarizeTimeoutMs })`; tests import `../src/index` (default export + `resolveOptions` + `V2CompactClient`).
- **Key domain invariants to keep during the v2 port**: the warning injection is TRANSIENT (push on EVERY `messages.transform` while above threshold; rearm gates only toast+log); token ground truth = last completed assistant message's `input+output+reasoning+cache.read+cache.write` (never sum `tokens.input`); v2 `compact` lives on `v2Client.v2.session` (Session3); v1 `summarize`/`promptAsync` on top-level `client.session.*`; `auto:true` needed for the autocontinue hook; v2 import must be the `/v2/client` subpath (full `/v2` breaks `bun build`); the v1 summarize must be raced (not awaited) to avoid the session-loop self-deadlock (upstream #5449).
- **Current model**: `opencode/deepseek-v4-flash-free` 200k window (NOT 1M — that's `deepseek/deepseek-v4-flash`).
- `CONTEXT.md` created at repo root — ubiquitous-language glossary (Session, Context window, Context usage, Threshold band, Rearm, Warning injection, Compaction, Compaction strategy, Post-compaction message, Model info cache, Config problem) + module map.

## File layout

- `src/index.ts` — composition root (was the whole monolith).
- `src/config.ts`, `src/context.ts`, `src/model-info.ts`, `src/warning.ts`, `src/compaction.ts`, `src/notify.ts` — new domain modules.
- `tests/context.test.ts` — new unit tests: `assess`, `renderMessage`, `createWarning`, `ModelInfoCache`, `contextTokens`.
- `tests/compactor.test.ts` — new unit tests: `Compactor`, `V2CompactStrategy`, `V1SummarizeStrategy`, `extractError`, `requestPostCompact`.
- `CONTEXT.md` — domain glossary.
- `docs/plan/ddd-refactor-and-v2.md` — this plan.
- (next) `v2` branch work — to be defined once the opencode v2 plugin API is researched.

## Execution status

- [x] Architecture review (`/tmp/architecture-review-1786456542.html`, 4 candidates; Mermaid diagrams fixed — `@`/`/` in node labels and `()` in edge labels must be quoted).
- [x] DDD split of `src/index.ts` into the modules above.
- [x] New unit tests `tests/context.test.ts` + `tests/compactor.test.ts`.
- [x] Full gate green: `bun test` 106 pass / 0 fail; `npx tsc --noEmit` clean; `npx tsc -p tsconfig.test.json --noEmit` clean; `bunx biome check .` clean; `bun build src/index.ts --outdir dist` OK.
- [x] `CONTEXT.md` glossary written.
- [~] AGENTS.md update — started, NOT finished: the "Critical Implementation Notes" still reference old `src/index.ts` line numbers and the old single-file layout; must be rewritten to point at the new modules.
- [ ] Commit the DDD refactor on `main` (NOT yet committed — files are uncommitted in the worktree).
- [ ] Create branch `v2` from refactored `main`.
- [ ] Research opencode v2 plugin API (hooks, client, tool registration, model info shape).
- [ ] Modify the plugin for v2 behind the new seams; update tests; verify full gate.
- [ ] Update `docs/design.md` + ADRs if the v2 port changes the architecture.

## Deviation log

- [2026-08-11] `Notifier.toast` returns `Promise<boolean>` (not `void`) so the config-error toast retry logic can tell success from failure.
- [2026-08-11] `requestPostCompact` takes a `PostCompactPrompt` adapter function (`(sessionID, agent, text) => Promise<unknown>`) instead of the raw client — keeps the SDK `promptAsync` type at the composition root and the module SDK-agnostic.
- [2026-08-11] `Compactor` log messages changed wording vs the old `triggerCompact` logs ("compaction requested via v2 compact" / "compaction request failed (v2 compact)") — verbose-gated diagnostics, not asserted by tests.
- [2026-08-11] The prepare-compact skill was invoked mid-goal (context at 77%): this plan doc is the resume checkpoint; the goal will be cleared and re-created after compaction.

## Session-critical facts

- Repo: `/home/fazuh/Projects/opencode-context-watch` on branch `main` (clean except uncommitted DDD refactor).
- Uncommitted (all verified): `src/index.ts`, `src/compaction.ts`, `src/config.ts`, `src/context.ts`, `src/model-info.ts`, `src/notify.ts`, `src/warning.ts`, `tests/compactor.test.ts`, `tests/context.test.ts`, `CONTEXT.md`, and a half-finished `AGENTS.md` edit.
- Verify: `bun test` (106 pass), `npx tsc --noEmit`, `npx tsc -p tsconfig.test.json --noEmit`, `bunx biome check .`, `bun build src/index.ts --outdir dist`.
- Commit conventions: Conventional Commits with `changelog:` body key (`docs/dev/commit-changelog.md`); scopes (`docs/dev/commit-scopes.md`). A refactor → `refactor(plugin): ...` with NO `changelog:` line (internal).
- The global opencode config (`~/.config/opencode/opencode.json`) registers `opencode-context-watch@0.1.2` — do NOT edit it.
- No dev server / PTY running. No secrets involved.

## Resume checkpoint

- Goal to re-create: Create a branch named 'v2' to modify the opencode-context-watch plugin for opencode v2. Before the v2 work, refactor the codebase first applying DDD (Domain-Driven Design) principles, informed by the improve-codebase-architecture skill.
- Next step: finish the AGENTS.md "Critical Implementation Notes" rewrite (point at the new modules, drop stale line numbers), then commit the refactor on `main` — e.g. `refactor(plugin): split monolith into DDD domain modules` (no `changelog:` line) — then `git checkout -b v2`.
- Verify with: `bun test` (106 pass), `bunx biome check .`, `npx tsc --noEmit` — then `git status` clean on `main`, then confirm `git branch` shows `v2`.
- Context to re-read first: `CONTEXT.md` (glossary + module map), `docs/plan/ddd-refactor-and-v2.md` (this plan), `src/index.ts` (composition root), `docs/design.md`.
- Open questions: What is the opencode v2 plugin API? (hooks naming, client structure, tool registration, model-info shape — research `@opencode-ai/plugin` v2 / opencode v2 docs before porting.)
