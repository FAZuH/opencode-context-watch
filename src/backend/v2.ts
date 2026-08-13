import {
	type CompactStrategy,
	Compactor,
	type V2BetaCompactClient,
	V2BetaCompactStrategy,
	requestPostCompact,
} from "../compaction";
import { CONFIG_PATH, loadOptions } from "../config";
import {
	assess,
	notifyWarning,
	renderMessage,
	tokensFromUsage,
} from "../context";
import {
	LiveConfig,
	RELOAD_PROBLEM_LABEL,
	SETTINGS_TOOL_DESCRIPTION,
	handleSettingsAction,
} from "../live";
import { ModelInfoCache } from "../model-info";
import { Notifier, type NotifyClient } from "../notify";
import type { BackendSeams, RuntimeBackend } from "./types";

/**
 * opencode v2 beta plugin context — the structural subset the backend
 * consumes. Shapes verified against opencode2 v0.0.0-next-17155 by running a
 * reflection probe inside the real loader (`/tmp/opencode/probe2`, see the
 * autodetect plan doc). Note the catalog: on that build the domain
 * (`ctx.catalog.model`) exposes only `{ list, default }` — the model `get`
 * (with `limit.context`) lives on the `catalog.transform` draft, so that is
 * the window lookup path.
 */
export interface V2PluginContext {
	catalog: {
		transform<T>(
			fn: (draft: {
				model: {
					get(providerID: string, modelID: string): V2ModelInfo | undefined;
				};
			}) => T,
		): Promise<T>;
	};
	session: {
		hook(
			name: "context",
			cb: (event: V2ContextEvent) => void,
		):
			| Promise<{ dispose: () => void } | undefined>
			| { dispose: () => void }
			| undefined;
		prompt(input: { sessionID: string; text: string }): Promise<unknown>;
	};
	tool: {
		transform(
			fn: (draft: {
				add(tool: V2ToolDefinition): number;
			}) => void | Promise<void>,
		): Promise<unknown>;
	};
	event: {
		subscribe(): AsyncIterable<V2Event>;
	};
}

/** The model info `catalog.transform(draft => draft.model.get(...))` returns. */
export interface V2ModelInfo {
	id?: string;
	providerID?: string;
	limit?: { context?: number; output?: number };
}

/**
 * The `session.hook("context")` event — mutable system/messages/tools the
 * plugin may edit immediately before model dispatch.
 */
export interface V2ContextEvent {
	sessionID: string;
	agent: string;
	/** Model.Ref: `{ id, providerID, variant? }` — carries no window. */
	model: { id?: string; providerID?: string; variant?: string };
	system: { type: string; text: string }[];
	/** v2 `Message` — `content` parts (NOT the v1 `parts`) — runtime-verified. */
	messages: V2Message[];
	tools: Record<string, unknown>;
}

/** opencode v2 beta `Message` — `{ id, role, content, metadata }`. */
export interface V2Message {
	id: string;
	role: string;
	content: unknown[];
	metadata?: Record<string, unknown>;
}

/**
 * The `tool.transform` draft `add` input — object form. Runtime-verified on
 * next-17155: `add` takes ONE argument (the tool definition object); the
 * `add(name, def)` form breaks tool.transform finalization.
 */
export interface V2ToolDefinition {
	name: string;
	description: string;
	input: Record<string, unknown>;
	/** Probe-verified (next-17155): `codemode: false` registers a direct callable tool. */
	options?: { codemode?: boolean };
	/** The result must be an object (`{ content }`), never a bare string. */
	execute(input: unknown, ctx: V2ToolContext): Promise<V2ToolResult>;
}

/** The tool execute result — `{ content: string }` on next-17155. */
export interface V2ToolResult {
	content: string;
}

/**
 * The tool executor context. `execute` reads only `sessionID`. The id field
 * name (`id` vs `callID`) is NOT verified against a real beta, so the
 * executor must not rely on it.
 */
export interface V2ToolContext {
	id?: string;
	sessionID: string;
	agent?: string;
	messageID?: string;
	progress?: unknown;
}

/** A public server event — `{ type, data }`. */
export interface V2Event {
	type: string;
	data?: V2EventData;
}

/** The `data.tokens` payload (`TokenUsageInfo`) on usage/step events. */
export interface V2TokenUsage {
	input?: number;
	output?: number;
	reasoning?: number;
	cache?: { read?: number; write?: number };
}

