# Plan: DDD refactor + opencode v2 port

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
- [x] AGENTS.md update — done (verified matching HEAD; notes already point at the new modules).
- [x] Commit the DDD refactor on `main` — `447c744 refactor(plugin): split monolith into DDD domain modules`.
- [x] Create branch `v2` from refactored `main`.
- [x] Research opencode v2 plugin API — **conclusive: 1.18.x `./v2/*` exports CANNOT express this plugin** (no message-transform hook, no tool registration, no event/session in PluginContext). Full v2 surface only in the 2.0 beta (`@opencode-ai/plugin@next`, `opencode2` binary, changing build to build).
- [ ] **DECISION PENDING** — what the `v2` branch should do (see Deviation log + Open questions).
- [ ] Modify the plugin for v2 behind the new seams; update tests; verify full gate.
- [ ] Update `docs/design.md` + ADRs if the v2 port changes the architecture.

## Deviation log

- [2026-08-11] `Notifier.toast` returns `Promise<boolean>` (not `void`) so the config-error toast retry logic can tell success from failure.
- [2026-08-11] `requestPostCompact` takes a `PostCompactPrompt` adapter function (`(sessionID, agent, text) => Promise<unknown>`) instead of the raw client — keeps the SDK `promptAsync` type at the composition root and the module SDK-agnostic.
- [2026-08-11] `Compactor` log messages changed wording vs the old `triggerCompact` logs ("compaction requested via v2 compact" / "compaction request failed (v2 compact)") — verbose-gated diagnostics, not asserted by tests.
- [2026-08-11] The prepare-compact skill was invoked mid-goal (context at 77%): this plan doc is the resume checkpoint; the goal will be cleared and re-created after compaction.
- [2026-08-11] **v2 research outcome (blocks the original port)**: opencode 1.18.x `@opencode-ai/plugin` `./v2/effect` + `./v2/promise` exports are NOT a usable migration target:
  - PluginContext (both flavors) exposes only `options`, `agent`, `aisdk`, `catalog`, `command`, `integration`, `plugin`, `reference`, `skill` — NO `session`, `tool`, or `event`.
  - No message-transform hook exists (v1 `experimental.chat.messages.transform` survives only in the v1 API). Closest: `aisdk.language` wraps `LanguageModelV3` at the LLM boundary (no token data).
  - No tool registration in the v2 context; v1 `tool()` remains the only path.
  - The full v2 surface (`ctx.session.hook("context")` mutable messages, `ctx.tool.transform`, `ctx.event.subscribe`) exists ONLY in the 2.0 beta (`@opencode-ai/plugin@next`, depends on `effect@4.0.0-beta`, `@opencode-ai/client`/`schema`/`ai`; installs as a separate `opencode2` binary). Docs call it beta, changing entrypoints/hooks/shapes build to build, with migration guidance "when it is ready".
  - Token ground truth in v2 = `EventSessionNextStepEnded.properties.tokens` (`{ input, output, reasoning, cache: { read, write } }`); window via `aisdk` model / `catalog.model.get(...).limit.context`.
