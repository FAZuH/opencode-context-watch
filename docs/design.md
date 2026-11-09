# opencode-context-watch: Design & Technical Reference

An [OpenCode](https://opencode.ai) **V2** plugin that warns the agent when a
session's context window usage crosses a threshold, so it can wrap up the current
step or prepare for compaction before the window fills.

V1 support is gone: see [ADR-004](decisions/ADR-004-v2-only-rewrite.md) for the
decision and the supersession of ADR-001, ADR-002, and ADR-003.

## Runtime contracts (OpenCode 2.0.16, probed 2026-09-25)

| Member | Shape | Used for |
|--------|-------|----------|
| `ctx.options` | the object from `plugins[].options`, absent when unset | configuration |
| `await ctx.model.list()` | `{ location, data: Model.Info[] }` — not a bare array | the model-window map |
| `ctx.session.hook("context", cb)` | resolves `{ dispose() }`; event has `sessionID`, `model: { id, providerID, variant }`, `messages` | the per-request warning |
| `event.messages` | mutable array; appending `{ role: "user", content: [{ type: "text", text }] }` is accepted | carrying the warning to the model |
| `ctx.event.subscribe({ signal })` | async iterable of `{ type, data }`; `session.step.ended` data has `sessionID` and `tokens` | the usage cache |
| `session.compaction.started/ended/failed` | event stream entries carrying `data.sessionID` | suppress warnings and reset the pre-compaction sample |
| `session.deleted` | event stream entry carrying `data.sessionID` | prune per-session state |
| `ctx.rpc.register(contract, handlers)` | resolves `{ events: { emit(type, data) } }`; optional on hosts without RPC | the sidebar's `status` method and `changed` event |
| `ctx.session.compact` | **absent** | — |

`session.usage.updated` also arrives on that stream. It is cumulative
consumption for the whole session, not the current context size, so the plugin
ignores it.

## Architecture

```
setup ──► resolveOptions(ctx.options)          → options + problems
      ──► ctx.model.list().data                 → "providerID/modelID" → context window
      ──► ctx.event.subscribe({ signal })       → sessionID → last step usage
      ──► ctx.session.hook("context", cb)       → assess → append warning
      ──► ctx.rpc.register(contract, handlers)  → status(sessionID) + changed event
      └─► returns cleanup: abort stream, dispose registration
```

```
model request ──► session.step.ended ──► usage cache (per session)
                                │
model request ──► "context" hook ──► usageTotal + model window ──► assess
                                                                    │
                                        above a band ───────────────┤
                                                                    ▼
                                        append transient warning to event.messages
```

## Context-size ground truth

`usageTotal()` (`src/context.ts`) adds one completed step's buckets:

```
input + output + reasoning + cache.read + cache.write
```

This is the number opencode's context meter shows. Two rules follow:

- **Never sum `input` across steps.** Each step's `input` is the whole context at
  request time, so a sum overcounts badly.
- A step with no `input` is not a sample; `usageTotal` returns `undefined` and
  the request is skipped.

## Event-drain ordering: the cache is one request behind

`session.step.ended` is the only per-step context-size signal on V2 (the
`context` hook's messages carry no tokens, and `ctx.session.get().tokens` is the
cumulative session total). A live 2.0.16 run shows the event is published
*after* the next request has been assembled:

```
context hook (3 messages)  cached: null
session.tool.success
session.step.ended         tokens 5522/18/8/cr3456
context hook (5 messages)  cached: 5522/…     <- usable from here on
```

So the cache trails by one model request: the first one or two requests of a
session have no sample and cannot warn; every above-threshold request after that
is injected. That is the right trade for a "wrap up soon" hint, and it is why the
plugin does not call `ctx.session.context` per hook to re-read the transcript
and serialize the whole thing on every request.

Two other measured details: `session.usage.updated` and
`ctx.session.get({ sessionID }).tokens` are the same cumulative figure, and
plugin `console.log` does not reach `opencode2 run --print-logs`, so the verbose
line is only visible in a real service log.

## Threshold model: dual band, OR semantics

- **Percent band** — `usage / window >= warnPercent`. Needs a known window
  (`windowTokens`, else the setup-time model list, keyed `providerID/modelID`).
  Unknown window disables this band. `warnPercent: null` disables it explicitly.
- **Tokens band** — `usage >= warnTokens`. Absolute, window-independent.
  `warnTokens: null` disables it explicitly.

## Rearm band and the transient injection

`lastWarned` maps `sessionID → { pct, tokens }` to the value each band last
logged at. A band re-logs only after rising `rearmPercent` points or
`rearmTokens` tokens. **The rearm never gates the injection.**

The appended message exists only in the current hook call's array — opencode
never persists it, and the session loop re-reads messages from the store each
step. So it is appended on **every** above-threshold request. Injecting only on
the first one would show the warning in that step and lose it on the next
(tool-calling follow-ups, multi-step loops).

## Compaction and session state

`session.compaction.started` marks the session as compacting. The context hook
returns without injecting until `session.compaction.ended` or
`session.compaction.failed` clears the mark. Both end events also drop the
session's `usage` and `lastWarned` entries: the pre-compaction sample describes a
context that no longer exists, so the first post-compaction request waits for a
fresh `session.step.ended`. `session.deleted` drops the same entries plus the
compacting mark.

## Sidebar status RPC

The plugin registers `src/rpc.ts` when `ctx.rpc.register` exists. `status({
sessionID })` returns `{ ok, status }`, where `status` carries the sample
(`tokens`, `window`, `percent`), both bands, `over`, and `compacting`.
`changed` fires with the same status after every completed step, when
compaction starts, and when it ends or fails. The model window is remembered
from the first `context` hook of the session, because `session.step.ended`
does not name a model. When no hook has run in the instance answering the
call, `status` falls back to the session's own model record from
`ctx.session.get({ sessionID })`. Registration failure is logged and ignored:
the warning path must work on a host with no RPC.

The report plugin's TUI sidebar consumes this contract. It keeps its own copy
of the schema, subscribes to `changed`, and asks for `status` on session
switch; a missing plugin or method leaves its Context section hidden.

## Configuration

`ctx.options` only, resolved once in `setup` by the pure
`resolveOptions(raw)` in `src/config.ts`. There is no config file, no env
override, and no watcher; a config change needs an opencode restart.

| Key | Default | Description |
|-----|---------|-------------|
| `warnPercent` | `0.77` | 0..1, or percent (`77`) if > 1. Values > 1 are divided by 100. `null` disables the band. |
| `warnTokens` | `150000` | Warn when the session reaches this many tokens. `null` disables the band. |
| `windowTokens` | `null` | Override the model's context window. |
| `rearmPercent` | `5` | Re-log after this many percentage-point rise. |
| `rearmTokens` | `5000` | Re-log after this many more tokens. |
| `verbose` | `false` | Log every context warning to the service log. |
| `message` | default template | Injection template; placeholders `{usage}` `{percent}` `{tokens}` `{window}`. |

A rejected value falls back to its own default and is written to the OpenCode
service log with `console.error` as `[context-watch] <key>: <message>`; unknown
keys and a non-object root are reported the same way. The plugin keeps running
with the good keys. Headless `opencode2 run --print-logs` does not print plugin
console output, so these lines are only visible in a service log or terminal
run.

## Error handling

- A failed `ctx.model.list()` logs once and disables the percent band.
- A `session.step.ended` with missing or malformed `data` is skipped; it must
  never throw out of the drain loop, which would kill the only usage source.
- A rejected `ctx.session.hook()` registration aborts the event stream before
  setup rethrows, so a failed setup cannot orphan a live iterator.
- The event loop is wrapped; it logs only on a non-abort failure and exits
  quietly when the abort signal fires. It must never reject into the session.
- The context hook body cannot throw: every input is validated (`usageTotal`
  returns `undefined` without a sample, `assess` ignores a missing window).

## Verification

```sh
bun test
npx tsc --noEmit
npx tsc -p tsconfig.test.json --noEmit
bunx biome check .
bun build src/index.ts --outdir dist
```

`tests/plugin.test.ts` drives the real plugin against a fake V2 context (model
list, event stream, context hook) and asserts the public behavior: what gets
appended to `event.messages`, what gets logged, and what cleanup does. A
two-turn live run should echo a unique marker from a `message` template with
`warnPercent` set low enough to always fire.
