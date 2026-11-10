import { describe, expect, test } from "bun:test";
import {
	type AssessOptions,
	assess,
	renderMessage,
	usageTotal,
	warningMessage,
} from "../src/context";

const OPTS: AssessOptions = {
	warnPercent: 0.8,
	warnTokens: 1_000_000,
	rearmPercent: 5,
	rearmTokens: 5_000,
};

describe("usageTotal", () => {
	test("adds every token bucket of one step", () => {
		expect(
			usageTotal({
				input: 10,
				output: 20,
				reasoning: 30,
				cache: { read: 40, write: 50 },
			}),
		).toBe(150);
	});

	test("treats missing buckets as zero", () => {
		expect(usageTotal({ input: 10 })).toBe(10);
	});

	test("has no sample when the step reported no input", () => {
		expect(usageTotal(undefined)).toBeUndefined();
		expect(usageTotal({ input: 0, output: 500 })).toBeUndefined();
	});
});

describe("assess", () => {
	test("does not fire below both bands", () => {
		const a = assess(OPTS, 50_000, 100_000, undefined);
		expect(a.shouldInject).toBe(false);
		expect(a.shouldNotify).toBe(false);
		expect(a.pct).toBe(50);
	});

	test("fires on the percent band with a known window", () => {
		const a = assess(OPTS, 90_000, 100_000, undefined);
		expect(a.overPercent).toBe(true);
		expect(a.shouldInject).toBe(true);
		expect(a.next).toEqual({ pct: 90 });
	});

	test("the percent band is off without a window, so only tokens can fire", () => {
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
		expect(a.next).toEqual({ tokens: 120_000 });
	});

	test("a null percent band leaves only the token band", () => {
		const a = assess(
			{ ...OPTS, warnPercent: null, warnTokens: 100_000 },
			120_000,
			100_000,
			undefined,
		);
		expect(a.overPercent).toBe(false);
		expect(a.overTokens).toBe(true);
		expect(a.shouldInject).toBe(true);
	});

	test("a null token band leaves only the percent band", () => {
		const a = assess({ ...OPTS, warnTokens: null }, 90_000, 100_000, undefined);
		expect(a.overPercent).toBe(true);
		expect(a.overTokens).toBe(false);
		expect(a.shouldInject).toBe(true);
	});

	test("both bands null never inject", () => {
		const a = assess(
			{ ...OPTS, warnPercent: null, warnTokens: null },
			999_999,
			100_000,
			undefined,
		);
		expect(a.shouldInject).toBe(false);
		expect(a.shouldNotify).toBe(false);
	});

	test("a sub-rearm rise still injects but does not re-notify", () => {
		const first = assess(OPTS, 90_000, 100_000, undefined);
		const small = assess(OPTS, 92_000, 100_000, first.next);
		expect(small.shouldInject).toBe(true);
		expect(small.shouldNotify).toBe(false);
		expect(small.next).toEqual({ pct: 90 });
		const big = assess(OPTS, 96_000, 100_000, first.next);
		expect(big.shouldNotify).toBe(true);
		expect(big.next).toEqual({ pct: 96 });
	});
});

describe("renderMessage", () => {
	test("substitutes every placeholder", () => {
		expect(
			renderMessage("{percent}% {tokens}/{window}", 82.4, 1500, 2000),
		).toBe("82% 1,500/2,000");
	});

	test("reports an unknown window instead of NaN", () => {
		expect(
			renderMessage("{percent}%/{window}", undefined, 1500, undefined),
		).toBe("0%/unknown");
	});

	test("renders {usage} with both counts when the window is known", () => {
		expect(renderMessage("at {usage}", 29, 300_000, 1_048_576)).toBe(
			"at 29% (300,000/1,048,576 tokens)",
		);
	});

	test("renders {usage} as tokens alone without a window", () => {
		expect(renderMessage("at {usage}", undefined, 300_000, undefined)).toBe(
			"at 300,000 tokens",
		);
	});
});

describe("warningMessage", () => {
	test("is a user message carrying one text part", () => {
		expect(warningMessage("CWVERIFIED")).toEqual({
			role: "user",
			content: [{ type: "text", text: "CWVERIFIED" }],
		});
	});
});
