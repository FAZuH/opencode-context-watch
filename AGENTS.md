# AGENTS.md - opencode-context-watch

## Overview

An opencode plugin that warns when a session's context window usage crosses a configurable threshold, injecting a synthetic user message so the model can prepare for compaction. One entry runs on opencode v1 (1.18.x) and opencode v2 (2.0 beta).

## Build Commands

```bash
# Typecheck
npx tsc --noEmit

# Test typecheck (tests typechecked separately; root tsconfig is src-only)
npx tsc -p tsconfig.test.json --noEmit

# Tests (bun:test, tests/ dir)
bun test

# Bundle check
bun build src/index.ts --outdir dist

# Format (biome)
bunx biome format --write .

# Lint (biome)
bunx biome check .
```

Note: `biome.json` at the repo root ignores `.github/.config.cjs` (release-changelog
tooling) and formats JSON files with 2-space indent to match the committed style.
`bunx biome check .` is clean at HEAD.

## Critical Implementation Notes

### Runtime autodetection — one entry, both runtimes

- `src/index.ts` exports a plain object: `export default { id: "opencode-context-watch", server: async (input, pluginOptions) => createV1Backend(...), setup: (ctx) => V2Backend.create(ctx as V2PluginContext) }`. There is NO version-detection code — the loader's calling convention selects the backend. The v1 loader calls `server(input, options)` and receives the Hooks object. The v2 loader validates the object, reads `id`, and calls `setup(ctx)`. No runtime `@opencode-ai/plugin` import — structural types only. No beta packages are installed (they would break the v1 tests).
- The backend seam is `src/backend/`: `types.ts` (`BackendSeams` — `configPath`, `createOpencodeClientV2`, `createOpencodeClientV2Beta`, `summarizeTimeoutMs` — and the state-first `RuntimeBackend` port: `compact`, `postCompact`, `notifier`, `modelCache`, `lastWarned`, `seams?`), `v1.ts` (`V1Backend`), `v2.ts` (`V2Backend`). The domain modules are version-free; each backend adapts its runtime's events onto the port.
- V2 backend facts (probe-verified on real opencode2 next-17155):
  - Context-hook messages are `{ id, role, content: [{ type, text }], metadata }` — `content`, NOT the v1-style `parts`. The warning is hand-built to that shape. Inject on EVERY `session.hook("context")` call above the band; rearm gates only notify.
  - Tokens arrive as `TokenUsageInfo` on `session.step.ended` / `session.usage.updated` inside `event.subscribe()`. `tokensFromUsage` sums `input + output + reasoning + cache.read + cache.write`, only when `input > 0 && output > 0` (matches v1 pickiness).
  - Window lookup: `catalog.transform(draft => draft.model.get(providerID, modelID))`; the draft callback runs synchronously. The domain `catalog.model` has NO `get` (only `{ list, default }`).
  - Tool seam: `add({ name, description, input, options: { codemode: false }, execute })`; `execute` MUST return `{ content: string }`. The two-arg `add(name, def)` crashes this build; a bare-string return crashes the runner.
  - Compact: own client via a guarded split-specifier dynamic import of `@opencode-ai/client/promise` (`V2BetaCompactStrategy`, name "v2 beta compact", never throws). Unresolvable → honest `"Compaction failed: v2 beta compact client unavailable"`.
  - Post-compact continue: `ctx.session.prompt({ sessionID, text })` on `session.compaction.ended` when `postCompactContinue` is on. Notify is console-only (no server toast in the v2 beta).
- `src/context.ts` holds the shared `notifyWarning(...)` helper — the ONE impure helper there, documented — plus `tokensFromUsage`. `src/compaction.ts` adds `V2BetaCompactClient` / `V2BetaCompactStrategy` behind the existing `CompactStrategy` seam.

### v1 runtime (opencode 1.18.x)

