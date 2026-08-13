# Plan: autodetect opencode v1 vs v2 and select the runtime backend

## Objective

Ship ONE `opencode-context-watch` package that runs under **both** opencode
1.18.x and opencode 2.0 beta, with no user-visible choice. The plugin
autodetects which runtime loaded it and wires the correct backend (the "API
backend/service layer"). This supersedes the branch-based v2-port strategy in
`docs/plan/complete/ddd-refactor-and-v2.md` (a separate `v2` branch shipping a
v2-only entry).

Concrete outcomes:

1. `main` runs the current v1 behavior with zero regressions (106 tests green).
2. A single default export loads under BOTH runtimes:
   - v1 loader calls the default export as a function `(input, options)`.
   - v2 loader reads the default export's `id` and calls `setup(ctx)`.
3. The runtime choice is invisible to the domain modules — they keep talking
   to one `RuntimeBackend` port.
4. Full gate green (`bun test`, both `tsc`, biome, `bun build`) under the
   installed `@opencode-ai/plugin` version.

## Decisions & constraints

- **Detection = the loader's calling convention, not a version probe.** The
  two loaders dispatch on the default export's SHAPE: v1 (`readV1Plugin`
  detect-mode) reads `id` + `server()`; v2 validates an object and reads
  `id` + `setup`. Export a plain object
  `{ id, server: async (input, options) => v1Path, setup: async (ctx) => v2Path }`
  — one object satisfies both loaders. No `process.env` sniffing, no version
  string parsing. (VERIFIED 2026-08-13 with a real opencode2 probe: v2
  REJECTS a function default, ACCEPTS the plain object.)
- **No runtime import of `@opencode-ai/plugin` in the shared entry.** The v1
  `tool()` helper is identity (`node_modules/@opencode-ai/plugin/dist/tool.js`
  returns `input`), and v2 `Plugin.define` is identity too. Build the tool
  definition structurally and skip both, so the entry has NO static dependency
  on whichever `@opencode-ai/plugin` version is installed. Types come from
  `import type` (erased at runtime).
- **DDD seam: a `RuntimeBackend` port.** The domain modules (`config`,
  `context`, `model-info`, `warning`, `notify`) are already version-agnostic —
  they accept structural clients/adapters. The new seam is between the entry
  and the domain: `V1Backend` and `V2Backend` both implement
  `RuntimeBackend`, exposing `registerCompactTool`, `onMessagesTransform`,
  `onSystemTransform`, `onAutocontinue`, `compact`, `postCompact`,
  `notify`.
- **`@opencode-ai/plugin` stays a devDependency** (not a runtime dep) for
  types only. The v2 beta package ships a `./v1` subpath re-exporting the v1
  API, so a v2-install can typecheck the v1 adapter too — but both type
  surfaces must resolve under whichever version is installed. This is the
  main open question (type strategy below).
- **Config stays file-based** (`loadOptions(configPath)` via the existing
  `configPath` seam). v2 additionally passes plugin options as `ctx.options`,
  but the file remains authoritative and unchanged.
