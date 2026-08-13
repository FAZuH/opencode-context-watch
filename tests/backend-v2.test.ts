import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendSeams } from "../src/backend/types";
import {
	V2Backend,
	type V2ContextEvent,
	type V2Event,
	type V2Message,
	type V2PluginContext,
	type V2ToolDefinition,
	buildV2Warning,
} from "../src/backend/v2";
import type { V2BetaCompactClient } from "../src/compaction";
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A fake opencode v2 `PluginContext` — structural, satisfying `V2PluginContext`.
 * Records the context-hook callbacks, tool definitions, session prompts and
 * catalog model lookups; the event stream is a controllable queue the tests
 * push events into (the backend drains it in the background).
 */
function createFakeCtx(opts: {
	modelWindow?: number;
	configPath: string;
	createOpencodeClientV2Beta?: (config: {
		baseUrl?: string;
		headers?: Record<string, string>;
	}) => V2BetaCompactClient;
}) {
	let contextHook: ((event: V2ContextEvent) => void) | undefined;
	const toolDefs: V2ToolDefinition[] = [];
	const prompts: { sessionID: string; text: string }[] = [];
	const modelLookups: { providerID: string; modelID: string }[] = [];
	const buffer: V2Event[] = [];
	let nextResolver: ((r: IteratorResult<V2Event>) => void) | undefined;
	let done = false;

	const iterator = {
		next: () => {
			if (buffer.length > 0)
				return Promise.resolve({
					done: false,
					value: buffer.shift() as V2Event,
				});
			if (done)
				return Promise.resolve({ done: true, value: undefined as never });
			return new Promise<IteratorResult<V2Event>>((resolve) => {
				nextResolver = resolve;
			});
		},
		return: () => {
			done = true;
			return Promise.resolve({ done: true, value: undefined as never });
		},
	};

	const ctx: V2PluginContext = {
		catalog: {
			transform: async (fn) =>
				fn({
					model: {
						get: (providerID, modelID) => {
							modelLookups.push({ providerID, modelID });
							if (opts.modelWindow === undefined) return undefined;
							return {
								id: modelID,
								providerID,
								limit: { context: opts.modelWindow },
							};
						},
					},
				}),
		},
		session: {
			hook: async (_name, cb) => {
				contextHook = cb;
				return { dispose: () => {} };
			},
			prompt: async (input) => {
				prompts.push(input);
				return {};
			},
		},
		tool: {
			transform: async (fn) => {
				fn({
					add: (tool) => {
						toolDefs.push(tool);
						return toolDefs.length;
					},
				});
			},
		},
		event: {
			subscribe: () => ({
				[Symbol.asyncIterator]: () => iterator,
			}),
		},
	};

	return {
		ctx,
		seams: {
			configPath: opts.configPath,
			createOpencodeClientV2Beta: opts.createOpencodeClientV2Beta,
		} satisfies BackendSeams,
		fireContext: (event: V2ContextEvent): V2ContextEvent => {
			const hook = contextHook;
			if (!hook) throw new Error("context hook not registered");
			hook(event);
			return event;
		},
		pushEvent: (ev: V2Event): void => {
			if (nextResolver) {
				const resolve = nextResolver;
				nextResolver = undefined;
				resolve({ done: false, value: ev });
			} else {
				buffer.push(ev);
			}
		},
		contextHookRegistered: () => contextHook !== undefined,
		toolDefs,
		prompts,
		modelLookups,
	};
}

function contextEvent(
	sessionID = "s1",
	messages: V2Message[] = [],
): V2ContextEvent {
	return {
		sessionID,
		agent: "build",
		model: { id: "deepseek-v4-flash", providerID: "opencode-go" },
		system: [{ type: "text", text: "system" }],
		messages,
		tools: {},
	};
}

async function boot(
	config: string | null,
	opts: {
		modelWindow?: number;
		betaClient?: V2BetaCompactClient;
	} = {},
) {
	const home = mkdtempSync(join(tmpdir(), "context-watch-v2-test-"));
	const configPath = join(home, "opencode-context-watch.json");
	if (config !== null) writeFileSync(configPath, config, "utf8");

	const savedEnv = new Map<string, string | undefined>();
	for (const v of ENV_VARS) {
		savedEnv.set(v, process.env[v]);
		delete process.env[v];
	}

	const betaClient = opts.betaClient;
	const fake = createFakeCtx({
		configPath,
		modelWindow: opts.modelWindow,
		createOpencodeClientV2Beta: betaClient ? () => betaClient : undefined,
	});
	const cleanup = await V2Backend.create(fake.ctx, fake.seams);

	return {
		fake,
		cleanup,
		cleanupTests: () => {
			rmSync(home, { recursive: true, force: true });
			for (const v of ENV_VARS) {
				const prev = savedEnv.get(v);
				if (prev === undefined) delete process.env[v];
				else process.env[v] = prev;
			}
		},
	};
}

function usageTokens(
	tokens: {
		input?: number;
		output?: number;
		reasoning?: number;
		cache?: { read?: number; write?: number };
	},
	sessionID = "s1",
): V2Event {
	return {
		type: "session.usage.updated",
		data: { sessionID, tokens },
	};
}

