# ADR-003: Runtime autodetection for opencode v1 and v2

## Status
Accepted

## Date
2026-08-13

## Context

The plugin must run on opencode v1 (1.18.x) and opencode v2 (2.0 beta). The two runtimes load plugins differently:

- The v1 loader calls `server(input, options)` on the default export and receives the v1 Hooks object.
- The v2 loader validates the default export as an object, reads `id`, and calls `setup(ctx)`.

A real opencode2 probe (0.0.0-next-17155, 2026-08-13) proved the linchpin: a function default with attached `id`/`setup` properties is rejected by the v2 loader (`SchemaError: Expected object, got async function`). A plain object `{ id, server, setup }` loads under both runtimes.

The v2 beta API also differs from v1 in several places: context-hook messages carry `content` parts, not v1-style `parts`; the model window comes from the catalog transform, not `system.transform`; tool registration needs `options: { codemode: false }` and an object `{ content }` return; `ctx.session` has no `compact`; there is no server-side toast.

## Decision

Export ONE plain-object default:

```ts
export default {
  id: "opencode-context-watch",
  server: async (input, pluginOptions) => createV1Backend(input, pluginOptions),
  setup: (ctx) => V2Backend.create(ctx as V2PluginContext),
};
```

The loader contract selects the backend. No version-detection code runs. There is no runtime `@opencode-ai/plugin` import — types stay structural, and no beta packages are installed (they would break the v1 tests).

Add the backend seam `src/backend/`:

- `types.ts` — `BackendSeams` (`configPath`, `createOpencodeClientV2`, `createOpencodeClientV2Beta`, `summarizeTimeoutMs`) and the state-first `RuntimeBackend` port (`compact`, `postCompact`, `notifier`, `modelCache`, `lastWarned`, `seams?`).
- `v1.ts` — `V1Backend`: the v1 hooks, the lazily-built v2 compact client, and the `[V2CompactStrategy?, V1SummarizeStrategy]` chain.
- `v2.ts` — `V2Backend`: `session.hook("context")`, `event.subscribe()`, the catalog window lookup, the `tool.transform` seam, its own compact client, and `session.prompt`.

Guard everything that can fail on a beta build. The `@opencode-ai/client/promise` import is a guarded split-specifier dynamic import; when it is unresolvable, the v2 compact path degrades to the honest string `"Compaction failed: v2 beta compact client unavailable"`.

## Alternatives Considered

### Function default with attached `id`/`setup` (`Object.assign`)
- Pros: Closest to the old v1 function shape.
- Cons: The v2 loader rejects a callable default with a `SchemaError`. Rejected.

### Runtime version detection (environment or version-string sniffing)
- Pros: Explicit control of the branch.
- Cons: The two loaders already dispatch on the export's shape. Detection code would be dead weight and a second source of truth. Rejected.

### Separate v2-only package on a branch
- Pros: Each package targets one runtime cleanly.
- Cons: Two packages to build, install, and maintain; the user must choose. This was the original plan (`docs/plan/ddd-refactor-and-v2.md`); the single-entry approach supersedes it.

### `Plugin.define`-guarded dynamic import
- Pros: Follows the documented v2 API.
- Cons: Unnecessary — the plain object loads without it, and any runtime `@opencode-ai/plugin` import reintroduces the version-mismatch risk. Rejected.

## Consequences
- Verified against real opencode2 (next-17155): the object entry loads without a `SchemaError`, `setup(ctx)` fires, async cleanup is accepted, warning injection works mid-session, the catalog window lookup returns the real window, and `compact_context` executes directly.
- The tool seam on the probed build requires `add({ name, description, input, options: { codemode: false }, execute })`, and `execute` must return `{ content: string }`. The two-arg `add(name, def)` form and a bare-string return crash the runner.
- The v2 compact client degrades honestly when `@opencode-ai/client/promise` is unresolvable; it never throws.
- v2 notification is console-only; the beta has no server-side toast.
- The beta API churns; the facts above are build-specific (next-17155). Re-probe on newer builds before relying on them.
- Domain modules stay version-free; only the backend adapters know the runtime.
