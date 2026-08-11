import { type Plugin, tool } from "@opencode-ai/plugin";
import {
	type CompactStrategy,
	Compactor,
	DEFAULT_SUMMARIZE_TIMEOUT_MS,
	V1SummarizeStrategy,
	type V2CompactClient,
	V2CompactStrategy,
	requestPostCompact,
} from "./compaction";
import {
	type ConfigProblem,
	type ContextWatchOptions,
	loadOptions,
	resolveOptions,
} from "./config";
import { assess, contextTokens, renderMessage } from "./context";
import { type ModelInfo, ModelInfoCache } from "./model-info";
import { Notifier, type NotifyClient } from "./notify";
import { createWarning } from "./warning";

// Re-export the public surface that tests and consumers import from the
// package entry point.
export type { ConfigProblem, ContextWatchOptions } from "./config";
export { resolveOptions } from "./config";
export type { V2CompactClient } from "./compaction";

// The plugin's client (opencode v1) satisfies the notify seam.
type PluginClient = NotifyClient;

export const ContextWatchPlugin: Plugin = async (
	{ client, serverUrl },
	pluginOptions,
) => {
	// Test-only seams; opencode always uses the default config path and its own
	// bundled `@opencode-ai/sdk/v2` client factory.
	const seam = pluginOptions as
		| {
				configPath?: string;
				createOpencodeClientV2?: (config: {
					baseUrl?: string;
				}) => V2CompactClient;
				summarizeTimeoutMs?: number;
		  }
		| undefined;
	const configPath = seam?.configPath;
	const { options: opts, problems } = loadOptions(configPath);

	const notifier = new Notifier(client as PluginClient, {
		toastEnabled: opts.toast,
		verbose: opts.verbose,
	});

	// Config-error toast: fire at load time; if the TUI is not connected yet it
	// fails (falling back to the opencode log) and we retry on the first message
	// transform. Capped attempts so a headless run cannot spam the log. The
	// shown/in-flight flags are set synchronously (never via a `.then` callback)
	// so the retry cannot race or double-fire, and configToast never rejects.
	let configErrorShown = false;
	let configErrorInFlight = false;
	let configToastAttempts = 0;
	const configToast = async (): Promise<void> => {
		if (configErrorShown || configErrorInFlight || configToastAttempts >= 3)
			return;
		configToastAttempts++;
		configErrorInFlight = true;
		const joined = problems.map((p) => p.message).join("; ");
		const text = `[context-watch] invalid config (${configPath}): ${joined}`;
		const capped = text.length > 400 ? `${text.slice(0, 397)}...` : text;
		try {
			configErrorShown = await notifier.toast(capped, "error");
		} finally {
			configErrorInFlight = false;
		}
	};
	if (problems.length > 0) {
		notifier.alwaysLog("error", "invalid config", { problems });
		void configToast();
	}

	// sessionID -> model info, cached by system.transform (messages.transform has no model info)
	const modelCache = new ModelInfoCache();
	// sessionID -> last warned value per band, to rearm only after a rise
	const lastWarned = new Map<string, { pct?: number; tokens?: number }>();

	// v2 client for the compact_context tool, built once at load. Loaded lazily
	// (client-only subpath — the full `/v2` entry pulls in the server and would
	// break the browser-mode bundle with node builtins) so a missing v2 export
	// degrades to the v1 fallback instead of crashing plugin load; tests inject
	// a fake via the seam.
	let v2Client: V2CompactClient | undefined;
	try {
		const create = seam?.createOpencodeClientV2;
		v2Client = create
			? create({ baseUrl: serverUrl?.href })
			: (await import("@opencode-ai/sdk/v2/client")).createOpencodeClient({
					baseUrl: serverUrl?.href,
				});
	} catch (err) {
		v2Client = undefined;
		console.log(
			"[context-watch] v2 compact client unavailable; using v1 fallback",
			err,
		);
	}

	// Compaction: v2 client first (awaited), v1 summarize fallback (raced
	// against a timeout so it cannot self-deadlock the session loop). Each SDK
	// interaction is an adapter behind the `CompactStrategy` seam.
	const strategies: CompactStrategy[] = [];
	if (v2Client) strategies.push(new V2CompactStrategy(v2Client));
	strategies.push(
		new V1SummarizeStrategy(
			(sessionID, model) =>
				client.session.summarize({
					path: { id: sessionID },
					// `auto` is not in the generated SDK types but the handler accepts
					// it and fires the autocontinue hook only when it is true.
					body: {
						providerID: model.providerID,
						modelID: model.modelID,
						auto: true,
					} as { providerID: string; modelID: string; auto: boolean },
				}),
			seam?.summarizeTimeoutMs ?? DEFAULT_SUMMARIZE_TIMEOUT_MS,
		),
	);
	const compactor = new Compactor(strategies, (message, extra) =>
		notifier.log("warn", message, extra),
	);

	return {
		tool: {
			compact_context: tool({
				description:
					"Compact the current session's context window, freeing space. Call when the session is getting full or the model asks to compact.",
				args: {},
				execute: async (_args, ctx) =>
					compactor.compact(ctx.sessionID, modelCache.get(ctx.sessionID)),
			}),
		},

		"experimental.compaction.autocontinue": async (input, output) => {
			// Always suppress opencode's synthetic "continue" user message. When
			// postCompactContinue is off, nothing is sent at all after compaction;
			// when on, the configured text is injected as a real, persisted user
			// message instead.
			output.enabled = false;
			if (!opts.postCompactContinue) return;
			requestPostCompact(
				(sessionID, agent, text) =>
					client.session.promptAsync({
						path: { id: sessionID },
						body: { agent, parts: [{ type: "text", text }] },
					}),
				input,
				opts.postCompactMsg,
			);
		},

		"experimental.chat.messages.transform": async (_input, output) => {
			if (problems.length > 0 && !configErrorShown) {
				void configToast();
			}
			const sessionID = output.messages[0]?.info.sessionID;
			if (!sessionID) return;
			const tokens = contextTokens(output.messages);
			if (tokens === undefined) return;

			const window = opts.windowTokens ?? modelCache.get(sessionID)?.window;
			const last = lastWarned.get(sessionID);
			const result = assess(opts, tokens, window, last);
			if (!result.shouldInject) return;
			// The rearm band only gates the toast + verbose log, NOT the model
			// injection. The injected message is transient per transform call (it
			// is never persisted to the session store), so it must be pushed on
			// EVERY step above threshold — otherwise the final answering step in a
			// multi-step loop (tool calls, etc.) would not see the warning.
			if (result.shouldNotify) lastWarned.set(sessionID, result.next);

			const text = renderMessage(opts.message, result.pct, tokens, window);
			const lastUser = [...output.messages]
				.reverse()
				.find((m) => m.info.role === "user");
			output.messages.push(createWarning(sessionID, text, lastUser));

			if (result.shouldNotify) {
				const lastPart = output.messages.at(-1)?.parts[0];
				notifier.log("warn", "context warning injected", {
					sessionID,
					percent:
						result.pct === undefined ? undefined : Math.round(result.pct),
					messageTokens: tokens,
					window,
					lastMessageText:
						lastPart?.type === "text" ? lastPart.text.slice(0, 80) : "none",
					messageCount: output.messages.length,
				});
				void notifier.toast(
					result.overPercent && result.pct !== undefined
						? `Context window at ${Math.round(result.pct)}% — getting full`
						: `Session context reached ${tokens.toLocaleString()} tokens — getting full`,
					"warning",
				);
			}
		},

		"experimental.chat.system.transform": async (input, output) => {
			const sessionID = input.sessionID;
			if (!sessionID) return;
			modelCache.capture(sessionID, input.model);
		},
	};
};

export default ContextWatchPlugin;