- **Keep all existing domain invariants**: transient warning injection on
  EVERY transform call above threshold (rearm gates only toast/log); token
  ground truth = last completed assistant message's
  `input+output+reasoning+cache.read+cache.write` (never sum `tokens.input`);
  `auto:true` on v1 summarize for the autocontinue hook; v1 summarize raced
  against a timeout (session-loop self-deadlock, upstream #5449).
- **No `bun build` regression.** The v2 SDK client import stays the client-only
  `/v2/client` subpath (full `/v2` pulls in node builtins and breaks the
  browser-mode bundle).

## File layout

- `src/index.ts` — entry: `Object.assign(v1Factory, { id, setup })` default
  export; delegates to the detected backend. Re-exports the public surface
  (`resolveOptions`, `ConfigProblem`, `ContextWatchOptions`, `V2CompactClient`).
- `src/backend/types.ts` — `RuntimeBackend` port interface (new).
- `src/backend/v1.ts` — `V1Backend`: adapts the v1 `(input, options) => Hooks`
  factory; moves the current `index.ts` hook wiring + `NotifyClient` +
  v2-compact-client strategy list here.
- `src/backend/v2.ts` — `V2Backend`: adapts `setup(ctx)`; uses
  `ctx.session.hook("context")` (inject `Message.user(text)`), `ctx.event.subscribe()`
  (cache `SessionStepEnded`/`SessionUsageUpdated` `data.tokens`), catalog
  window lookup, `ctx.tool.transform` for `compact_context`, own
  `@opencode-ai/client/promise` `OpenCode.make` client for `session.compact`,
  `ctx.session.prompt({ sessionID, text })` for post-compact continue,
  console-only notify (no server-side toast in v2 beta).
- `src/context.ts`, `src/model-info.ts` — add thin adapters for the v2 token
  shape (`TokenUsageInfo` -> the pure `contextTokens` input) as needed.
- `tests/backend.test.ts` — new: entry-shape tests (default export is callable
  AND has `id`/`setup`), `V1Backend` and `V2Backend` against fake
  input/ctx shapes.
- `tests/plugin.test.ts`, `tests/compact.test.ts` — keep, adapted to the new
  entry (they exercise the v1 path via the callable default).

## Design

### Entry shape (the autodetect)

```ts
const plugin = {
  id: "opencode-context-watch",
  server: async (input: PluginInput, options?: PluginOptions) =>
    createV1Backend(input, options),
  setup: async (ctx: PluginContext) => createV2Backend(ctx),
};
export default plugin;
```

- v1 loader: `readV1Plugin(mod, spec, "server", "detect")` sees `id` + `server()`
  on the object and calls `plugin.server(input, options)` → v1 path.
- v2 loader: validates `default` is an object, reads `id` + calls
  `setup(ctx)` → v2 path. Extra keys (like `server`) are ignored.
- VERIFIED 2026-08-13 against real opencode2 (0.0.0-next-17155): the v2
  loader REJECTS a callable default (`Object.assign(async fn, { id, setup })`)
  with `SchemaError(Expected object, got async function ...)` but ACCEPTS the
  plain object `{ id, server, setup }`. No version detection code runs at all —
  the caller's contract selects the backend. Both backends construct the same
  domain core (config resolution, `ModelInfoCache`, `Compactor`, `Notifier`),
  differing only in how they adapt hook events, tool registration, and the
  compact client.
- No runtime `import` of `@opencode-ai/plugin` anywhere; both type surfaces
  stay structural or `import type`-only (erased).

### `RuntimeBackend` port (both backends implement this)

The shared domain core both runtimes build and route their hook logic
through. State-first, not registration-callback-first: the v1 loader forces
`server()` to return the v1 `Hooks` object and v2 wires events via `ctx`, so
the genuinely shareable surface is the state + operations the hook logic
drives, not the event registration itself:

- `seams?: BackendSeams` — adapter-provided test seams (v1 plugin options; v2
  passes none).
- `compact(sessionID, model): Promise<string>` — trigger compaction, resolves
  the agent-facing result string.
- `postCompact(input, text): void` — resume the session after a compaction
  (fire-and-forget, never throws).
- `notifier: Notifier` — toast + app log under v1, console-only under v2.
- `modelCache: ModelInfoCache` — per-session model info, fed by each runtime's
  model events.
- `lastWarned: Map<string, LastWarned>` — per-session rearm state.

V1 maps these onto the returned `Hooks` object keys
(`tool.compact_context`, `experimental.chat.messages.transform`,
`experimental.chat.system.transform`, `experimental.compaction.autocontinue`)
and `client.*` calls. V2 maps them onto `ctx.session.hook("context")`,
`ctx.tool.transform`, `ctx.event.subscribe()`, `ctx.session.prompt`, and its
own compact client. The domain core is shared and version-free; the pure
assess/inject logic stays in the domain modules (`assess`, `contextTokens`,
`renderMessage`, `createWarning`) and both backends call it directly.

### Compaction strategy under v2

The current `CompactStrategy` seam stays. Under v2, the compact call moves to
the plugin's own `@opencode-ai/client/promise` client
(`OpenCode.make({ baseUrl, headers })` from `Service.discover()` +
`Service.headers(endpoint)`); add a `V2BetaCompactStrategy` behind the seam.
The v1 `V2CompactStrategy` + `V1SummarizeStrategy` remain the v1 path.

## Execution

1. **Verify the dual-shape default export loads in real opencode2** (beta).
   Probe plugin (`{ id, setup }` on a callable default) via
   `opencode2 plugin list` + `opencode2 api get /api/plugin`. This validates
   the linchpin assumption before any refactor. If the v2 loader rejects
   callable-with-properties, fall back to `Plugin.define`-guarded dynamic
   import detection.
2. **Add `src/backend/` seam** — extract the current `index.ts` hook wiring
   into `V1Backend`; keep `plugin.test.ts`/`compact.test.ts` green.
3. **Add the v2 backend** behind the same port, driven by the verified beta
   API map (see `docs/plan/ddd-refactor-and-v2.md` Design section).
4. **Entry rework** — dual-shape default export; type strategy per open
   question below.
5. **Tests** — entry-shape unit tests + v2-backend tests with fake ctx;
   adapt existing tests.
6. **Full gate** — `bun test`, `npx tsc --noEmit`,
   `npx tsc -p tsconfig.test.json --noEmit`, `bunx biome check .`,
   `bun build src/index.ts --outdir dist`. Then re-run the v2-probe with the
   real plugin.
7. **Docs** — update `AGENTS.md`, `CONTEXT.md`, `docs/design.md`; write an ADR
   (runtime autodetection) in `docs/decisions/`; archive the v2-branch plan.
8. Commit on `main` (conventional commit, `changelog:` body key).

Delegate: `implement` for the refactor, `test` for the gate, `review` after.

## Open questions

- **Type strategy for both v1+v2 under one install.** RESOLVED by the probe:
  structural types only (like the existing `V2CompactClient`). The entry is a
  plain object; no `@opencode-ai/plugin` import at runtime or type-time is
  needed for the entry. Backend adapters type their input structurally against
  `import type` surfaces where available.
- ~~Does opencode2's loader validate `typeof default.setup === "function"` on
  an object, or does it require the exact `Plugin.define` result?~~ RESOLVED
  by probe: plain object `{ id, server, setup }` loads fine; `Plugin.define`
  not required.
- **`Message.user(text)`** (from `@opencode-ai/ai`) — confirm it produces a
  part suitable for the mutable `messages` array in `session.hook("context")`.
- **Window lookup**: `catalog.model.get(providerID, id)` is on the transform
  `CatalogDraft`, not `CatalogDomain` (domain `model` API = `{ list, default }`)
  — verify the correct read path.

## Execution status

- [x] `setup-mattpocock-skills` run on `main` — `AGENTS.md` Agent skills block + `docs/agents/{issue-tracker,triage-labels,domain}.md` written (uncommitted).
- [x] Restored v1 deps on `main` (`bun install`) — the v2-branch `@opencode-ai/plugin@next` leftover in node_modules was breaking the gate. Gate green again: `bun test` 106 pass / 0 fail, both `tsc` clean, biome clean, `bun build` OK.
- [x] **Probe (real opencode2 0.0.0-next-17155)** — VERIFIED, linchpin solved:
  - v2 loader **rejects** `Object.assign(async fn, { id, setup })` (function default) — `SchemaError(Expected object, got async function ... at ["default"])`, logged `WARN failed to load plugin` at `~/.local/share/opencode/log/opencode.log`.
  - v2 loader **accepts a plain object default `{ id, setup }`** and calls `setup(ctx)`; extra keys like `server` are ignored. Probe logged `v2-setup` with real ctx keys: `app, options, agent, aisdk, catalog, command, event, integration, plugin, reference, skill, tool, websearch, session, shell`.
  - v1.18.11 loader (`packages/opencode/src/plugin/{index,shared}.ts`) accepts the SAME object via `readV1Plugin(..., "server", "detect")` — requires `id` + `server()` function, calls `plugin.server(input, options)`. The legacy function-default path (`getLegacyPlugins`) also still works on v1 but NOT v2.
  - **FINAL ENTRY SHAPE**: `export default { id, server: async (input, options) => V1Backend, setup: async (ctx) => V2Backend }`. No `Plugin.define`, no runtime `@opencode-ai/plugin` import, no `Object.assign` — the plan's type-strategy open question is resolved toward structural types (both loaders only inspect the object shape).
  - Probe artifacts: `/tmp/opencode/probe/{opencode.json,probe-plugin.mjs,probe.log}`; server log shows the rejection + acceptance.
- [x] **`src/backend/` seam + V1Backend extraction** — created `src/backend/{types,v1,v2}.ts`, reworked `src/index.ts` to the plain-object entry, harness calls `plugin.server(...)`. Gate green: 106 tests pass, both `tsc` clean, biome clean, `bun build` OK.
- [x] **V2Backend** — real implementation behind the same `RuntimeBackend` port, driven by the v2-branch API map + EXTENDED runtime probes against real opencode2 (next-17155). See Deviation log for the runtime-verified shape corrections. Gate green: 126 tests pass, both `tsc` clean, biome clean, `bun build` OK.
- [x] Type strategy decision + entry rework.
- [x] **Real opencode2 probe with the real plugin** — object entry loads (no SchemaError), `setup(ctx)` fires, async cleanup accepted, context hook injects the transient warning mid-session (proven via pipeline probe), window lookup via `catalog.transform(draft => draft.model.get(...))` returns the real window (262144, synchronous draft callback), event drain delivers TokenUsageInfo. `compact_context` executes directly after the `options: { codemode: false }` + `{ content }` return fix (probe-real2: model got `Compaction failed: v2 beta compact client unavailable` — the honest no-client degradation string). See Deviation log for the full findings.
- [ ] **Docs + archive + commit (PENDING)** — AGENTS.md, CONTEXT.md, design.md updated; ADR-003 written; v2-branch plan archived to `docs/plan/complete/`. Remaining: group commits + commit on `main` (delegate to `finish`, conventional commits, `changelog:` body key).

## Deviation log

- (2026-08-13) V2Backend runtime probes (real opencode2 next-17155, `/tmp/opencode/probe2/`) corrected several API-map assumptions from the v2-branch plan:
  - Context-hook `messages` are `{ id, role, content: [{ type, text }], metadata }` — **`content`, NOT the v1-style `parts`**. The injected warning is hand-built (`buildV2Warning`) as the same shape instead of `Message.user()`; injection suitability confirmed by a completed real session.
  - Window lookup: `catalog.model` (domain) root is `{ list, default }` — **NO `get`**. Window resolves only via `catalog.transform(draft => draft.model.get(providerID, modelID))` (the draft callback runs synchronously; the window is used on the same first hook). Guarded with a deferral path if a future draft is async-only.
  - `ctx.session` has NO `compact` (keys: hook/create/get/prompt/generate/command/synthetic/interrupt); own client via guarded split-specifier dynamic import of `@opencode-ai/client/promise` (unresolvable inside the loader on next-17155 → degrades to honest `"Compaction failed: v2 beta compact client unavailable"`).
  - Tool draft `add.length === 1`; string form `add("name", def)` breaks finalization (`TypeError: O.name.replace`); **object form `add({ name, description, input, execute })` finalizes cleanly**. `input` is a plain JSON-Schema object `{ type: "object", properties: {}, additionalProperties: false }` (no beta `effect` import on main); step 4's real probe must verify it finalizes.
  - Tokens on `session.step.ended` / `session.usage.updated` `data.tokens = { input, output, reasoning, cache: { read, write } }`; drained in a background `event.subscribe()` loop, cleaned up via `iterator.return()`.
  - No server-side toast in v2 beta → `NotifyClient` is console-only (toast no-op, app.log → console).
  - `V2ToolContext` uses structural `id` (API map documents `callID`) — execute only reads `sessionID`; verify field name in step 4.
  - `tokensFromUsage` matches v1 `contextTokens` pickiness (only a sum when `input > 0 && output > 0`) so a mid-stream zero-output sample never fires an early warning.
- (2026-08-13) Real-plugin probe (probe-real) found `tool.transform`-registered tools are model-VISIBLE but not EXECUTABLE on next-17155 (`Unknown tool: compact_context`). Probe-hook proved the working seam: `add({ name, description, input, options: { codemode: false }, execute })` dispatches DIRECTLY (no code-mode wrapper), and `execute` MUST return an object `{ content: string }` (bare strings crash the runner: `c is not an Object (evaluating '"output"in c')`). The docs' two-arg `add(name, tool, options?)` form crashes THIS build (`TypeError: O.name.replace`). Also refuted: the context-hook `event.tools` record is not an executor seam (no `execute` slot; dispatch keys off the Tool service registry). Applied + re-probed (probe-real2): the model executed `compact_context` and got the plugin's honest string `Compaction failed: v2 beta compact client unavailable` (no resolvable `@opencode-ai/client/promise` on this build → guarded import degrades cleanly). Verify `options.codemode` + object `add` against a NEWER beta when one ships.
- (2026-08-13) Shared `notifyWarning({ notifier, result, tokens, window, sessionID, messageCount, lastPart })` helper extracted into `src/context.ts` (the one impure helper there, documented) so the v1 and v2 backends share the shouldNotify log/toast glue instead of duplicating it (drift risk found in review).
- (2026-08-13) The `RuntimeBackend` port is state-first, not
  registration-callback-first. The planned ops (`registerCompactTool`,
  `onMessagesTransform`, `onSystemTransform`, `onAutocontinue`) are dropped;
  the implemented port carries the shared state + operations
  (`compact`, `postCompact`, `notifier`, `modelCache`, `lastWarned`, `seams`)
  and each backend adapts its own event registration onto it. Reason: the v1
  loader requires `server()` to return the v1 `Hooks` object and v2 wires
  events via `ctx`, so the shareable surface is the state the hook logic
  drives, not the registration itself. The pure assess/inject logic stays in
  the domain modules.
- (2026-08-13) Probe outcome superseded the planned entry shape. Planned
  `Object.assign(async fn, { id, setup })` is REJECTED by the v2 loader
  (function default fails schema validation). Verified replacement: plain
  object `{ id, server, setup }` — v1 calls `server(input, options)`, v2
  calls `setup(ctx)`. Also resolves the type-strategy open question toward
  structural types (no `@opencode-ai/plugin` import needed).

## Resume checkpoint

- Goal to re-create: Prepare opencode-context-watch for automatic detection of the running opencode version (v1 1.18.x vs v2 2.0 beta) so a single package selects the correct API backend/service layer, improving the DDD architecture as needed (improve-codebase-architecture informed).
- **Steps 2-4 DONE**: `src/backend/{types,v1,v2}.ts` seam; plain-object entry `{ id, server, setup }`; real V2Backend behind the same `RuntimeBackend` port; probe-verified tool seam (`options: { codemode: false }` + `{ content }` return); shared `notifyWarning` + picky `tokensFromUsage` in `src/context.ts`; `V2BetaCompactStrategy` in `src/compaction.ts`. Gate green at 126 tests. All runtime-verified v2 shape corrections + the tool-seam fix recorded in the Deviation log.
- Next step: **step 5 (COMMIT — docs/ADR/archive already written)** — `finish` subagent proposed 4 commit groups + 1 chore, awaiting user approval (orchestrator restated them in chat):
  1. `feat(plugin): add v2 token/notify helpers and beta compact strategy` — `src/compaction.ts`, `src/context.ts`, `tests/context.test.ts`.
  2. `feat(plugin): run one entry on opencode v1 and v2 via runtime autodetection` (with `changelog:` line) — `src/backend/{types,v1,v2}.ts`, `src/index.ts`, `tests/harness.ts`, `tests/backend-v2.test.ts`.
  3. `docs: document the v1/v2 runtime-autodetection design and archive the v2-branch plan` — `docs/design.md`, `docs/decisions/ADR-003-runtime-autodetection.md`, `docs/plan/autodetect-v1-v2.md`, staged rename `docs/plan/ddd-refactor-and-v2.md → docs/plan/complete/`.
  4. `docs: update agent docs for runtime autodetection and the agent-skills setup` — `AGENTS.md`, `CONTEXT.md`, `docs/agents/`.
  5. `chore: add papercut entries for opencode2 v2 probing friction` — `.papercuts.jsonl` (recommended; matches `df4ae81` precedent).
  - Flagged: `docs/dev/commit-changelog.md` (M, external tooling sync overwrite referencing nonexistent `crates/` members) — recommend leaving uncommitted/reverting; do NOT fold into groups.
  - Operational: the plan rename (group 3) is ALREADY STAGED in the index; clear the index or include the rename only in group 3. `main` is 2 commits ahead of origin (de6c359, 447c744); no push unless asked.
  - After commits: mark the last `[ ]` execution item done, then the plan is complete and the goal can be closed with evidence (126 tests green, real opencode2 next-17155 probe verified entry load + setup + injection + window lookup + compact_context execution, ADR-003, docs updated).