function compactEnded(sessionID = "s1"): V2Event {
	return {
		type: "session.compaction.ended",
		data: { sessionID, reason: "auto", text: "compacted", recent: [] },
	};
}

describe("V2Backend — context warning injection", () => {
	test("injects a warning on EVERY context hook above the band, notifies once per rearm", async () => {
		const h = await boot(JSON.stringify({ warnPercent: 80, rearmPercent: 5 }), {
			modelWindow: 200_000,
		});
		// 170k of 200k = 85% >= 80% -> above band
		h.fake.pushEvent(usageTokens({ input: 165_000, output: 5_000 }));
		await sleep(5);

		const event1 = h.fake.fireContext(contextEvent());
		expect(event1.messages).toHaveLength(1);
		const injected1 = event1.messages[0];
		expect(injected1.role).toBe("user");
		expect(injected1.content[0]).toEqual({
			type: "text",
			text: expect.stringContaining("85%"),
		});
		expect(injected1.content[0]).toEqual({
			type: "text",
			text: expect.stringContaining("170,000/200,000"),
		});

		// Same tokens again: no rearm, but injection must still happen (the
		// injected message is transient per hook call).
		const event2 = h.fake.fireContext(contextEvent());
		expect(event2.messages).toHaveLength(1);

		// A rise past the rearm band notifies again.
		h.fake.pushEvent(usageTokens({ input: 195_000, output: 5_000 }));
		await sleep(5);
		const event3 = h.fake.fireContext(contextEvent());
		expect(event3.messages).toHaveLength(1);
		expect((event3.messages[0].content[0] as { text: string }).text).toContain(
			"100%",
		);

		h.cleanupTests();
	});

	test("token ground truth is the event-stream sum (input+output+reasoning+cache)", async () => {
		const h = await boot(JSON.stringify({ warnTokens: 1000 }), {});
		h.fake.pushEvent(
			usageTokens({
				input: 1000,
				output: 200,
				reasoning: 50,
				cache: { read: 30, write: 20 },
			}),
		);
		await sleep(5);
		const event = h.fake.fireContext(contextEvent());
		const text = (event.messages[0].content[0] as { text: string }).text;
		expect(text).toContain("1,300");
		h.cleanupTests();
	});

	test("does not inject before any completed step reported tokens", async () => {
		const h = await boot(JSON.stringify({ warnTokens: 1000 }), {});
		const event = h.fake.fireContext(contextEvent());
		expect(event.messages).toHaveLength(0);
		h.cleanupTests();
	});

	test("tokens below the band inject nothing", async () => {
		const h = await boot(JSON.stringify({ warnTokens: 1000 }), {});
		h.fake.pushEvent(usageTokens({ input: 100, output: 10 }));
		await sleep(5);
		const event = h.fake.fireContext(contextEvent());
		expect(event.messages).toHaveLength(0);
		h.cleanupTests();
	});

	test("a zero-output usage sample (mid-stream) does not trigger injection", async () => {
		const h = await boot(JSON.stringify({ warnTokens: 1000 }), {});
		h.fake.pushEvent(usageTokens({ input: 5000, output: 0 })); // partial sample
		await sleep(5);
		const event = h.fake.fireContext(contextEvent());
		expect(event.messages).toHaveLength(0);
		h.cleanupTests();
	});

	test("no warning injected when no sessionID present", async () => {
		const h = await boot(JSON.stringify({ warnTokens: 1000 }), {});
		h.fake.pushEvent(usageTokens({ input: 5000, output: 500 }));
		await sleep(5);
		const event = h.fake.fireContext({
			...contextEvent(),
			sessionID: "",
		});
		expect(event.messages).toHaveLength(0);
		h.cleanupTests();
	});
});

describe("V2Backend — model window lookup", () => {
	test("resolves the window via catalog.transform model.get and uses it for the percent band", async () => {
		const h = await boot(JSON.stringify({ warnPercent: 50 }), {
			modelWindow: 200_000,
		});
		// The window lookup happens lazily on the first hook (no tokens yet,
		// so nothing is injected), then is cached for every later hook.
		const first = h.fake.fireContext(contextEvent());
		expect(first.messages).toHaveLength(0);
		expect(h.fake.modelLookups).toEqual([
			{ providerID: "opencode-go", modelID: "deepseek-v4-flash" },
		]);

		h.fake.pushEvent(usageTokens({ input: 120_000, output: 1 })); // 60% of 200k
		await sleep(5);
		const event = h.fake.fireContext(contextEvent());
		const text = (event.messages[0].content[0] as { text: string }).text;
		expect(text).toContain("60%");
		// the lookup happens once per model, not per hook
		expect(h.fake.modelLookups).toHaveLength(1);
		h.cleanupTests();
	});

	test("config windowTokens overrides the catalog lookup", async () => {
		const h = await boot(
			JSON.stringify({ warnPercent: 50, windowTokens: 100_000 }),
			{ modelWindow: 200_000 },
		);
		expect(h.fake.modelLookups).toHaveLength(0);

		h.fake.pushEvent(usageTokens({ input: 60_000, output: 1 })); // 60% of 100k
		await sleep(5);
		const event = h.fake.fireContext(contextEvent());
		const text = (event.messages[0].content[0] as { text: string }).text;
		expect(text).toContain("60%");
		expect(text).toContain("60,001/100,000");
		h.cleanupTests();
	});
});

