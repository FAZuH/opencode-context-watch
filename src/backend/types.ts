import type { V2BetaCompactClient, V2CompactClient } from "../compaction";
import type { LastWarned } from "../context";
import type { LiveConfig } from "../live";
import type { ModelInfo, ModelInfoCache } from "../model-info";
import type { Notifier } from "../notify";

/**
 * Test-only seams, threaded through the plugin options: an isolated config
 * file path, a fake `@opencode-ai/sdk/v2` client factory, a fake v2-beta
 * compact client factory, and a summarize timeout. opencode always uses the
 * default config path and its own bundled clients; tests inject these to
 * keep config reads and SDK client construction deterministic.
 */
export interface BackendSeams {
	configPath?: string;
	createOpencodeClientV2?: (config: { baseUrl?: string }) => V2CompactClient;
	/** The v2 backend's own `@opencode-ai/client/promise` client (tests only). */
	createOpencodeClientV2Beta?: (config: {
		baseUrl?: string;
		headers?: Record<string, string>;
	}) => V2BetaCompactClient;
	summarizeTimeoutMs?: number;
}

/**
 * The runtime-backend port — the capability contract both opencode runtimes
 * provide so the version-free domain modules keep a single client. opencode
 * v1 loads the plugin via `server(input, options)` (expecting the v1 `Hooks`
 * object) and v2 via `setup(ctx)`; the backends differ only in how they wire
 * events, tools, and the compact client onto those loader shapes. The shared
 * operations below stay the same under both runtimes.
 */
export interface RuntimeBackend {
	/** Adapter-provided test seams (v1 plugin options; v2 passes none). */
	readonly seams?: BackendSeams;
	/** Live config state: the settings tool mutates it; hooks read it per event. */
	readonly live: LiveConfig;
	/** Trigger compaction; resolves the agent-facing result string. */
	compact(sessionID: string, model: ModelInfo | undefined): Promise<string>;
	/** Resume the session after a compaction (fire-and-forget, never throws). */
	postCompact(input: { sessionID: string; agent?: string }, text: string): void;
	/** The notification seam (TUI toast + app log under v1, console-only under v2). */
	readonly notifier: Notifier;
	/** Per-session model info, fed by each runtime's model events. */
	readonly modelCache: ModelInfoCache;
	/** Per-session rearm state (the last value each band was notified at). */
	readonly lastWarned: Map<string, LastWarned>;
}