/** The event `data` fields the drain reads. */
export interface V2EventData {
	sessionID?: string;
	agent?: string;
	tokens?: V2TokenUsage;
	[extra: string]: unknown;
}

/** The local service registration `Service.discover()` returns. */
interface V2ServiceEndpoint {
	url?: string;
	auth?: string;
}

/**
 * v2 beta has no server-side toast (`client.tui.showToast`) and no app log —
 * notify degrades to console. The `Notifier` contract stays the same: toast
 * is a no-op success, app.log writes to the console.
 */
const consoleClient: NotifyClient = {
	tui: {
		showToast: async () => true,
	},
	app: {
		log: async ({ body }) => {
			console.log(
				"[context-watch]",
				body.level,
				body.message,
				JSON.stringify(body.extra),
			);
		},
	},
};

/**
 * The transient synthetic user warning in the v2 `Message` shape (`content`
 * parts — runtime-verified; the v1 `createWarning` builds `{ info, parts }`
 * for the v1 SDK and stays untouched). The message is never persisted; the
 * caller pushes it into the current hook's in-memory array, so it must be
 * produced on every hook while above threshold.
 */
export function buildV2Warning(sessionID: string, text: string): V2Message {
	const stamp = Date.now().toString(36);
	return {
		id: `msg_cw_${stamp}`,
		role: "user",
		content: [{ type: "text", text }],
		metadata: {},
	};
}

/**
 * The v2 backend: adapts the v2 loader's `setup(ctx)` contract onto the same
 * domain core as `V1Backend` (config resolution, `ModelInfoCache`,
 * `Compactor`, `Notifier`) — the shared operations route through the
 * `RuntimeBackend` port; only the event wiring, tool registration, and
 * compact client differ. Returns the cleanup the loader awaits when the
 * plugin is disabled/reloaded/shut down.
 */