describe("V2Backend — compact_context tool", () => {
	test("registers compact_context and execute compacts without throwing", async () => {
		const calls: { sessionID: string }[] = [];
		const betaClient: V2BetaCompactClient = {
			session: {
				compact: async (params) => {
					calls.push(params);
					return {};
				},
			},
		};
		const h = await boot(null, { betaClient });

		const tool = h.fake.toolDefs.find((t) => t.name === "compact_context");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("compact_context tool missing");
		expect(tool.options).toEqual({ codemode: false });
		const result = await tool.execute({}, { sessionID: "s1" });
		expect(calls).toEqual([{ sessionID: "s1" }]);
		expect(result).toEqual({ content: "Compaction requested." });
		h.cleanupTests();
	});

	test("returns an honest failure string when the beta client is unavailable", async () => {
		const h = await boot(null);
		const tool = h.fake.toolDefs.find((t) => t.name === "compact_context");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("compact_context tool missing");
		const result = await tool.execute({}, { sessionID: "s1" });
		expect(result).toEqual({
			content: "Compaction failed: v2 beta compact client unavailable",
		});
		h.cleanupTests();
	});
});

describe("V2Backend — post-compact continue", () => {
	test("sends the configured text via session.prompt when enabled", async () => {
		const h = await boot(
			JSON.stringify({
				postCompactContinue: true,
				postCompactMsg: "resume from here",
			}),
		);
		h.fake.pushEvent(compactEnded("s1"));
		await sleep(5);
		expect(h.fake.prompts).toEqual([
			{ sessionID: "s1", text: "resume from here" },
		]);
		h.cleanupTests();
	});

	test("sends nothing when postCompactContinue is off", async () => {
		const h = await boot(null);
		h.fake.pushEvent(compactEnded("s1"));
		await sleep(5);
		expect(h.fake.prompts).toHaveLength(0);
		h.cleanupTests();
	});
});

describe("V2Backend — console-only notify", () => {
	test("config problems are logged to the console once at setup", async () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		const h = await boot(JSON.stringify({ warnPercent: -1 }), {});
		const calls = spy.mock.calls.map((c) => c.join(" "));
		expect(calls.some((c) => c.includes("invalid config"))).toBe(true);
		spy.mockRestore();
		h.cleanupTests();
	});

	test("verbose warnings reach the console (toast is a no-op)", async () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		const h = await boot(JSON.stringify({ warnPercent: 80, verbose: true }), {
			modelWindow: 200_000,
		});
		h.fake.pushEvent(usageTokens({ input: 165_000, output: 5_000 }));
		await sleep(5);
		h.fake.fireContext(contextEvent());
		const calls = spy.mock.calls.map((c) => c.join(" "));
		expect(calls.some((c) => c.includes("context warning injected"))).toBe(
			true,
		);
		// The toast text never reaches the console: `showToast` is a
		// deliberate no-op under the v2 backend, which has no server toast.
		expect(calls.some((c) => c.includes("Context window at 85%"))).toBe(false);
		spy.mockRestore();
		h.cleanupTests();
	});
});

describe("V2Backend — lifecycle", () => {
	test("cleanup stops the event drain and resolves", async () => {
		const h = await boot(JSON.stringify({ warnTokens: 1000 }), {});
		h.fake.pushEvent(usageTokens({ input: 5000, output: 500 }, "sA"));
		await sleep(5);
		expect(h.fake.fireContext(contextEvent("sA")).messages).toHaveLength(1);

		await h.cleanup();

		// after cleanup the drain must not process new events
		h.fake.pushEvent(usageTokens({ input: 5000, output: 500 }, "sB"));
		await sleep(5);
		expect(h.fake.fireContext(contextEvent("sB")).messages).toHaveLength(0);
		h.cleanupTests();
	});
});

describe("entry setup", () => {
	test("the default export exposes a setup that returns a cleanup", async () => {
		const home = mkdtempSync(join(tmpdir(), "context-watch-v2-entry-"));
		const fake = createFakeCtx({ configPath: join(home, "config.json") });
		// calling the REAL entry: no seams are passed, so the config path
		// falls back to the default (read-only) and the guarded beta import
		// fails silently — only the shape contract is asserted here.
		const cleanup = await plugin.setup(fake.ctx);
		expect(typeof cleanup).toBe("function");
		await cleanup();
		expect(fake.contextHookRegistered()).toBe(true);
		rmSync(home, { recursive: true, force: true });
	});
});

describe("buildV2Warning", () => {
	test("builds a v2 Message with content text parts", () => {
		const msg = buildV2Warning("s1", "warning text");
		expect(msg.role).toBe("user");
		expect(msg.id).toContain("msg_cw_");
		expect(msg.content).toEqual([{ type: "text", text: "warning text" }]);
		expect(msg.metadata).toEqual({});
	});
});
