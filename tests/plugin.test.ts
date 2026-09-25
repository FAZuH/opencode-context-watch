import { describe, expect, spyOn, test } from "bun:test";
import plugin from "../src/index";
import type {
	ContextEvent,
	ContextMessage,
	ModelInfo,
	PluginContext,
	PluginEvent,
	StepTokens,
} from "../src/types";

const MODELS: ModelInfo[] = [
	{ id: "big", providerID: "acme", limit: { context: 100_000 } },
	{ id: "tiny", providerID: "acme" },
];

const stepEnded = (sessionID: string, tokens: StepTokens): PluginEvent => ({
	type: "session.step.ended",
	data: { sessionID, tokens },
});

/** A macrotask boundary: the plugin's event loop does no I/O per event, so
 * everything it was handed has been processed once this resolves. */
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Fix {
	options?: unknown;
	models?: ModelInfo[];
	modelListFails?: boolean;
	hookFails?: boolean;
}

function fakeContext(fix: Fix = {}) {
	const queue: PluginEvent[] = [];
	let wake: (() => void) | undefined;
	let signal: AbortSignal | undefined;
	let hooks: ((event: ContextEvent) => void)[] = [];
	let disposals = 0;

	const ctx: PluginContext = {
		options: fix.options,
		model: {
			list: async () => {
				if (fix.modelListFails) throw new Error("model list boom");
				return { data: fix.models ?? [] };
			},
		},
		session: {
			hook: async (_name, callback) => {
				if (fix.hookFails) throw new Error("hook boom");
				hooks = [...hooks, callback];
				return {
					dispose: () => {
						disposals++;
					},
				};
			},
		},
		event: {
			subscribe: async (options) => {
				const controller = options.signal;
				signal = controller;
				controller?.addEventListener("abort", () => {
					wake?.();
				});
				return (async function* () {
					for (;;) {
						while (queue.length > 0) yield queue.shift() as PluginEvent;
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
						if (controller?.aborted) return;
					}
				})();
			},
		},
	};

	const emit = async (event: PluginEvent) => {
		queue.push(event);
		wake?.();
		wake = undefined;
		await drain();
	};

	const request = async (
		over: Partial<ContextEvent> & { sessionID: string },
	): Promise<ContextMessage[]> => {
		const messages: ContextMessage[] = [];
		await hooks[0]({
			model: { id: "big", providerID: "acme" },
			messages,
			...over,
		});
		return messages;
	};

	return {
		ctx,
		emit,
		request,
		disposals: () => disposals,
		aborted: () => signal?.aborted === true,
	};
}

const start = async (fix: Fix = {}) => {
	const fake = fakeContext(fix);
	const dispose = await plugin.setup(fake.ctx);
	await drain();
	return { ...fake, dispose: async () => void (await dispose?.()) };
};

const injectedText = (messages: ContextMessage[]) =>
	messages
		.filter((m) => m.role === "user")
		.flatMap((m) => m.content as { type: string; text: string }[])
		.map((part) => part.text)
		.join("\n");

