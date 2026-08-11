/**
 * Model-info module — per-session model metadata repository.
 *
 * `experimental.chat.system.transform` is the only hook that receives model
 * metadata; `messages.transform` and the compaction tool both need pieces of
 * it. This small repository owns that capture and lookup so the shape lives
 * in exactly one place.
 */

export interface ModelInfo {
	/** The model's context window in tokens (`model.limit.context`). */
	window?: number;
	providerID?: string;
	modelID?: string;
}

/** The model metadata shape opencode hands to `system.transform`. */
export interface ModelMetadata {
	providerID?: string;
	/** The v1 `Model` type exposes `id`, captured as the summary modelID. */
	id?: string;
	limit?: { context?: number };
}

export class ModelInfoCache {
	private readonly cache = new Map<string, ModelInfo>();

	capture(sessionID: string, model: ModelMetadata | undefined): void {
		const cached = this.cache.get(sessionID) ?? {};
		if (model) {
			const context = model.limit?.context;
			if (context && context > 0) cached.window = context;
			if (model.providerID) cached.providerID = model.providerID;
			if (model.id) cached.modelID = model.id;
		}
		this.cache.set(sessionID, cached);
	}

	get(sessionID: string): ModelInfo | undefined {
		return this.cache.get(sessionID);
	}
}
