import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import type { Message, Part } from "@opencode-ai/sdk";
import type { V2CompactClient } from "../src/index";
import plugin from "../src/index";

const ENV_VARS = [
	"CONTEXT_WATCH_PERCENT",
	"CONTEXT_WATCH_TOKENS",
	"CONTEXT_WATCH_WINDOW",
	"CONTEXT_WATCH_REARM",
	"CONTEXT_WATCH_REARM_TOKENS",
	"CONTEXT_WATCH_MESSAGE",
	"CONTEXT_WATCH_NO_TOAST",
	"CONTEXT_WATCH_POST_COMPACT_CONTINUE",
	"CONTEXT_WATCH_POST_COMPACT_MSG",
];

export interface FakeClient {
	tui: {
		showToast: (arg: {
			body: { message: string; variant: string };
		}) => Promise<unknown>;
	};
	app: {
		log: (arg: {
			body: { level: string; message: string; extra: unknown };
		}) => Promise<unknown>;
	};
	session: {
		promptAsync: (arg: {
			path: { id: string };
			body: { parts: { type: string; text: string }[]; agent?: string };
		}) => Promise<unknown>;
		summarize: (arg: {
			path: { id: string };
			body: { providerID: string; modelID: string; auto: boolean };
		}) => Promise<unknown>;
	};
}

export interface Harness {
	/** The isolated config file path the harness reads (reload tests rewrite it). */
	configPath: string;
	toasts: { message: string; variant: string }[];
	appLogs: { level: string; message: string; extra: unknown }[];
	sessionPrompts: { sessionID: string; text: string; agent?: string }[];
	sessionSummarizes: {
		sessionID: string;
		providerID: string;
		modelID: string;
		auto: boolean;
	}[];
	showToastCalls: () => number;
	sessionSummarizeCalls: () => number;
	handlers: Awaited<ReturnType<Plugin>>;
	cleanup: () => void;
}

export function must<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`${what} missing`);
	return value;
}

/**
 * Boot a fresh plugin instance with a fake client and an isolated config file
 * path (passed via the plugin's test-only `configPath` seam), so the real
 * config-reading path is exercised without touching the user's HOME.
 */
export async function createHarness(
	config: string | null,
	opts: {
		failFirstToast?: boolean;
		failSessionSummarize?: boolean;
		sessionSummarizeResolved?: unknown;
		sessionSummarizeHang?: boolean;
		env?: Record<string, string>;
		createOpencodeClientV2?: (config: { baseUrl?: string }) => V2CompactClient;
		summarizeTimeoutMs?: number;
	} = {},
): Promise<Harness> {
	const home = mkdtempSync(join(tmpdir(), "context-watch-test-"));
	const configPath = join(home, "opencode-context-watch.json");
	if (config !== null) {
		writeFileSync(configPath, config, "utf8");
	}

	const savedEnv = new Map<string, string | undefined>();
	for (const v of ENV_VARS) {
		savedEnv.set(v, process.env[v]);
		delete process.env[v];
	}
	for (const [k, v] of Object.entries(opts.env ?? {})) {
		process.env[k] = v;
	}

	let showToastCalls = 0;
	let sessionSummarizeCalls = 0;
	const toasts: { message: string; variant: string }[] = [];
	const appLogs: { level: string; message: string; extra: unknown }[] = [];
	const sessionPrompts: { sessionID: string; text: string; agent?: string }[] =
		[];
	const sessionSummarizes: {
		sessionID: string;
		providerID: string;
		modelID: string;
		auto: boolean;
	}[] = [];
	const client: FakeClient = {
		tui: {
			showToast: async ({ body }) => {
				showToastCalls++;
				if (opts.failFirstToast && showToastCalls === 1)
					throw new Error("no TUI yet");
				toasts.push(body);
				return {};
			},
		},
		app: {
			log: async ({ body }) => {
				appLogs.push(body);
				return {};
			},
		},
		session: {
			promptAsync: async ({ path, body }) => {
				const text = body.parts
					.map((p) => (p.type === "text" ? p.text : ""))
					.join("");
				sessionPrompts.push({ sessionID: path.id, text, agent: body.agent });
				return {};
			},
			summarize: async ({ path, body }) => {
				sessionSummarizeCalls++;
				if (opts.sessionSummarizeHang) return new Promise<never>(() => {});
				if (opts.failSessionSummarize) throw new Error("summarize rejected");
				if (opts.sessionSummarizeResolved !== undefined)
					return opts.sessionSummarizeResolved;
				sessionSummarizes.push({
					sessionID: path.id,
					providerID: body.providerID,
					modelID: body.modelID,
					auto: body.auto,
				});
				return {};
			},
		},
	};

	// The entry is a plain object now (autodetect shape); the v1 path is the
	// `server(input, options)` factory, which returns the same hooks object as
	// the old callable default export.
	const handlers = await plugin.server({ client } as never, {
		configPath,
		createOpencodeClientV2: opts.createOpencodeClientV2,
		summarizeTimeoutMs: opts.summarizeTimeoutMs,
	});
	await new Promise((r) => setTimeout(r, 0));

	return {
		configPath,
		toasts,
		appLogs,
		sessionPrompts,
		sessionSummarizes,
		showToastCalls: () => showToastCalls,
		sessionSummarizeCalls: () => sessionSummarizeCalls,
		handlers,
		cleanup: () => {
			rmSync(home, { recursive: true, force: true });
			for (const v of ENV_VARS) {
				const prev = savedEnv.get(v);
				if (prev === undefined) delete process.env[v];
				else process.env[v] = prev;
			}
		},
	};
}

export interface AssistantTokens {
	input: number;
	output: number;
	reasoning?: number;
	cache?: { read: number; write: number };
}

/**
 * Build the `output.messages` shape the messages.transform hook receives:
 * a user message followed by the most recent completed assistant message
 * carrying the provider-reported token counts that drive the context meter.
 */
export function buildMessages(
	tokens: AssistantTokens,
	sessionID = "session-test",
) {
	const info = (id: string, role: "user" | "assistant"): Message =>
		({
			id,
			sessionID,
			role,
			time: { created: 1_700_000_000_000 },
			agent: "build",
			model: { providerID: "opencode", modelID: "test" },
			...(role === "assistant" ? { tokens } : {}),
		}) as Message;
	const part = (id: string, role: "user" | "assistant"): Part =>
		({
			id: `part_${id}`,
			sessionID,
			messageID: id,
			type: "text",
			text: role === "user" ? "user message" : "assistant reply",
			synthetic: false,
		}) as Part;
	const user = info("msg_user_1", "user");
	const assistant = info("msg_assistant_1", "assistant");
	return {
		messages: [
			{ info: user, parts: [part(user.id, "user")] },
			{ info: assistant, parts: [part(assistant.id, "assistant")] },
		],
	};
}

/**
 * Seed the plugin's per-session model cache through the real system.transform
 * hook so tests exercise the capture path instead of reaching into internals.
 * The v1 `Model` type has `id` (not `modelID`); the hook captures `id` as the
 * summary modelID.
 */
export async function seedModel(
	h: Harness,
	sessionID: string,
	model: { providerID: string; modelID: string; window: number },
): Promise<void> {
	const hook = must(
		h.handlers["experimental.chat.system.transform"],
		"system.transform hook",
	);
	await hook(
		{
			sessionID,
			model: {
				providerID: model.providerID,
				modelID: model.modelID,
				id: model.modelID,
				limit: { context: model.window, output: 1 },
			} as never,
		},
		{ system: [] },
	);
}