describe("plugin setup", () => {
	test("warns once a completed step is over the percent band of the model window", async () => {
		const fake = await start({
			options: { warnPercent: 0.8 },
			models: MODELS,
		});
		await fake.emit(stepEnded("s1", { input: 90_000, output: 0 }));
		const messages = await fake.request({ sessionID: "s1" });
		expect(injectedText(messages)).toContain("90%");
	});

	test("does not warn before any step has completed", async () => {
		const fake = await start({ options: { warnPercent: 0.1 }, models: MODELS });
		expect(await fake.request({ sessionID: "s1" })).toEqual([]);
	});

	test("a model with no known window can only trip the token band", async () => {
		const unknown = await start({
			options: { warnPercent: 0.1, warnTokens: 10_000_000 },
			models: [],
		});
		await unknown.emit(stepEnded("s1", { input: 90_000 }));
		expect(await unknown.request({ sessionID: "s1" })).toEqual([]);

		const listed = await start({
			options: { warnPercent: 0.1, warnTokens: 10_000_000 },
			models: MODELS,
		});
		await listed.emit(stepEnded("s1", { input: 90_000 }));
		expect(await listed.request({ sessionID: "s1" })).toHaveLength(1);
		// a window is only used for the model the request actually names
		expect(
			await listed.request({
				sessionID: "s1",
				model: { id: "big", providerID: "other" },
			}),
		).toEqual([]);
		expect(
			await listed.request({
				sessionID: "s1",
				model: { id: "tiny", providerID: "acme" },
			}),
		).toEqual([]);
	});

	test("windowTokens replaces the model window", async () => {
		const windowless = await start({
			options: { warnPercent: 0.5, windowTokens: 1_000_000 },
			models: MODELS,
		});
		await windowless.emit(stepEnded("s1", { input: 90_000 }));
		expect(await windowless.request({ sessionID: "s1" })).toEqual([]);

		const narrow = await start({
			options: { warnPercent: 0.5, windowTokens: 100_000 },
			models: [],
		});
		await narrow.emit(stepEnded("s2", { input: 90_000 }));
		expect(await narrow.request({ sessionID: "s2" })).toHaveLength(1);
	});

	test("cumulative usage events are not a context sample", async () => {
		const fake = await start({ options: { warnPercent: 0.1 }, models: MODELS });
		await fake.emit({
			type: "session.usage.updated",
			data: { sessionID: "s1", tokens: { input: 900_000 } },
		});
		expect(await fake.request({ sessionID: "s1" })).toEqual([]);
		await fake.emit(stepEnded("s1", { input: 20_000 }));
		expect(await fake.request({ sessionID: "s1" })).toHaveLength(1);
	});

	test("the newest completed step replaces the previous sample", async () => {
		const fake = await start({
			options: { warnPercent: 0.8, warnTokens: 10_000_000 },
			models: MODELS,
		});
		await fake.emit(stepEnded("s1", { input: 90_000 }));
		await fake.emit(stepEnded("s1", { input: 1_000 }));
		expect(await fake.request({ sessionID: "s1" })).toEqual([]);
	});

	test("usage is per session", async () => {
		const fake = await start({
			options: { warnPercent: 0.8, warnTokens: 10_000_000 },
			models: MODELS,
		});
		await fake.emit(stepEnded("s1", { input: 90_000 }));
		expect(await fake.request({ sessionID: "s2" })).toEqual([]);
	});

	test("warns on every above-threshold request but logs only on a rearm rise", async () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			const fake = await start({
				options: { warnPercent: 0.8, verbose: true },
				models: MODELS,
			});
			await fake.emit(stepEnded("s1", { input: 90_000 }));
			expect(await fake.request({ sessionID: "s1" })).toHaveLength(1);
			expect(await fake.request({ sessionID: "s1" })).toHaveLength(1);
			expect(log.mock.calls.length).toBe(1);
			expect(String(log.mock.calls[0]?.[0])).toContain("s1");

			await fake.emit(stepEnded("s1", { input: 95_000 }));
			expect(await fake.request({ sessionID: "s1" })).toHaveLength(1);
			expect(log.mock.calls.length).toBe(2);
			expect(await fake.request({ sessionID: "s1" })).toHaveLength(1);
			expect(log.mock.calls.length).toBe(2);
		} finally {
			log.mockRestore();
		}
	});

	test("stays silent when verbose is off", async () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			const fake = await start({
				options: { warnPercent: 0.8 },
				models: MODELS,
			});
			await fake.emit(stepEnded("s1", { input: 90_000 }));
			await fake.request({ sessionID: "s1" });
			expect(log).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});

	test("a failed model list still warns on the token band", async () => {
		const error = spyOn(console, "error").mockImplementation(() => {});
		try {
			const fake = await start({
				options: { warnTokens: 1_000 },
				modelListFails: true,
			});
			await fake.emit(stepEnded("s1", { input: 2_000 }));
			expect(await fake.request({ sessionID: "s1" })).toHaveLength(1);
			expect(String(error.mock.calls[0]?.[0])).toContain(
				"model list unavailable",
			);
		} finally {
			error.mockRestore();
		}
	});

	test("config problems are logged and the good keys still apply", async () => {
		const error = spyOn(console, "error").mockImplementation(() => {});
		try {
			const fake = await start({
				options: { warnPercent: "nope", warnTokens: 1_000, bogus: 1 },
				models: MODELS,
			});
			expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
				'[context-watch] bogus: unknown option "bogus" (ignored)',
				'[context-watch] warnPercent: must be a number greater than 0 and at most 100 (got "nope")',
			]);
			await fake.emit(stepEnded("s1", { input: 1_500 }));
			expect(await fake.request({ sessionID: "s1" })).toHaveLength(1);
		} finally {
			error.mockRestore();
		}
	});

	test("the template reaches the model with the placeholders filled in", async () => {
		const fake = await start({
			options: {
				warnPercent: 0.8,
				message: "CWVERIFIED {percent} {tokens}/{window}",
			},
			models: MODELS,
		});
		await fake.emit(stepEnded("s1", { input: 90_000 }));
		const messages = await fake.request({ sessionID: "s1" });
		expect(messages[0]).toEqual({
			role: "user",
			content: [{ type: "text", text: "CWVERIFIED 90 90,000/100,000" }],
		});
	});

	test("a malformed step.ended does not kill the usage source", async () => {
		const error = spyOn(console, "error").mockImplementation(() => {});
		try {
			const fake = await start({
				options: { warnPercent: 0.8 },
				models: MODELS,
			});
			await fake.emit({ type: "session.step.ended" }); // no data at all
			await fake.emit({ type: "session.step.ended", data: null });
			await fake.emit({
				type: "session.step.ended",
				data: { sessionID: "s1" },
			}); // no tokens
			expect(await fake.request({ sessionID: "s1" })).toEqual([]);
			expect(error).not.toHaveBeenCalled();

			await fake.emit(stepEnded("s1", { input: 90_000 }));
			expect(await fake.request({ sessionID: "s1" })).toHaveLength(1);
		} finally {
			error.mockRestore();
		}
	});

	test("a rejected hook registration aborts the event stream", async () => {
		const fake = fakeContext({ models: MODELS, hookFails: true });
		await expect(plugin.setup(fake.ctx)).rejects.toThrow("hook boom");
		await drain();
		expect(fake.aborted()).toBe(true);
		expect(fake.disposals()).toBe(0);
	});

	test("cleanup aborts the event stream and disposes the registration", async () => {
		const fake = await start({ models: MODELS });
		expect(fake.aborted()).toBe(false);
		await fake.dispose();
		expect(fake.aborted()).toBe(true);
		expect(fake.disposals()).toBe(1);
	});
});
