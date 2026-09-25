/**
 * Narrow structural types for the OpenCode V2 plugin context members this
 * plugin calls. Verified against OpenCode 2.0.16 on 2026-09-25; widen them
 * only from a live probe, never from a package type.
 */

export interface StepTokens {
	input?: number;
	output?: number;
	reasoning?: number;
	cache?: { read?: number; write?: number };
}

export interface StepEndedData {
	sessionID: string;
	tokens?: StepTokens;
}

export interface PluginEvent {
	type: string;
	data?: unknown;
}

export interface ModelInfo {
	id: string;
	providerID: string;
	limit?: { context?: number };
}

/** A message in the `context` hook's assembled list. The plugin only appends
 * to it; the rest of the runtime shape is deliberately not modelled. */
export interface ContextMessage {
	role: string;
	content: unknown[];
}

export interface ContextEvent {
	sessionID: string;
	model: { id: string; providerID: string };
	messages: ContextMessage[];
}

export interface Registration {
	dispose(): void;
}

export interface PluginContext {
	options?: unknown;
	model: { list(): Promise<{ data?: ModelInfo[] }> };
	session: {
		hook(
			name: "context",
			callback: (event: ContextEvent) => void | Promise<void>,
		): Promise<Registration>;
	};
	event: {
		subscribe(options: {
			signal?: AbortSignal;
		}): Promise<AsyncIterable<PluginEvent>> | AsyncIterable<PluginEvent>;
	};
}