- [2026-08-11] Given the above, the v2 branch cannot be a straight port today. Options under consideration: (a) scaffold the 2.0-beta port behind `@opencode-ai/plugin@next` (tracks an unstable API), (b) keep v1 as the live path and add a documented v2 adapter seam for when 2.0 stabilizes, (c) defer the branch work until the 2.0 API stabilizes.
- [2026-08-11] User decided (b-variant): **port to `@opencode-ai/plugin@next`** on the v2 branch, keeping `main` (v1, 1.18.x) as the live release. Beta deps installed (one-off `min-release-age` bypass granted): `@opencode-ai/{plugin,client,ai,schema}@0.0.0-next-16770` devDeps; **`@opencode-ai/sdk@1.18.11` verified still installed** (the npm "removed 1 package" was NOT the sdk).
- [2026-08-11] Installing the beta `@opencode-ai/plugin` REPLACED the v1 plugin package → `bun test` now fails at import (`Export named 'tool' not found in @opencode-ai/plugin/dist/promise/index.js`). Expected: the v1 entry shape is gone; the port must rewrite `src/index.ts` to `Plugin.define({ id, setup(ctx) })` before tests can pass again.
- [2026-08-11] **v2 beta API mapping VERIFIED against installed node_modules + /tmp/opencode tarballs** (recorded in the Design section below):
  - `import { Plugin } from "@opencode-ai/plugin"` → `Plugin.define({ id, setup(ctx) })` (promise flavor is the package root); Context = `{ app, options, agent, aisdk, catalog, command, event, integration, plugin, reference, session, shell, skill, tool, websearch }`; `setup` returns `Cleanup|void`.
  - `ctx.session.hook("context", cb)` → `SessionContext { sessionID, agent, model: Model.Ref, system (mutable), messages (mutable Array<Message>), tools }`; push `Message.user(text)` (from `@opencode-ai/ai`, `Message.user(content)` exists).
  - Window: `SessionContext.model` = `Model.Ref { id, providerID, variant? }`; resolve via catalog. **OPEN: `catalog.model.get(providerID,id)` is on the transform `CatalogDraft`, NOT `CatalogDomain`** (domain = `CatalogApi { provider: ProviderApi; model: ModelApi }` where ModelApi = `client["model"] = { list, default }`). Window lookup likely needs `ctx.catalog.model.list()` (HTTP) or a draft transform — verify during implementation.
  - Events: `ctx.event.subscribe()` → `AsyncIterable<V2Event>` (drain in background loop). Tokens on `"session.step.ended"` and `"session.usage.updated"` events: `data.tokens: TokenUsageInfo { input, output, reasoning, cache: { read, write } }` (same ground-truth sum rule). `"session.compaction.ended"` event: `data { sessionID, reason: "auto"|"manual", text, recent }` — use for post-compact continue.
  - Tool: `ctx.tool.transform((draft) => draft.add({ name, description, input, execute }))`; `execute(input, ctx: ToolContext { sessionID, agent, messageID, callID, progress }) → Promise<Tool.Result>`; `Tool.Result { output?, content?, metadata? }`. Empty-args input = `JsonSchema.Struct({})` from `effect` (transitive dep, available).
  - Compact: `ctx.session` (SessionDomain = Pick<SessionApi, "create"|"get"|"prompt"|"generate"|"command"|"synthetic"|"interrupt"> & { hook }) — **NO compact**. Own client: `@opencode-ai/client/promise` exports `OpenCode` namespace with `make({ baseUrl, headers? })`; `Service` from `@opencode-ai/client/promise/service`: `discover() → Endpoint { url, auth? } | undefined`, `headers(endpoint) → { authorization } | undefined`. Then `OpenCode.make({ baseUrl, headers }).session.compact({ sessionID })`.
  - Post-compact continue: `ctx.session.prompt({ sessionID, text })` (SessionPromptInput has `sessionID`, `text`, optional files/agents/metadata).
  - **No server-side toast in v2 beta** → notify is console-only; keep `Notifier` class contract, pass a console-only `NotifyClient` from the v2 composition root.
  - Config: v2 passes plugin config via `ctx.options` (PluginOptions = `Readonly<Record<string, any>>`). **OPEN: keep file-based `loadOptions(configPath)` (plan's lean) or read `ctx.options`?** Lean = keep file-based, configPath seam unchanged.
  - Install-scripts note: npm blocked postinstall for `msgpackr-extract@3.0.4` and `@biomejs/biome@1.9.4` (biome version changed to 1.9.4 via caret) — harmless.
- [2026-08-11] v1-only test surface to be dropped/replaced on the v2 branch: `tests/plugin.test.ts` (v1 factory + config-toast race), `tests/compact.test.ts` (v1 tool + autocontinue), v1-hook parts of `tests/harness.ts`, `tests/warning.test.ts` (drives v1 messages.transform). Keep with adaptation: `tests/resolveOptions.test.ts` (pure), `tests/context.test.ts` (pure assess/renderMessage; adapt contextTokens/createWarning to v2 Message), `tests/compactor.test.ts` (Compactor/extractError/requestPostCompact; replace V2CompactStrategy/V1SummarizeStrategy with V2BetaCompactStrategy). New: v2 composition-root tests driving a fake PluginContext (session.hook/tool.transform/event.subscribe/catalog).

## Design (v2 port — decided: port to 2.0 beta)

User chose **port to `@opencode-ai/plugin@next`** (0.0.0-next-16770). One-off npm `min-release-age` bypass granted by user for the beta install. V2 beta deps installed (package.json + package-lock.json modified, uncommitted):
`@opencode-ai/plugin@0.0.0-next-16770`, `@opencode-ai/client@0.0.0-next-16770`, `@opencode-ai/ai@0.0.0-next-16770`, `@opencode-ai/schema@0.0.0-next-16770` (devDeps; beta plugin deps `effect@4.0.0-beta.101`, `zod@4.1.8`, `@ai-sdk/provider@3.0.8`, `@standard-schema/spec@1.1.0` pulled transitively).

### v2 beta API map (authoritative, extracted tarballs in /tmp/opencode/plugin-next, /tmp/opencode/client-next, /tmp/opencode/ai-next, /tmp/opencode/schema-next)

- **Entry**: `import { Plugin } from "@opencode-ai/plugin"` (root = promise flavor; `Plugin.define({ id, setup(ctx): Cleanup|void })`). `PluginContext` = `{ app, options, agent, aisdk, catalog, command, event, integration, plugin, reference, session, shell, skill, tool, websearch }`.
- **Message transform (replaces `experimental.chat.messages.transform`)**: `ctx.session.hook("context", cb)` → cb gets `SessionContext { sessionID, agent, model: Model.Ref, system, messages, tools }` with **mutable** `system: SystemPart[]` and `messages: Array<Message>` (from `@opencode-ai/ai`). Push a synthetic user `Message.user(text)` into `input.messages`. Fires immediately before model dispatch.
- **Model info (replaces `system.transform`)**: `SessionContext.model` = `Model.Ref { id, providerID, variant? }`. Window via `ctx.catalog.model.get(providerID, modelID)?.limit.context` (Model.Info.limit.context). No per-session cache API needed — resolve per context hook.
- **Token ground truth (NOT in context messages — the v2 `Message` has no tokens)**: subscribe `ctx.event.subscribe()` → `AsyncIterable<V2Event>`. Use `SessionStepEnded.data.tokens` / `SessionUsageUpdated.data.tokens` = `TokenUsageInfo { input, output, reasoning, cache: { read, write } }` (same ground-truth sum rule as v1). Cache per sessionID in a module.
- **Tool registration (replaces `tool()` factory field)**: `ctx.tool.transform((draft) => draft.add({ name, description, input, execute }))`. `execute(input, ctx: ToolContext { sessionID, agent, messageID, callID, progress }) → Promise<Tool.Result>`. `input` is a JSON schema (effect `JsonSchema`).
- **Compaction**: `ctx.session` (SessionDomain) does NOT include `compact` (only create|get|prompt|generate|command|synthetic|interrupt). Build own client: `@opencode-ai/client/promise` `make({ baseUrl })` from `Service.discover()` endpoint (reads local registration file; `headers(endpoint)` for auth). Then `client.session.compact({ sessionID })`.
- **Post-compact continue (replaces `autocontinue`)**: `ctx.session.prompt({ sessionID, prompt: { text } })` (PromptInput = `{ text, files?, agents?, ... }` — text directly, no parts[]). Fire on `SessionCompactionEnded` event (or after compact resolves). No autocontinue suppression hook in beta.
- **Toast/log**: v2 beta server-side context has NO `tui.showToast` and no `app.log` in PluginContext (toast is TUI-plugin-only via `@opencode-ai/plugin/tui` `ctx.ui.toast`). **Degradation: v2 port logs to console only; toast config key is accepted but a no-op** (document this). 
- **Effect vs promise**: use promise flavor (simpler; setup returns Cleanup|void).

### v2 port module mapping (behind existing DDD seams)

- `src/config.ts` — unchanged (pure, SDK-agnostic).
- `src/context.ts` — `contextTokens` must accept the v2 token source; keep `assess`/`renderMessage` unchanged. Add a `tokensFromUsage(TokenUsageInfo)` adapter or feed the same sum into `assess`.
- `src/model-info.ts` — adapt `capture` to `Model.Ref` + window resolution via catalog (or drop the cache and resolve window per hook via `catalog.model.get`).
- `src/warning.ts` — `createWarning` must build a v2 `Message` (`Message.user(text)`), not v1 `{ info, parts }`.
- `src/compaction.ts` — add `V2BetaCompactStrategy` over the `@opencode-ai/client` `session.compact`; keep `Compactor`/`extractError`/`requestPostCompact`. `requestPostCompact` adapter becomes `(sessionID, agent, text) => ctx.session.prompt({ sessionID, prompt: { text } })`.
- `src/notify.ts` — v2 `NotifyClient` = console-only adapter (toast no-op). Keep the class contract.
- `src/index.ts` — new composition root: `Plugin.define({ id: "opencode-context-watch", setup(ctx) })` wiring session.hook("context"), tool.transform, event.subscribe, catalog.

### Tests
- Existing tests import `../src/index` (v1 plugin factory shape) + drive v1 hooks. v2 port will need: (a) keep pure-function unit tests (assess/renderMessage) as-is; (b) adapt createWarning/contextTokens/ModelInfoCache tests to v2 shapes; (c) new tests for the v2 composition root (fake PluginContext with callable session.hook/tool.transform/event.subscribe/catalog). The v1-only tests (v1 hooks, config-toast race, v2/summarize strategies) must be updated or dropped.

## Open questions

- **What should the `v2` branch ship?** RESOLVED: port to `@opencode-ai/plugin@next` (user decision). Track the beta (API churn expected; docs/plan is the tracking point).

## Resume checkpoint

- Goal to re-create: Create a branch named 'v2' to modify the opencode-context-watch plugin for opencode v2. Before the v2 work, refactor the codebase first applying DDD (Domain-Driven Design) principles, informed by the improve-codebase-architecture skill.
- DONE: DDD refactor committed (`447c744` on main); branch `v2` created; v2 API research complete and VERIFIED against installed node_modules + `/tmp/opencode` tarballs (see Design section); beta deps installed (uncommitted package.json + package-lock.json); port design decided and documented. `sdk@1.18.11` verified still installed. NOTE: installing `@opencode-ai/plugin@next` REPLACED the v1 plugin package → `bun test` now fails at import (`Export named 'tool' not found in @opencode-ai/plugin/dist/promise/index.js`), 29 pass/4 fail/4 errors. Expected; the port rewrites `src/index.ts` first.
- Next step: implement the v2 port — new `src/index.ts` using `Plugin.define({ id, setup(ctx) })` from `@opencode-ai/plugin` (promise flavor; `setup` returns `Cleanup|void`), wiring `ctx.session.hook("context")` (inject `Message.user(warningText)` from `@opencode-ai/ai` into mutable `messages`; `SessionContext` has `sessionID, agent, model: Model.Ref, system, messages, tools`), `ctx.tool.transform` (register `compact_context`; empty input = `JsonSchema.Struct({})` from `effect`), `ctx.event.subscribe()` background drain (cache `SessionStepEnded`/`SessionUsageUpdated` `data.tokens: TokenUsageInfo { input, output, reasoning, cache:{read,write} }` per sessionID; fire post-compact continue on `"session.compaction.ended"` `data { sessionID, reason, text, recent }` via `ctx.session.prompt({ sessionID, text })`), window lookup via catalog, and a `@opencode-ai/client/promise` `OpenCode.make({ baseUrl, headers })` client from `Service.discover()` + `Service.headers(endpoint)` for `session.compact` (NOT on `ctx.session` — SessionDomain Pick lacks compact). Toast is console-only (no server-side toast in v2 beta).
- Verify with: `bun test`, `npx tsc --noEmit`, `npx tsc -p tsconfig.test.json --noEmit`, `bunx biome check .`, `bun build src/index.ts --outdir dist`.
- Context to re-read first: this plan doc (Design section = authoritative v2 API map + module mapping; Deviation log has the full API surface), `src/context.ts`, `src/warning.ts`, `src/model-info.ts`, `src/compaction.ts`, `src/notify.ts`, `src/index.ts`, `tests/`; beta type tarballs in `/tmp/opencode/{plugin-next,client-next,ai-next,schema-next}/package/dist/**/*.d.ts` and installed node_modules `@opencode-ai/{plugin,client,ai,schema}`.
- Open questions: window lookup — `catalog.model.get(providerID,id)` is on the transform `CatalogDraft`, NOT `CatalogDomain` (domain `model` API = `{ list, default }`) → verify whether `ctx.catalog.model.list()` (HTTP) or a draft transform is the right path; whether `Message.user(content)` matches the mutable-messages injection; v2 config source (`ctx.options` vs existing file-based `loadOptions(configPath)` — likely keep file-based, configPath seam unchanged).
- Uncommitted: `package.json` (beta devDeps added), `package-lock.json` (untracked). Branch: `v2` (`1aad030 docs(plan): record v2 API research outcome` on top of `447c744`).