- The injected warning is TRANSIENT — it is pushed into the current transform call's in-memory messages array and is never persisted to the session store. The session loop re-reads messages from the store each step, so the warning must be pushed on EVERY `experimental.chat.messages.transform` call while above threshold. The rearm band (`lastWarned`) gates only the toast + verbose log, NOT the injection.
- Token ground truth = the most recent completed assistant message's `input + output + reasoning + cache.read + cache.write` (matches the TUI context meter). Do not sum `tokens.input` across messages — each assistant message's `tokens.input` is the whole context at request time and would overcount.
- The model window is cached per sessionID via `experimental.chat.system.transform` (`input.model.limit.context`); `messages.transform` has no model info.
- The current model `opencode/deepseek-v4-flash-free` has a 200k window (NOT 1M — that's `deepseek/deepseek-v4-flash`).
- Config is read once at load time; changes require an opencode restart.
- Config validation lives in `resolveOptions(raw, env)` (pure, exported): env > file > default precedence, per-key fallback to defaults, each bad value reported as a `{ key, message }` problem. Invalid config shows a TUI error toast (variant `error`) at load + once more on the first `messages.transform` if the load toast failed; it ALWAYS fires even when `toast: false`. The toast path is race-free (synchronous flags, no `.then` mutation, attempts capped at 3).
- Tests use a test-only `configPath` seam — a `BackendSeams` option carried on the v1 backend's plugin options — because Node/bun `os.homedir()` caches after the first call; per-test HOME isolation does NOT work. The harness calls `plugin.server(input, options)`.
- The `compact_context` tool is ALWAYS registered; `execute(args, ctx)` calls `triggerCompact(ctx.sessionID)`. Primary path: the lazily-built v2 client, `await v2Client.v2.session.compact({ sessionID })`. On any v2 failure or resolved-error it falls back to v1 `client.session.summarize({ path: { id: sessionID }, body: { providerID, modelID, auto: true } })`, using the per-session model info cached by `experimental.chat.system.transform` (`providerID` from `input.model.providerID`, `modelID` from `input.model.id`, window from `input.model.limit.context`). If the cache has no model for the session, it returns `"Compaction failed: <detail>"` WITHOUT calling summarize. `auto: true` makes opencode's `experimental.compaction.autocontinue` hook fire for tool-triggered compactions. The v2 `session.compact` endpoint is a server-side hard stub on opencode 1.18.11 (resolves `{ error: { _tag: "ServiceUnavailableError", message: "Session compact is not available yet" } }`), so on that build the summarize fallback is the path that actually compacts. The old v1 command fallback is DROPPED — proven dead (`UnknownError` on 1.18.11). It NEVER throws — returns "Compaction requested." / "Compaction failed: <err>".
- The v2 client is built lazily once at load via dynamic `import("@opencode-ai/sdk/v2/client")` + `createOpencodeClient({ baseUrl: serverUrl?.href })` — `PluginInput.serverUrl` is a URL, so pass `.href`. The import MUST be the client-only `/v2/client` subpath: the full `/v2` entry pulls in `cross-spawn`/`child_process` and breaks `bun build` browser-mode. A missing/failed v2 import degrades to the v1 fallback (never crashes plugin load). Test seam: the `createOpencodeClientV2` BackendSeams option returning a structural `V2CompactClient` (`{ v2: { session: { compact } } }`).
- SDK 1.18.11 gotcha: v1 `command`/`promptAsync` live on top-level `client.session.*`, NOT `client.app.session.*` (`App` only has `log`/`agents`); v2 `compact` lives on `v2Client.v2.session` (Session3), NOT top-level `v2Client.session` (Session2 lacks `compact`).
- `experimental.compaction.autocontinue` hook: always set `output.enabled = false` (suppress opencode's synthetic continue). When `postCompactContinue: true`, also fire-and-forget `client.session.promptAsync({ path: { id: input.sessionID }, body: { agent: input.agent, parts: [{ type: "text", text: opts.postCompactMsg }] } })` — a REAL persisted user message (`.catch` + log, tolerated races, never throws). When off, nothing is sent after compaction.
- Config keys: `postCompactContinue` (boolean, default `false`; when true, send a message after compaction; env `CONTEXT_WATCH_POST_COMPACT_CONTINUE` accepts literal "true"/"false"/numeric strings — anything else pushes a problem and falls back to file/default) and `postCompactMsg` (string, default "[context-watch] Session context was compacted. Continue your work from where you left off, keeping replies concise."; env `CONTEXT_WATCH_POST_COMPACT_MSG`).

## Code Style

- TypeScript, strict mode, `tsconfig.json` at repo root (lib es2022 + dom, types node).
- No comments unless they explain non-obvious behavior (this plugin has several such comments; keep them).
- Conventional Commits with `changelog:` body key per `docs/dev/commit-changelog.md` conventions; scopes per `docs/dev/commit-scopes.md`.

## Agent skills

### Issue tracker

Issues live in the GitHub repo (`FAZuH/opencode-context-watch`) via `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-roles vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at repo root, ADRs in `docs/decisions/` (not `docs/adr/`). See `docs/agents/domain.md`.

## License

MIT
