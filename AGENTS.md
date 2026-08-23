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
- The backend seam is `src/backend/`: `types.ts` (`BackendSeams` — `configPath`, `createOpencodeClientV2`, `createOpencodeClientV2Beta`, `summarizeTimeoutMs`, `createWatcher` — and the state-first `RuntimeBackend` port: `compact`, `postCompact`, `notifier`, `modelCache`, `lastWarned`, `live`, `seams?`), `v1.ts` (`V1Backend`), `v2.ts` (`V2Backend`). The domain modules are version-free; each backend adapts its runtime's events onto the port.
- V2 backend facts (probe-verified on real opencode2 next-17155; re-probed + E2E-verified on 0.0.0-beta-17898, see `.scratch/2026-08-22_v2-plugin-fix/`):
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
- Config is read once at load time; the `context_watch_settings` tool's `reload` action re-reads it live without an opencode restart.
- Config validation lives in `resolveOptions(raw, env)` (pure, exported): env > file > default precedence, per-key fallback to defaults, each bad value reported as a `{ key, message }` problem. Invalid config shows a TUI error toast (variant `error`) at load + once more on the first `messages.transform` if the load toast failed; it ALWAYS fires even when `toast: false`. The toast path is race-free (synchronous flags, no `.then` mutation, attempts capped at 3).
- Tests use a test-only `configPath` seam — a `BackendSeams` option carried on the v1 backend's plugin options — because Node/bun `os.homedir()` caches after the first call; per-test HOME isolation does NOT work. The harness calls `plugin.server(input, options)`.
- The `compact_context` tool is ALWAYS registered; `execute(args, ctx)` calls `triggerCompact(ctx.sessionID)`. Primary path: the lazily-built v2 client, `await v2Client.v2.session.compact({ sessionID })`. On any v2 failure or resolved-error it falls back to v1 `client.session.summarize({ path: { id: sessionID }, body: { providerID, modelID, auto: true } })`, using the per-session model info cached by `experimental.chat.system.transform` (`providerID` from `input.model.providerID`, `modelID` from `input.model.id`, window from `input.model.limit.context`). If the cache has no model for the session, it returns `"Compaction failed: <detail>"` WITHOUT calling summarize. `auto: true` makes opencode's `experimental.compaction.autocontinue` hook fire for tool-triggered compactions. The v2 `session.compact` endpoint is a server-side hard stub on opencode 1.18.11 (resolves `{ error: { _tag: "ServiceUnavailableError", message: "Session compact is not available yet" } }`), so on that build the summarize fallback is the path that actually compacts. The old v1 command fallback is DROPPED — proven dead (`UnknownError` on 1.18.11). It NEVER throws — returns "Compaction requested." / "Compaction failed: <err>".
- The v2 client is built lazily once at load via dynamic `import("@opencode-ai/sdk/v2/client")` + `createOpencodeClient({ baseUrl: serverUrl?.href })` — `PluginInput.serverUrl` is a URL, so pass `.href`. The import MUST be the client-only `/v2/client` subpath: the full `/v2` entry pulls in `cross-spawn`/`child_process` and breaks `bun build` browser-mode. A missing/failed v2 import degrades to the v1 fallback (never crashes plugin load). Test seam: the `createOpencodeClientV2` BackendSeams option returning a structural `V2CompactClient` (`{ v2: { session: { compact } } }`).
- SDK 1.18.11 gotcha: v1 `command`/`promptAsync` live on top-level `client.session.*`, NOT `client.app.session.*` (`App` only has `log`/`agents`); v2 `compact` lives on `v2Client.v2.session` (Session3), NOT top-level `v2Client.session` (Session2 lacks `compact`).
- `experimental.compaction.autocontinue` hook: always set `output.enabled = false` (suppress opencode's synthetic continue). When `postCompactContinue: true`, also fire-and-forget `client.session.promptAsync({ path: { id: input.sessionID }, body: { agent: input.agent, parts: [{ type: "text", text: opts.postCompactMsg }] } })` — a REAL persisted user message (`.catch` + log, tolerated races, never throws). When off, nothing is sent after compaction.
- Config keys: `postCompactContinue` (boolean, default `false`; when true, send a message after compaction; env `CONTEXT_WATCH_POST_COMPACT_CONTINUE` accepts literal "true"/"false"/numeric strings — anything else pushes a problem and falls back to file/default) and `postCompactMsg` (string, default "[context-watch] Session context was compacted. Continue your work from where you left off, keeping replies concise."; env `CONTEXT_WATCH_POST_COMPACT_MSG`).

### Live settings — settings tool, config-file bridge, TUI commands

- `src/live.ts` is the live mutable state behind the tool: `LiveConfig` holds
  `options` (the SAME object identity the per-event hooks read — reload does an
  in-place `Object.assign`, so new thresholds/message/notify flags apply with
  zero re-registration), an `enabled` gate backed by the `enabled` CONFIG KEY
  (default `true`; the settings tool's `disable`/`enable` persist it to the
  config file via `updateConfigFile`, and `reload` re-applies the file value),
  and `notifyFlags` passed to the `Notifier` by reference so `toast`/`verbose`
  flip live. `handleSettingsAction`
  is the shared execute switch; `SETTINGS_TOOL_DESCRIPTION` and
  `RELOAD_PROBLEM_LABEL` are the shared strings. The `RuntimeBackend` port
  carries `live`.
- Actions: `reload` re-reads the config file + env overrides via the pure
  `loadOptions` (reports problems, never throws; clears per-session `lastWarned`
  and, on v2, the `windowLookups`/`modelWindows` caches so a `windowTokens`
  null<->N change re-resolves); `disable`/`enable` persist `enabled: false|true`
  to the config file and gate ONLY warning injection
  + notifications (v1 `messages.transform` and v2 `onContext` early-return
  after the sessionID check — `compact_context`, autocontinue, post-compact
  continue and the config-error reporting stay active while disabled);
  `status` returns the current settings summary; an unknown/missing action
  returns a help string. It NEVER throws.
- The tool, not a slash command: neither runtime lets a plugin register slash
  commands (v2 `CommandDraft` has only `list/get/update/remove`; v1 commands
  come from markdown/config files and `command.execute.before` can't skip the
  LLM on 1.18.x), so the tool is the cross-runtime seam (same as
  `compact_context`). Users invoke it by telling the model.
- v1 args use a REAL zod schema: `args: { action: z.enum([...]) }` — `zod` is
  now a runtime dependency (`^4.1.8`, previously only transitive); still no
  runtime `@opencode-ai/plugin` import. v2 uses the plain JSON-Schema `input`
  (`required: ["action"]`) + `options: { codemode: false }` + `{ content }`
  return, same seam as `compact_context`.
- Runtime-probe-verified (2026-08-13): opencode2 v0.0.0-next-17155 —
  status/disable/reload executed and returned the correct strings, env
  overrides visible in status, both tools coexist in one session. opencode v1
  1.18.18 — zod args accepted, tool executed, statusText returned.
- v2 `ctx.options` overlay (beta-17898): the object-form plugins entry
  `{ package, options }` passes options as `ctx.options`; the v2 backend
  layers it over the file's raw values via `loadOptions(configPath, overlay)`
  so per-key precedence becomes env > ctx.options > file > default. The
  overlay is stored on `LiveConfig` so reload re-applies it. V1 has no overlay.
- Config-file bridge: the TUI commands write the config file directly and a
  server-side watcher applies the changes live.
  - `src/watch.ts` `watchConfigFile(configPath, onChange, debounceMs = 150)`:
    watches the PARENT directory (the commands write atomically via `.tmp` +
    renameSync, which replaces the inode), filters by basename, debounces,
    always attaches an `'error'` listener; never throws; `close()` clears the
    pending debounce timer. Both backends wire onChange to `live.reload()` +
    `lastWarned.clear()` (v2 also clears `windowLookups`/`modelWindows`) +
    reload-problem reporting. The v1 Hooks object has NO dispose point, so the
    v1 watcher lives for the plugin lifetime; v2 closes it first in its cleanup.
  - `src/tui.ts` is a SEPARATE plugin entry (`{ id, tui, setup }`) because
    both loaders reject a module default-exporting `server` AND `tui`; the v2
    beta TUI host instead validates `{ id, setup }` and rejects modules
    without `setup`, so one object carries both functions (each loader uses
    its own key and tolerates the other's); register it by FILE path in
    `tui.json`. `buildTuiHandlers(deps)` holds the four shared never-throw
    bodies; `buildTuiCommands(deps)` shapes them for v1 and
    `buildV2KeymapCommands(deps)` for v2 — ONE `ctx.keymap.layer`
    (`mode: "global"`, palette-only commands `bind: false`, group
    "Context-watch", slash `/context-watch-*`; ids `context_watch.*`);
    registrations auto-unwind on activation dispose. V2 mounts the layer via
    an invisible `ui.slot({ append: "app" })` whose render runs inside the
    app's provider tree — a DIRECT `ctx.keymap.layer(...)` call from setup
    throws (`Keymap.Provider is missing`) because activation is a plain async
    function outside the Solid tree. Reload refuses to create
    a missing config file; status resolves displayed settings with
    `process.env` (`ctx.options` is not available in the TUI host). Tool
    disable/enable and TUI disable/enable persist the same `enabled` key via
    `updateConfigFile`.
- Tests inject a FAKE watcher via the `createWatcher` BackendSeams option:
  bun's parallel runner surfaces real fs.watch handles from removed tmp dirs
  as "Unhandled error between tests", so only dedicated watch tests use the
  real watcher.
- Optional (not shipped): a user who wants a real slash command can define one
  themselves (config `command` key or a markdown command file); the plugin can
  react via `command.execute.before` (v1) / `command.executed` event (v2).

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
