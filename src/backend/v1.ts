import type { Plugin, ToolDefinition } from "@opencode-ai/plugin";
import { z } from "zod";
import {
	type CompactStrategy,
	Compactor,
	DEFAULT_SUMMARIZE_TIMEOUT_MS,
	V1SummarizeStrategy,
	type V2CompactClient,
	V2CompactStrategy,
	requestPostCompact,
} from "../compaction";
import { CONFIG_PATH, type ConfigProblem, loadOptions } from "../config";
import {
	assess,
	contextTokens,
	notifyWarning,
	renderMessage,
} from "../context";
import {
	LiveConfig,
	RELOAD_PROBLEM_LABEL,
	SETTINGS_TOOL_DESCRIPTION,
	handleSettingsAction,
} from "../live";
import { ModelInfoCache } from "../model-info";
import { Notifier, type NotifyClient } from "../notify";
import { createWarning } from "../warning";
import type { BackendSeams, RuntimeBackend } from "./types";

// The plugin's client (opencode v1) satisfies the notify seam.
type PluginClient = NotifyClient;

/**
 * The opencode v1 client the backend needs — a structural subset of the v1
 * SDK client: the notify surface plus the session API used by the compact
 * fallback and the post-compact continue.
 */
interface V1Client extends NotifyClient {
	session: {
		summarize(arg: {
			path: { id: string };
			body: { providerID: string; modelID: string; auto: boolean };
		}): Promise<unknown>;
		promptAsync(arg: {
			path: { id: string };
			body: { agent?: string; parts: { type: string; text: string }[] };
		}): Promise<unknown>;
	};
}

/**
 * The opencode v1 plugin input — a structural subset of `PluginInput` from
 * `@opencode-ai/plugin` (what the v1 loader passes to `server`). Type-only,
 * so this adapter needs no runtime `@opencode-ai/plugin` import.
 */
export interface V1PluginInput {
	client: V1Client;
	serverUrl?: URL;
}

/**
 * The v1 backend: adapts the v1 loader's `(input, options) => Hooks` factory
 * contract onto the shared domain core. Behavior is identical to the pre-seam
 * `ContextWatchPlugin` factory — same config-toast race, same compact
 * strategies, same hooks — with the shared operations routed through the
 * `RuntimeBackend` port that the v2 backend will also satisfy.
 */
