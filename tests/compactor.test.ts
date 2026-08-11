import { describe, expect, test } from "bun:test";
import {
	type CompactOutcome,
	type CompactStrategy,
	Compactor,
	type SummarizeFn,
	V1SummarizeStrategy,
	type V2CompactClient,
	V2CompactStrategy,
	extractError,
	requestPostCompact,
} from "../src/compaction";
import type { ModelInfo } from "../src/model-info";

const MODEL: ModelInfo = {
	providerID: "opencode",
	modelID: "deepseek",
	window: 200_000,
};

const logs: { message: string; extra: Record<string, unknown> }[] = [];
const makeCompactor = (strategies: CompactStrategy[]) => {
	logs.length = 0;
	return new Compactor(strategies, (message, extra) =>
		logs.push({ message, extra }),
	);
};

function strategy(result: CompactOutcome, name = "stub"): CompactStrategy {
	return { name, compact: async () => result };
}

describe("extractError", () => {
	test("extracts a string error from a resolved response", () => {
		expect(extractError({ error: "nope", response: {} })).toBe("nope");
	});

	test("serializes a structured error", () => {
		const err = extractError({ error: { message: "boom" } });
		expect(err).toContain("boom");
	});

	test("returns undefined for a clean resolution", () => {
		expect(extractError({ response: {} })).toBeUndefined();
		expect(extractError(undefined)).toBeUndefined();
	});
});

describe("Compactor", () => {
	test("returns 'Compaction requested.' when the first strategy succeeds", async () => {
		const c = makeCompactor([strategy({ status: "requested" })]);
		expect(await c.compact("s1", MODEL)).toBe("Compaction requested.");
	});

	test("falls through to the next strategy on failure", async () => {
		const c = makeCompactor([
			strategy({ status: "failed", error: "v2 down" }),
			strategy({ status: "requested" }, "v1"),
		]);
		expect(await c.compact("s1", MODEL)).toBe("Compaction requested.");
		expect(logs[0]).toMatchObject({
			message: "compaction request failed (stub)",
			extra: { sessionID: "s1" },
		});
	});

	test("combines all failure details into one result string", async () => {
		const c = makeCompactor([
			strategy({ status: "failed", error: "a" }, "first"),
			strategy({ status: "failed", error: "b" }, "second"),
		]);
		expect(await c.compact("s1", MODEL)).toBe("Compaction failed: a; b");
	});
});

describe("V2CompactStrategy", () => {
	test("requests compaction when the v2 endpoint resolves cleanly", async () => {
		const client: V2CompactClient = {
			v2: { session: { compact: async () => ({}) } },
		};
		const s = new V2CompactStrategy(client);
		expect(await s.compact({ sessionID: "s1", model: MODEL })).toEqual({
			status: "requested",
		});
	});

	test("fails on a resolved error (1.18.11 stub) and on a rejection", async () => {
		const stub: V2CompactClient = {
			v2: {
				session: {
					compact: async () => ({
						error: { message: "Session compact is not available yet" },
					}),
				},
			},
		};
		expect(
			await new V2CompactStrategy(stub).compact({
				sessionID: "s1",
				model: MODEL,
			}),
		).toMatchObject({
			status: "failed",
		});

		const reject: V2CompactClient = {
			v2: {
				session: {
					compact: async () => {
						throw new Error("boom");
					},
				},
			},
		};
		const out = await new V2CompactStrategy(reject).compact({
			sessionID: "s1",
			model: MODEL,
		});
		expect(out).toEqual({ status: "failed", error: "boom" });
	});
});

describe("V1SummarizeStrategy", () => {
	const summarize = (calls: { providerID: string; modelID: string }[]) =>
		((sessionID, model) => {
			calls.push(model);
			return Promise.resolve({});
		}) satisfies SummarizeFn;

	test("summarizes with the cached model info and reports requested", async () => {
		const calls: { providerID: string; modelID: string }[] = [];
		const s = new V1SummarizeStrategy(summarize(calls), 100);
		expect(await s.compact({ sessionID: "s1", model: MODEL })).toEqual({
			status: "requested",
		});
		expect(calls).toEqual([{ providerID: "opencode", modelID: "deepseek" }]);
	});

	test("fails honestly without calling summarize when no model is cached", async () => {
		let called = false;
		const strategy = new V1SummarizeStrategy(() => {
			called = true;
			return Promise.resolve({});
		}, 100);
		expect(
			await strategy.compact({ sessionID: "s1", model: undefined }),
		).toEqual({
			status: "failed",
			error: "no model info cached for summarize",
		});
		expect(called).toBe(false);
	});

	test("returns requested when the summarize hangs past the timeout (fire-and-forget)", async () => {
		const s = new V1SummarizeStrategy(() => new Promise<never>(() => {}), 20);
		const started = Date.now();
		const out = await s.compact({ sessionID: "s1", model: MODEL });
		expect(out).toEqual({ status: "requested" });
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test("reports a rejected summarize as a failure", async () => {
		const s = new V1SummarizeStrategy(async () => {
			throw new Error("nope");
		}, 100);
		expect(await s.compact({ sessionID: "s1", model: MODEL })).toEqual({
			status: "failed",
			error: "nope",
		});
	});
});

describe("requestPostCompact", () => {
	test("fires the prompt with the session and agent and swallows failures", async () => {
		const calls: { sessionID: string; agent: string; text: string }[] = [];
		requestPostCompact(
			(sessionID, agent, text) => {
				calls.push({ sessionID, agent, text });
				return Promise.resolve({});
			},
			{ sessionID: "s1", agent: "build" },
			"resume",
		);
		await new Promise((r) => setTimeout(r, 0));
		expect(calls).toEqual([
			{ sessionID: "s1", agent: "build", text: "resume" },
		]);
	});

	test("never rejects when the prompt rejects", async () => {
		requestPostCompact(
			async () => {
				throw new Error("injection failed");
			},
			{ sessionID: "s1", agent: "build" },
			"resume",
		);
		await new Promise((r) => setTimeout(r, 0));
	});
});
