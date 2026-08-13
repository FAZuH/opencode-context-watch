# Plan: Live commands/settings (reload config, disable warning)

## Objective

Give the user live control over the plugin without an opencode restart, on
both opencode v1 (1.18.x) and v2 (2.0 beta):

1. **Reload config** — re-read `~/.config/opencode/opencode-context-watch.json`
   (env overrides included) and apply the new thresholds/message/notify flags
   to the running plugin immediately.
2. **Disable warning** — stop warning-injection + notifications until
   re-enabled, live.

Both are invoked through a mechanism the user can run from inside opencode on
both runtimes. The deliverable is the capability + tests + docs; the command
surface and its limits are decided below.

## Decisions & constraints

### D1. The live surface is a TOOL, not a slash command

Research conclusion (type-def + docs verified):

- **v2**: the plugin command API is `ctx.command.transform` over a
  `CommandDraft` that only has `list/get/update/remove` — **there is no
  `add`**. A plugin cannot register a new slash command on v2. Commands come
  from user config (`command` key) or markdown files.
- **v1**: commands come from markdown/config files, not the plugin API. The
  plugin has a `command.execute.before` hook (can rewrite parts) but cannot
  skip the LLM round-trip on 1.18.11.
- **Both**: the **tool** seam is proven cross-runtime — `compact_context`
  registers and executes on v1 (`Hooks.tool`) and v2 (`ctx.tool.transform`,
  `options: { codemode: false }` + `{ content }` return), probe-verified on
  real opencode2 next-17155.

Therefore the primary, zero-config surface is a **`context_watch_settings`
tool** with an `action` argument (`reload | disable | enable | status`). The
user runs it by telling the model (e.g. "reload the context watch config"),
which invokes the tool. This mirrors how `compact_context` is already used.

A **secondary, optional** slash-command path is documented but NOT core:
plugins cannot register commands, so a user who wants `/context-watch reload`
must define the command themselves (config or markdown snippet we ship in
docs); the plugin then reacts via `command.execute.before` (v1) /
`command.executed` event (v2). See "Optional: command interception" below.

### D2. Live mutable state via a `LiveConfig` domain module

Both backends already read the resolved options from a closure object on
every event (`assess(opts, …)`, `renderMessage(opts.message, …)`,
`opts.postCompactContinue`, `opts.windowTokens`), and `Notifier` reads
`this.opts.toastEnabled/verbose` on every call. So **mutating the same object
in place** makes changes effective immediately with zero re-registration.

Introduce a new domain module `src/live.ts`:

```ts
class LiveConfig {
  options: Required<ContextWatchOptions>; // the SAME object the hooks read
  enabled = true;                          // runtime-only gate, survives reload
  notifyFlags: { toastEnabled: boolean; verbose: boolean }; // passed to Notifier by reference
  reload(): { options: Required<ContextWatchOptions>; problems: ConfigProblem[] };
  setEnabled(v: boolean): void;
  statusText(): string;
}
```

- `reload()` calls the existing pure `loadOptions(configPath)` (file + env,
  per-key fallback, `problems`) and `Object.assign(this.options, newOptions)`
  so every captured reference stays live. It also updates `notifyFlags`.
- `enabled` is **runtime-only**: default `true`, toggled by the tool, reset on
  restart, NOT a config key. A live-disable then reload does NOT re-enable —
  reload only applies thresholds/message/notify flags. (Documented so it is
  not surprising.)
- `configPath` comes from the existing `BackendSeams.configPath` (tests) or
  the default `CONFIG_PATH` (both backends already resolve it).

### D3. Reload semantics

- Re-read + revalidate via `loadOptions`; new thresholds/message/`toast`/
  `verbose` apply immediately (in-place mutation).
- New problems are reported via `notifier.alwaysLog("error", …)` plus one
  error toast attempt (reuse the v1 `configToast` helper path — error toasts
  always fire even when `toast: false`; v2 logs only). Never throws.
- On reload, clear per-session `lastWarned` so the new thresholds fire
  immediately; on v2 also clear `windowLookups` so a `windowTokens`
  null↔N change re-resolves the window.
- `compact_context` and the config-error toast machinery are unaffected.

### D4. Disable semantics

- `enabled=false` gates **warning injection + notification** only: the v1
  `messages.transform` and v2 `onContext` early-return before `assess`.
- The `compact_context` tool, autocontinue, and post-compact continue stay
  active — "disable warning" is about the context warning, not the plugin's
  other behaviors. (Scope documented; could be widened later.)

### D5. Tool shape per runtime

- **v1**: `ToolDefinition` via the structural pattern already used for
  `compact_context`. The `action` argument needs a real zod schema
  (`args: { action: tool.schema.enum([...]) }`), because opencode v1 derives
  the tool's JSON schema from a zod object and parses incoming args with it.
  → add `zod` as a direct dependency (already present transitively via
  `@opencode-ai/plugin`; browser-safe, keeps `bun build` green).
  Rejected alternative: four no-arg tools (`context_watch_reload`, …) to
  avoid the zod dep — rejected because four model-visible tools are noisier
  than one enum tool.
