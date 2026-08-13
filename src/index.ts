import type { BackendSeams } from "./backend/types";
import { type V1PluginInput, createV1Backend } from "./backend/v1";
import { V2Backend, type V2PluginContext } from "./backend/v2";

// Re-export the public surface that tests and consumers import from the
// package entry point.
export type { ConfigProblem, ContextWatchOptions } from "./config";
export { resolveOptions } from "./config";
export type { V2CompactClient } from "./compaction";

/**
 * The plugin entry — a plain object, not a callable, because that is the one
 * shape BOTH opencode loaders accept:
 * - v1 (`readV1Plugin` "detect" mode) reads `id` + `server()` and calls
 *   `server(input, options)`, which returns the v1 `Hooks` object;
 * - v2 validates the default export as an object, reads `id`, and calls
 *   `setup(ctx)`, ignoring extra keys like `server`.
 * No runtime `@opencode-ai/plugin` import: the v1 input is the structural
 * `V1PluginInput` (its client satisfies `NotifyClient`) and `setup` passes
 * the raw v2 context to `V2Backend.create`, whose return value is the
 * backend cleanup (context-hook + event-stream teardown).
 */
const plugin = {
	id: "opencode-context-watch",
	server: async (input: V1PluginInput, pluginOptions?: BackendSeams) =>
		createV1Backend(input, pluginOptions),
	setup: (ctx: unknown) => V2Backend.create(ctx as V2PluginContext),
};

export default plugin;