export const V2Backend = {
	async create(
		ctx: Partial<V2PluginContext> | undefined,
		pluginOptions?: BackendSeams,
	): Promise<() => Promise<void>> {
		// The v1 loader (1.18.x) also calls `setup(ctx)` with a context that
		// has no v2 surface — the real v1 path is `server()`. Return a silent
		// no-op cleanup instead of running the v2 wiring (config read, client
		// import, tool and hook registration) against a non-v2 context.
		if (
			!ctx ||
			typeof ctx.tool?.transform !== "function" ||
			typeof ctx.session?.hook !== "function" ||
			typeof ctx.event?.subscribe !== "function"
		) {
			return async () => {};
		}
		// Capture the checked context as a const: parameter narrowing does not
		// flow into the closures below (postCompact, lookupWindow). The guard
		// verified tool/session/event; catalog is only reached from a
		// registered context hook, as the pre-guard code always assumed.
		const v2ctx = ctx as V2PluginContext;

		const seam = pluginOptions;
		const configPath = seam?.configPath ?? CONFIG_PATH;
		const { options: opts, problems } = loadOptions(configPath);
		const live = new LiveConfig(configPath, opts);

		const notifier = new Notifier(consoleClient, live.notifyFlags);

		// Config problems: log once at setup. There is no toast retry under v2
		// (no toast surface, and no messages.transform to retry on).
		if (problems.length > 0) {
			notifier.alwaysLog("error", "invalid config", { problems });
		}

		// sessionID -> model info, fed by the context hook (which carries the
		// model ref); window resolved lazily via the catalog draft below.
		const modelCache = new ModelInfoCache();
		// sessionID -> last warned value per band, to rearm only after a rise
		const lastWarned = new Map<string, { pct?: number; tokens?: number }>();
		// sessionID -> latest ground-truth token sum from the event stream
		const lastTokens = new Map<string, number>();
		// providerID:modelID -> resolved window (shared across sessions)
		const modelWindows = new Map<string, number>();
		const windowLookups = new Set<string>();

		// The plugin's own compact client, built lazily:
		// `@opencode-ai/client/promise` is a v2 beta package that is absent
		// from the v1 line's node_modules, so the import is guarded (never
		// crashing plugin load) and the specifier is split to keep it out of
		// the static import graph that `bun build` resolves. A missing package
		// degrades to an honest "unavailable" failure.
		let betaClient: V2BetaCompactClient | undefined;
		try {
			const create = seam?.createOpencodeClientV2Beta;
			if (create) {
				betaClient = create({ baseUrl: undefined, headers: undefined });
			} else {
				const base = "@opencode-ai/";
				const clientMod = (await import(`${base}client/promise`)) as {
					OpenCode?: {
						make?: (config: {
							baseUrl?: string;
							headers?: Record<string, string>;
						}) => V2BetaCompactClient;
					};
				};
				const serviceMod = (await import(`${base}client/promise/service`)) as {
					Service?: {
						discover?: () => V2ServiceEndpoint | undefined;
						headers?: (
							endpoint: V2ServiceEndpoint,
						) => Record<string, string> | undefined;
					};
				};
				const endpoint = serviceMod.Service?.discover?.();
				betaClient = clientMod.OpenCode?.make?.({
					baseUrl: endpoint?.url,
					headers: endpoint
						? serviceMod.Service?.headers?.(endpoint)
						: undefined,
				});
			}
		} catch (err) {
			betaClient = undefined;
			console.log("[context-watch] v2 beta compact client unavailable", err);
		}

		const strategies: CompactStrategy[] = betaClient
			? [new V2BetaCompactStrategy(betaClient)]
			: [
					{
						name: "v2 beta compact client unavailable",
						compact: async () => ({
							status: "failed",
							error: "v2 beta compact client unavailable",
						}),
					},
				];
		const compactor = new Compactor(strategies, (message, extra) =>
			notifier.log("warn", message, extra),
		);

		const backend: RuntimeBackend = {
			seams: seam,
			live,
			modelCache,
			lastWarned,
			notifier,
			compact: (sessionID, model) => compactor.compact(sessionID, model),
			postCompact: (input, text) =>
				requestPostCompact(
					(sessionID, _agent, message) =>
						v2ctx.session.prompt({ sessionID, text: message }),
					input,
					text,
				),
		};

		try {
			await v2ctx.tool.transform((draft) => {
				draft.add({
					name: "compact_context",
					description:
						"Compact the current session's context window, freeing space. Call when the session is getting full or the model asks to compact.",
					// Verified working shape on next-17155 (probe-hook): plain
					// JSON-Schema `input` + `options: { codemode: false }` (registers
					// a direct, callable tool) + `{ content }` object return. The
					// docs' two-arg `add(name, tool, options?)` form crashes this
					// build (`TypeError: O.name.replace`); a bare string return
					// crashes the runner (`"output"in c`).
					input: {
						type: "object",
						properties: {},
						additionalProperties: false,
					},
					options: { codemode: false },
					execute: async (_args, toolCtx) => ({
						content: await backend.compact(
							toolCtx.sessionID,
							backend.modelCache.get(toolCtx.sessionID),
						),
					}),
				});
				draft.add({
					name: "context_watch_settings",
					description: SETTINGS_TOOL_DESCRIPTION,
					input: {
						type: "object",
						properties: {
							action: {
								type: "string",
								enum: ["reload", "disable", "enable", "status"],
							},
						},
						required: ["action"],
						additionalProperties: false,
					},
					options: { codemode: false },
					execute: async (input) => {
						const action = (input as { action?: unknown }).action;
						return {
							content: handleSettingsAction(action, live, {
								clearLastWarned: () => backend.lastWarned.clear(),
								reportProblems: (probs) =>
									notifier.alwaysLog("error", RELOAD_PROBLEM_LABEL, {
										problems: probs,
									}),
								// A windowTokens null<->N change must re-resolve the
								// model window instead of reusing cached lookups.
								clearWindowLookups: () => {
									windowLookups.clear();
									modelWindows.clear();
								},
							}),
						};
					},
				});
			});
		} catch (err) {
			console.log(
				"[context-watch] compact_context tool registration failed",
				err,
			);
		}

		// Resolve the model window via the catalog transform draft.
		// Runtime-verified (next-17155): `catalog.transform` invokes the
		// draft callback synchronously — `draft.model.get(providerID,
		// modelID)` returns the model including `limit.context` without any
		// await, so the lookup result is available to the same hook that
		// starts it. Looked up once per `providerID:modelID`.
		const lookupWindow = (
			providerID: string,
			modelID: string,
		): number | undefined => {
			let found: number | undefined;
			try {
				const res = v2ctx.catalog.transform((draft) => {
					const model = draft.model.get(providerID, modelID);
					const context = model?.limit?.context;
					if (context && context > 0) {
						found = context;
						modelWindows.set(`${providerID}:${modelID}`, context);
					}
					return model;
				});
				if (res && typeof (res as { then?: unknown }).then === "function") {
					// Async-only drafts complete the cache for later hooks.
					void (res as Promise<unknown>).catch((err) =>
						console.log("[context-watch] model window lookup failed", err),
					);
				}
			} catch (err) {
				console.log("[context-watch] model window lookup failed", err);
			}
			return found;
		};

		// The v2 equivalent of messages.transform: fires immediately before
		// model dispatch with the mutable message list. The token ground truth
		// comes from the event stream (the v2 Message carries no token counts),
		// cached per session by the drain below.
		const onContext = (event: V2ContextEvent): void => {
			const sessionID = event.sessionID;
			if (!sessionID) return;
			// The settings tool's disable/enable gate: injection + notify only.
			// The event-stream drain keeps running so token ground truth stays
			// current across a disable.
			if (!live.enabled) return;

			const providerID = event.model?.providerID;
			const modelID = event.model?.id;
			if (providerID && modelID) {
				backend.modelCache.capture(sessionID, { providerID, id: modelID });
				const key = `${providerID}:${modelID}`;
				let window = modelWindows.get(key);
				if (
					window === undefined &&
					opts.windowTokens === null &&
					!windowLookups.has(key)
				) {
					windowLookups.add(key);
					window = lookupWindow(providerID, modelID);
				}
				if (window !== undefined) {
					backend.modelCache.capture(sessionID, {
						providerID,
						id: modelID,
						limit: { context: window },
					});
				}
			}

			const tokens = lastTokens.get(sessionID);
			if (tokens === undefined) return;

			const window =
				opts.windowTokens ?? backend.modelCache.get(sessionID)?.window;
			const last = backend.lastWarned.get(sessionID);
			const result = assess(opts, tokens, window, last);
			if (!result.shouldInject) return;
			// Same rearm rule as v1: the notify band only gates the toast +
			// verbose log, never the injection. The injected message is
			// transient per hook call (never persisted), so it must be pushed
			// on EVERY hook above threshold.
			if (result.shouldNotify) backend.lastWarned.set(sessionID, result.next);

			const text = renderMessage(opts.message, result.pct, tokens, window);
			event.messages.push(buildV2Warning(sessionID, text));

			if (result.shouldNotify) {
				const lastMsg = event.messages.at(-1);
				notifyWarning({
					notifier,
					result,
					tokens,
					window,
					sessionID,
					messageCount: event.messages.length,
					lastPart: Array.isArray(lastMsg?.content)
						? lastMsg.content.at(-1)
						: undefined,
				});
			}
		};

		let disposeContext: (() => void) | undefined;
		let iterator: AsyncIterator<V2Event> | undefined;
		let stopped = false;
		try {
			const registered = await v2ctx.session.hook("context", onContext);
			disposeContext =
				registered && typeof registered === "object"
					? registered.dispose
					: undefined;

			// Background drain of the public event stream: token ground truth
			// per session (`session.step.ended` / `session.usage.updated` →
			// `data.tokens`) and the post-compact continue trigger
			// (`session.compaction.ended`). The iterator's `return()` tears the
			// subscription down; the cleanup below calls it.
			iterator = v2ctx.event.subscribe()[Symbol.asyncIterator]();
			const it = iterator;
			void (async () => {
				try {
					for await (const ev of {
						[Symbol.asyncIterator]: () => it,
					}) {
						if (stopped) break;
						const data = (ev as V2Event).data;
						if (!data) continue;
						if (
							((ev as V2Event).type === "session.step.ended" ||
								(ev as V2Event).type === "session.usage.updated") &&
							data.sessionID &&
							data.tokens
						) {
							const sum = tokensFromUsage(data.tokens);
							if (sum !== undefined) {
								lastTokens.set(data.sessionID, sum);
							}
						} else if (
							(ev as V2Event).type === "session.compaction.ended" &&
							data.sessionID
						) {
							// The configured text is sent as a real, persisted user
							// message after a compaction — fire-and-forget via the
							// shared `requestPostCompact` (never throws).
							if (opts.postCompactContinue) {
								backend.postCompact(
									{ sessionID: data.sessionID, agent: data.agent },
									opts.postCompactMsg,
								);
							}
						}
					}
				} catch (err) {
					console.log("[context-watch] v2 event drain stopped", err);
				}
			})();
		} catch (err) {
			console.log("[context-watch] context hook registration failed", err);
		}

		return async () => {
			stopped = true;
			try {
				await iterator?.return?.(undefined);
			} catch (err) {
				console.log("[context-watch] v2 event drain cleanup", err);
			}
			try {
				disposeContext?.();
			} catch (err) {
				console.log("[context-watch] v2 context hook cleanup", err);
			}
		};
	},
};