- **v2**: `ctx.tool.transform(draft.add({ name, description, input, options:
  { codemode: false }, execute }))` — `input` is plain JSON Schema, e.g.
  `{ type: "object", properties: { action: { type: "string", enum: [...] } },
  required: ["action"], additionalProperties: false }`. `execute` returns
  `{ content }`. Same shape as the probe-verified `compact_context` plus one
  property (verify on real v2 in step 4).
- Both `execute` handlers: switch on `action`, call the shared `LiveConfig`
  methods, return a human-readable result string (never throw; log on error).

### D6. No new config keys

`enabled` stays runtime-only; reload does not read it. Existing keys
unchanged. `resolveOptions` untouched.

## File layout

- `src/live.ts` (new) — `LiveConfig` domain module (mutable options, `enabled`,
  `reload`, `setEnabled`, `statusText`; imports `loadOptions`,
  `ContextWatchOptions`, `ConfigProblem` from `./config`).
- `src/backend/types.ts` — add `live: LiveConfig` to the `RuntimeBackend`
  port so both backends expose the live state to shared logic.
- `src/backend/v1.ts` — construct `LiveConfig`; pass its `notifyFlags` to
  `Notifier` (instead of the current literal); gate `messages.transform` on
  `live.enabled`; register `context_watch_settings` tool (zod args) beside
  `compact_context`; reload reports problems via the existing `configToast`
  helper.
- `src/backend/v2.ts` — same LiveConfig wiring; gate `onContext`; register the
  tool with JSON-Schema `input`; reload logs problems via `notifier.alwaysLog`.
- `src/notify.ts` — no change needed (already reads `this.opts` per call; we
  pass the live `notifyFlags` object by reference).
- `src/context.ts` — no change (`assess` already reads the passed options).
- `package.json` — add `"zod": "^4.1.8"` to `dependencies` (v1 tool args).
- Tests:
  - `tests/settings.test.ts` (new) — v1: tool registers; each action; reload
    applies new thresholds; disable stops injection; enable resumes; status
    text; reload problems are logged + error-toasted; `lastWarned` cleared.
  - `tests/backend-v2.test.ts` (extend) — v2: tool registered with JSON-schema
    `input` + `codemode:false`; actions work through the fake ctx; disable
    stops `onContext` injection.
  - `tests/harness.ts` — expose the settings tool on the fake client if the
    v2 fake needs it (v1 needs nothing new — tool lives on `handlers.tool`).
- Docs: `AGENTS.md` (Critical Implementation Notes chapter), `CONTEXT.md`
  (module map + glossary), `docs/design.md` (live-state section), README/
  example config note, and the optional command-interception snippet.

## Design

### LiveConfig (src/live.ts)

```ts
export class LiveConfig {
  constructor(
    private readonly configPath: string,
    initial: Required<ContextWatchOptions>,
    private readonly notifyFlags: { toastEnabled: boolean; verbose: boolean },
  ) {
    this.options = initial;
    this.notifyFlags.toastEnabled = initial.toast;
    this.notifyFlags.verbose = initial.verbose;
  }
  options: Required<ContextWatchOptions>;
  enabled = true;
  reload() {
    const { options, problems } = loadOptions(this.configPath);
    Object.assign(this.options, options);          // live in place
    this.notifyFlags.toastEnabled = options.toast; // Notifier sees it
    this.notifyFlags.verbose = options.verbose;
    return { options, problems };
  }
  setEnabled(v: boolean) { this.enabled = v; }
  statusText() { /* enabled? thresholds? message? config path */ }
}
```

Both backends construct it from their existing `loadOptions(seam?.configPath)`
result, replacing the current `const opts` closure. All hook reads of `opts`
become reads of `live.options` (or keep the same name via destructuring —
the object identity must stay the same across reload).

### Gate points

- v1 `messages.transform`: after the sessionID/tokens checks, `if
  (!live.enabled) return;` before `assess`/injection.
- v2 `onContext`: same early-return before `assess`/injection.
- Notification path (`notifyWarning`) is naturally gated because injection
  never happens when disabled.

### Settings tool execute (shared logic)

```
action "reload"  -> live.reload(); report problems (alwaysLog + error toast v1 / log v2);
                    clear lastWarned (+ v2 windowLookups); return summary.
action "disable" -> live.setEnabled(false); return "disabled".
action "enable"  -> live.setEnabled(true);  return "enabled".
action "status"  -> return live.statusText().
unknown action   -> return help text (never throw).
```

## Execution

1. `implement` builds `src/live.ts` + backend wiring + tests (TDD), one
   backend at a time (v1 first, then v2), never touching config.ts.
2. `test` runs the full gate after each step:
   - `bun test`, `npx tsc --noEmit`, `npx tsc -p tsconfig.test.json --noEmit`,
     `bunx biome check .`, `bun build src/index.ts --outdir dist`
     (bundle stays browser-safe with zod imported).
