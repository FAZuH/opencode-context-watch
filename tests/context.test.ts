import { describe, expect, test } from "bun:test";
import {
	type AssessOptions,
	assess,
	contextTokens,
	renderMessage,
} from "../src/context";
import { ModelInfoCache } from "../src/model-info";
import { type OutputMessage, createWarning } from "../src/warning";

const OPTS: AssessOptions = {
	warnPercent: 0.8,
	warnTokens: 1_000_000,
	rearmPercent: 5,
	rearmTokens: 5_000,
};

describe("assess", () => {
	test("does not fire when neither band is crossed", () => {
		const a = assess(OPTS, 50_000, 100_000, undefined); // 50% of 100k
		expect(a.pct).toBe(50);
		expect(a.overPercent).toBe(false);
		expect(a.overTokens).toBe(false);
		expect(a.shouldInject).toBe(false);
		expect(a.shouldNotify).toBe(false);
	});

	test("fires on the percent band with a known window", () => {
		const a = assess(OPTS, 90_000, 100_000, undefined); // 90%
		expect(a.overPercent).toBe(true);
		expect(a.shouldInject).toBe(true);
		expect(a.shouldNotify).toBe(true);
		expect(a.next).toEqual({ pct: 90 });
	});

	test("fires on the tokens band when the window is unknown", () => {
		const a = assess(
			{ ...OPTS, warnTokens: 100_000 },
			120_000,
			undefined,
			undefined,
		);
		expect(a.pct).toBeUndefined();
		expect(a.overPercent).toBe(false);
		expect(a.overTokens).toBe(true);
		expect(a.shouldInject).toBe(true);
	});

	test("injects on every call but notifies only after a rearm rise (percent)", () => {
		const first = assess(OPTS, 90_000, 100_000, undefined);
		expect(first.shouldNotify).toBe(true);
		const smallRise = assess(OPTS, 92_000, 100_000, first.next); // +2 < 5
		expect(smallRise.shouldInject).toBe(true);
		expect(smallRise.shouldNotify).toBe(false);
		expect(smallRise.next).toEqual({ pct: 90 }); // not rearmed, stored value unchanged
		const bigRise = assess(OPTS, 96_000, 100_000, first.next); // +6 >= 5
		expect(bigRise.shouldNotify).toBe(true);
		expect(bigRise.next).toEqual({ pct: 96 });
	});

	test("notifies again on the tokens band only after a rearm rise", () => {
		const opts = { ...OPTS, warnPercent: 1.01, warnTokens: 100_000 };
		const first = assess(opts, 100_000, undefined, undefined);
		expect(first.shouldNotify).toBe(true);
		expect(first.next).toEqual({ tokens: 100_000 });
		const smallRise = assess(opts, 104_000, undefined, first.next); // +4k < 5k
		expect(smallRise.shouldNotify).toBe(false);
		const bigRise = assess(opts, 106_000, undefined, first.next); // +6k >= 5k
		expect(bigRise.shouldNotify).toBe(true);
		expect(bigRise.next).toEqual({ tokens: 106_000 });
	});

	test("tracks both bands independently and merges the stored values", () => {
		const a = assess(OPTS, 90_000, 100_000, { tokens: 1_000_000 });
		expect(a.shouldNotify).toBe(true);
		expect(a.next).toEqual({ tokens: 1_000_000, pct: 90 });
	});
});

describe("renderMessage", () => {
	const TEMPLATE = "usage {percent}% {tokens}/{window}";

	test("substitutes percent, tokens and window", () => {
		expect(renderMessage(TEMPLATE, 90, 90_000, 100_000)).toBe(
			"usage 90% 90,000/100,000",
		);
	});

	test("renders an unknown window and a 0 percent", () => {
		expect(renderMessage(TEMPLATE, undefined, 120_000, undefined)).toBe(
			"usage 0% 120,000/unknown",
		);
	});
});

describe("createWarning", () => {
	const user: OutputMessage = {
		info: {
			id: "msg_u",
			sessionID: "s1",
			role: "user",
			time: { created: 1 },
			agent: "builder",
			model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
		},
		parts: [],
	};

	test("clones agent and model from the last user message", () => {
		const w = createWarning("s1", "watch out", user);
		const info = w.info as {
			agent: string;
			model: { providerID: string; modelID: string };
		};
		expect(w.info.role).toBe("user");
		expect(w.info.sessionID).toBe("s1");
		expect(info.agent).toBe("builder");
		expect(info.model).toEqual({
			providerID: "anthropic",
			modelID: "claude-sonnet-4",
		});
		expect(w.parts[0]).toMatchObject({
			type: "text",
			synthetic: true,
			text: "watch out",
		});
	});

	test("falls back to the build agent and context-watch model without a user message", () => {
		const w = createWarning("s1", "watch out", undefined);
		const info = w.info as {
			agent: string;
			model: { providerID: string; modelID: string };
		};
		expect(info.agent).toBe("build");
		expect(info.model).toEqual({
			providerID: "opencode",
			modelID: "context-watch",
		});
	});
});

describe("ModelInfoCache", () => {
	test("captures and returns model info per session", () => {
		const cache = new ModelInfoCache();
		cache.capture("s1", {
			providerID: "opencode",
			id: "deepseek",
			limit: { context: 200_000 },
		});
		expect(cache.get("s1")).toEqual({
			providerID: "opencode",
			modelID: "deepseek",
			window: 200_000,
		});
	});

	test("merges across captures without clobbering earlier fields", () => {
		const cache = new ModelInfoCache();
		cache.capture("s1", {
			providerID: "opencode",
			limit: { context: 200_000 },
		});
		cache.capture("s1", { id: "deepseek" });
		expect(cache.get("s1")).toEqual({
			providerID: "opencode",
			modelID: "deepseek",
			window: 200_000,
		});
	});

	test("returns undefined for an unknown session", () => {
		expect(new ModelInfoCache().get("missing")).toBeUndefined();
	});
});

describe("contextTokens", () => {
	test("sums input, output, reasoning and cache from the latest completed assistant message", () => {
		const tokens = contextTokens([
			{
				info: { role: "user" } as never,
				parts: [],
			},
			{
				info: {
					role: "assistant",
					tokens: {
						input: 1_000,
						output: 100,
						reasoning: 50,
						cache: { read: 200, write: 50 },
					},
				} as never,
				parts: [],
			},
		]);
		expect(tokens).toBe(1_400);
	});

	test("returns undefined when no completed assistant message exists", () => {
		const tokens = contextTokens([
			{ info: { role: "user" } as never, parts: [] },
		]);
		expect(tokens).toBeUndefined();
	});
});
