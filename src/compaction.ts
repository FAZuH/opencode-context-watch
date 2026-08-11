import type { ModelInfo } from "./model-info";

/**
 * Compaction module — triggering session compaction and resuming after it.
 *
 * The agent compacts its own session through the `compact_context` tool. Two
 * clients exist (the v2 SDK client and the v1 client), so the seam is real:
 * each client is a small strategy adapter and a `Compactor` orchestrates the
 * fallback chain, the self-deadlock timeout race, and the agent-facing result
 * string. The post-compaction continue message lives here too.
 */

/**
 * Minimal structural shape of the v2 SDK client we need for compaction. The
 * real `@opencode-ai/sdk/v2` client satisfies it (`v2.session.compact`); the
 * plugin also accepts a fake via the test seam, and loads the real one lazily
 * so a missing v2 export degrades to the v1 fallback instead of crashing
 * plugin load.
 */
export interface V2CompactClient {
	v2: {
		session: {
			compact(params: { sessionID: string }): Promise<unknown>;
		};
	};
}

// How long to wait for the v1 summarize before giving up on its response. See
// V1SummarizeStrategy: awaiting it to completion deadlocks the session loop.
export const DEFAULT_SUMMARIZE_TIMEOUT_MS = 3000;

export type CompactOutcome =
	| { status: "requested" }
	| { status: "failed"; error: string };

export interface CompactContext {
	sessionID: string;
	/** Model info cached per session; undefined when the window was never seen. */
	model: ModelInfo | undefined;
}

/**
 * One way of compacting a session. A strategy never throws; it reports
 * failure as an outcome so the orchestrator can fall through to the next one.
 */
export interface CompactStrategy {
	readonly name: string;
	compact(ctx: CompactContext): Promise<CompactOutcome>;
}

/**
 * The SDK clients RESOLVE (do not throw) even on error, carrying an `error`
 * field on the result (e.g. `{ error: {...}, response: {} }`). Treat any
 * such resolution as a failure so we fall through to the next path.
 */
export function extractError(res: unknown): string | undefined {
	if (res && typeof res === "object" && "error" in res) {
		const e = (res as { error?: unknown }).error;
		if (!e) return undefined;
		if (typeof e === "string") return e;
		try {
			return JSON.stringify(e);
		} catch {
			return String(e);
		}
	}
	return undefined;
}

export class V2CompactStrategy implements CompactStrategy {
	readonly name = "v2 compact";

	constructor(private readonly client: V2CompactClient) {}

	async compact(ctx: CompactContext): Promise<CompactOutcome> {
		try {
			const res = await this.client.v2.session.compact({
				sessionID: ctx.sessionID,
			});
			const err = extractError(res);
			if (err) return { status: "failed", error: err };
			return { status: "requested" };
		} catch (err) {
			return {
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}
}

export type SummarizeFn = (
	sessionID: string,
	model: { providerID: string; modelID: string },
) => Promise<unknown>;

/**
 * The v1 `session.summarize` fallback — the only working programmatic
 * compaction path on opencode 1.18.x (the v2 endpoint is a server-side stub
 * and the old command path is dead). Needs per-session model info; without it
 * the strategy fails honestly without calling summarize.
 *
 * Awaiting the summarize to completion self-deadlocks when this tool runs
 * inside a session loop (opencode 1.18.x, upstream #5449): the summarize
 * handler joins the running session-loop fiber, so the response never
 * arrives. Race it instead; on timeout the compaction still proceeds
 * server-side and the loop picks up the persisted compaction task, so we stop
 * waiting and report success.
 */
export class V1SummarizeStrategy implements CompactStrategy {
	readonly name = "v1 summarize";

	constructor(
		private readonly summarize: SummarizeFn,
		private readonly timeoutMs: number,
	) {}

	async compact(ctx: CompactContext): Promise<CompactOutcome> {
		const model = ctx.model;
		if (!model?.providerID || !model?.modelID) {
			return { status: "failed", error: "no model info cached for summarize" };
		}
		try {
			const summarize = this.summarize(ctx.sessionID, {
				providerID: model.providerID,
				modelID: model.modelID,
			});
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const winner = await Promise.race([
					summarize.then(() => "settled"),
					new Promise<string>((resolve) => {
						timer = setTimeout(() => resolve("timeout"), this.timeoutMs);
					}),
				]);
				if (winner === "timeout") {
					// The summarize may still settle later; swallow its outcome so
					// a late rejection is never an unhandled promise rejection.
					summarize.catch((err) => console.log("[context-watch]", err));
					return { status: "requested" };
				}
			} finally {
				clearTimeout(timer);
			}
			const res = await summarize;
			const err = extractError(res);
			if (err) return { status: "failed", error: err };
			return { status: "requested" };
		} catch (err) {
			return {
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}
}

/**
 * Orchestrates the compact strategies in order, combining their failures into
 * the agent-facing result string. The tool never throws — it returns
 * `"Compaction requested."` on success or `"Compaction failed: <detail>"` so
 * the agent sees the outcome as the tool result.
 */
export class Compactor {
	constructor(
		private readonly strategies: CompactStrategy[],
		private readonly log: (
			message: string,
			extra: Record<string, unknown>,
		) => void,
	) {}

	async compact(
		sessionID: string,
		model: ModelInfo | undefined,
	): Promise<string> {
		const failures: string[] = [];
		for (const strategy of this.strategies) {
			const outcome = await strategy.compact({ sessionID, model });
			if (outcome.status === "requested") {
				this.log(`compaction requested via ${strategy.name}`, { sessionID });
				return "Compaction requested.";
			}
			failures.push(outcome.error);
			this.log(`compaction request failed (${strategy.name})`, {
				sessionID,
				error: outcome.error,
			});
		}
		const detail = failures.join("; ");
		this.log("compaction request failed", { sessionID, error: detail });
		return `Compaction failed: ${detail}`;
	}
}

export type PostCompactPrompt = (
	sessionID: string,
	agent: string,
	text: string,
) => Promise<unknown>;

/**
 * After a compaction, resume the session with the configured text as a real,
 * persisted user message. Fire-and-forget: a failed prompt is logged and the
 * session still continues; a race here is tolerated by design.
 */
export function requestPostCompact(
	prompt: PostCompactPrompt,
	input: { sessionID: string; agent?: string },
	text: string,
): void {
	prompt(input.sessionID, input.agent ?? "build", text).catch((err) =>
		console.log("[context-watch] compact message injection failed", err),
	);
}