export async function createV1Backend(
	input: V1PluginInput,
	pluginOptions: BackendSeams | undefined,
): Promise<Awaited<ReturnType<Plugin>>> {
	const { client, serverUrl } = input;
	// Test-only seams; opencode always uses the default config path and its own
	// bundled `@opencode-ai/sdk/v2` client factory.
	const seam = pluginOptions;
	const configPath = seam?.configPath ?? CONFIG_PATH;
	const { options: opts, problems } = loadOptions(configPath);
	const live = new LiveConfig(configPath, opts);

	const notifier = new Notifier(client as PluginClient, live.notifyFlags);

	// Config-error toast: fire at load time; if the TUI is not connected yet it
	// fails (falling back to the opencode log) and we retry on the first message
	// transform. Capped attempts so a headless run cannot spam the log. The
	// shown/in-flight flags are set synchronously (never via a `.then` callback)
	// so the retry cannot race or double-fire, and configToast never rejects.
	// Reload problems reuse the same flags: the settings tool resets them so a
	// reload-time problem can toast once more. `currentProblems` is mutable
	// because reload replaces the problem set — the transform retry must show
	// the LATEST problems, not the stale load-time ones.
	let currentProblems: ConfigProblem[] = problems;
	let configErrorShown = false;
	let configErrorInFlight = false;
	let configToastAttempts = 0;
	const showConfigError = async (problems: ConfigProblem[]): Promise<void> => {
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
		void showConfigError(problems);
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
					// `auto: true` is what makes the autocontinue hook fire after
					// a summarize-triggered compaction.
					body: {
						providerID: model.providerID,
						modelID: model.modelID,
						auto: true,
					},
				}),
			seam?.summarizeTimeoutMs ?? DEFAULT_SUMMARIZE_TIMEOUT_MS,
		),
	);
	const compactor = new Compactor(strategies, (message, extra) =>
		notifier.log("warn", message, extra),
	);

	// The shared domain core the hooks below adapt to the v1 `Hooks` object
	// shape; the v2 backend wires the same core onto `setup(ctx)`.
	const backend: RuntimeBackend = {
		seams: seam,
		live,
		modelCache,
		lastWarned,
		notifier,
		compact: (sessionID, model) => compactor.compact(sessionID, model),
		postCompact: (input, text) =>
			requestPostCompact(
				(sessionID, agent, message) =>
					client.session.promptAsync({
						path: { id: sessionID },
						body: { agent, parts: [{ type: "text", text: message }] },
					}),
				input,
				text,
			),
	};

	const compactTool: ToolDefinition = {
		description:
			"Compact the current session's context window, freeing space. Call when the session is getting full or the model asks to compact.",
		args: {},
		execute: async (_args, ctx) =>
			backend.compact(ctx.sessionID, backend.modelCache.get(ctx.sessionID)),
	};

	const settingsTool: ToolDefinition = {
		description: SETTINGS_TOOL_DESCRIPTION,
		args: { action: z.enum(["reload", "disable", "enable", "status"]) },
		execute: async (args) =>
			handleSettingsAction(args.action, live, {
				clearLastWarned: () => backend.lastWarned.clear(),
				reportProblems: (probs) => {
					currentProblems = probs;
					notifier.alwaysLog("error", RELOAD_PROBLEM_LABEL, {
						problems: probs,
					});
					// Reset the load-time flags so a reload problem can toast
					// once more (same race-free sync-flag pattern).
					configErrorShown = false;
					configToastAttempts = 0;
					void showConfigError(probs);
				},
			}),
	};

	return {
		tool: {
			compact_context: compactTool,
			context_watch_settings: settingsTool,
		},

		"experimental.compaction.autocontinue": async (input, output) => {
			// Always suppress opencode's synthetic "continue" user message. When
			// postCompactContinue is off, nothing is sent at all after compaction;
			// when on, the configured text is injected as a real, persisted user
			// message instead.
			output.enabled = false;
			if (!opts.postCompactContinue) return;
			backend.postCompact(input, opts.postCompactMsg);
		},

		"experimental.chat.messages.transform": async (_input, output) => {
			if (currentProblems.length > 0 && !configErrorShown) {
				void showConfigError(currentProblems);
			}
			const sessionID = output.messages[0]?.info.sessionID;
			if (!sessionID) return;
			// The settings tool's disable/enable gate: injection + notify only.
			// The config-error retry above stays live even while disabled.
			if (!live.enabled) return;
			const tokens = contextTokens(output.messages);
			if (tokens === undefined) return;

			const window =
				opts.windowTokens ?? backend.modelCache.get(sessionID)?.window;
			const last = backend.lastWarned.get(sessionID);
			const result = assess(opts, tokens, window, last);
			if (!result.shouldInject) return;
			// The rearm band only gates the toast + verbose log, NOT the model
			// injection. The injected message is transient per transform call (it
			// is never persisted to the session store), so it must be pushed on
			// EVERY step above threshold — otherwise the final answering step in a
			// multi-step loop (tool calls, etc.) would not see the warning.
			if (result.shouldNotify) backend.lastWarned.set(sessionID, result.next);

			const text = renderMessage(opts.message, result.pct, tokens, window);
			const lastUser = [...output.messages]
				.reverse()
				.find((m) => m.info.role === "user");
			output.messages.push(createWarning(sessionID, text, lastUser));

			if (result.shouldNotify) {
				notifyWarning({
					notifier,
					result,
					tokens,
					window,
					sessionID,
					messageCount: output.messages.length,
					lastPart: output.messages.at(-1)?.parts[0],
				});
			}
		},

		"experimental.chat.system.transform": async (input, output) => {
			const sessionID = input.sessionID;
			if (!sessionID) return;
			backend.modelCache.capture(sessionID, input.model);
		},
	};
}