3. Real-runtime probe (repo's established pattern): load the plugin on real
   opencode2 and on v1, invoke `context_watch_settings` with each action,
   verify reload/disable/enable/status actually take effect live.
4. `review` the diff (Standards + Spec axes).
5. `document` updates AGENTS.md / CONTEXT.md / design.md / example config +
   optional command snippet.
6. Commit via `finish` (proposal → user approval), per repo conventions.

Execution status:
- [x] 1 — DONE: `src/live.ts` (LiveConfig + handleSettingsAction + shared
  constants), v1/v2 wiring, `zod@^4.1.8` dep, tests. Gate: 145 pass / 0 fail,
  both tsc clean, biome clean, bundle 0.58 MB.
- [x] 2 — DONE (same gate as step 1, run per increment).
- [x] 3 — DONE (real-runtime probe, 2026-08-13, `/tmp/opencode/probe-settings/`):
  opencode2 v0.0.0-next-17155 — `status` returned full statusText, `disable`
  returned `Warning injection disabled`, `reload` returned `Reloaded config:
  10 options applied`; env override `CONTEXT_WATCH_PERCENT=42` → `warnPercent=
  42%`; `compact_context` + `context_watch_settings` coexist in one session.
  opencode v1 1.18.18 — zod `args` accepted, tool called with
  `{"action":"status"}`, model replied with the exact statusText. Known
  probe-artifact (not a code bug): the raw-file plugin sandbox stubs
  `node:fs` (`existsSync is not a function`) → `reload` reports 1 problem and
  v1 config-load logs an error; real installs load via npm with node:fs.
- [x] 4 — DONE: review PASS (Standards + Spec), 0 P1/P2; 3 P3 cleanups applied
  (shared constants, stronger enum assertion, stale-problems re-toast fix).
- [x] 5 — DONE: docs — `docs/design.md` (Live settings section + port/table
  updates), `README.md` (tool bullet + notes), `AGENTS.md` (Live settings
  subsection + config-reload note + `live` port), `CONTEXT.md` (glossary rows
  + module map + zod note).
- [ ] 6 — PENDING: commit.

## Resume checkpoint

- Goal: add live commands/settings — (1) reload config, (2) disable warning —
  runnable on opencode v1 (1.18.x) and v2 (2.0 beta) without restart.
- Plan is drafted (`docs/plan/live-commands-settings.md`), awaiting user
  approval before implementation. Key decisions: live surface = a
  `context_watch_settings` TOOL (`action: reload|disable|enable|status`), NOT
  a slash command (v2 `CommandDraft` has no `add`; v1 commands are
  config/markdown files; the tool seam is the proven cross-runtime path);
  live state via a new `src/live.ts` `LiveConfig` (in-place `Object.assign`
  mutation of the per-event `opts` closure object + runtime-only `enabled`
  flag + `notifyFlags` passed to `Notifier` by reference); v1 tool args need
  zod (`zod@^4.1.8` added as a dep), v2 uses plain JSON-Schema `input`;
  reload clears `lastWarned` (+ v2 `windowLookups`), reports problems via
  `notifier.alwaysLog` + error toast; disable gates only injection + notify
  (`messages.transform` / `onContext` early-return), leaving compact_context /
  autocontinue active.
- Verified constraints (research, node_modules type defs + opencode docs):
  v2 `CommandDraft` = list/get/update/remove only; v1 `command.execute.before`
  can't skip LLM on 1.18.11; v2 emits `command.executed` event
  `{name, sessionID, arguments, messageID}`; both backends read `opts` from a
  per-event closure; `Notifier` reads `this.opts` per call; `loadOptions`
  already returns fresh `{options, problems}` each call.
- Next step: docs (step 5) + commit (step 6). Implementation, gate, probe,
  and review are all complete.

## Deviation log

- (2026-08-13) `tests/harness.ts` gained a `configPath` field on the Harness
  return (reload tests rewrite the config file mid-test). Planned for in the
  File-layout section.
- (2026-08-13) Both backends resolve `configPath = seam?.configPath ??
  CONFIG_PATH` before `new LiveConfig(...)` (LiveConfig needs a `string`; the
  load-time config toast and `statusText` now show the real default path
  instead of `undefined` on real runtimes).
- (2026-08-13) Real-runtime probe artifact: the raw-plugin-file sandbox stubs
  `node:fs` (`existsSync is not a function`) — an environment artifact of the
  probe harness, not a plugin bug; real installs load via npm with node:fs.
- (2026-08-13) Review P3 cleanups applied: `SETTINGS_TOOL_DESCRIPTION` /
  `RELOAD_PROBLEM_LABEL` shared constants; stronger zod-enum assertion in
  tests; `currentProblems` mutable in v1 so the transform retry toasts the
  LATEST problems after a reload (not stale load-time ones).
