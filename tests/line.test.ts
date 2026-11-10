import { describe, expect, test } from "bun:test";

import { compactCount, contextLine } from "../src/line";
import type { ContextStatus } from "../src/status";

const base: ContextStatus = {
	sessionID: "ses_1",
	warnPercent: 0.8,
	warnTokens: null,
	over: false,
	compacting: false,
};

describe("compactCount", () => {
	test("keeps small counts and compacts large ones", () => {
		expect(compactCount(999)).toBe("999");
		expect(compactCount(394_000)).toBe("394k");
		expect(compactCount(1_000_000)).toBe("1M");
		expect(compactCount(1_234_567)).toBe("1.2M");
	});

	test("rejects what cannot be a count", () => {
		expect(compactCount(Number.NaN)).toBe("?");
		expect(compactCount(-1)).toBe("?");
	});
});

describe("contextLine", () => {
	test("percent and sizes when the window is known", () => {
		expect(
			contextLine({ ...base, tokens: 394_000, window: 1_000_000, percent: 39.4 }),
		).toBe("39% · 394k/1M · warn 80%");
	});

	test("tokens only when the window is unknown", () => {
		expect(contextLine({ ...base, warnPercent: 0.8, tokens: 90_000 })).toBe(
			"90k tokens · warn 80%",
		);
	});

	test("compacting hides a stale sample", () => {
		expect(
			contextLine({
				...base,
				compacting: true,
				tokens: 394_000,
				window: 1_000_000,
				percent: 39.4,
			}),
		).toBe("compacting · warn 80%");
	});

	test("no sample yet", () => {
		expect(contextLine({ ...base, warnTokens: 300_000 })).toBe(
			"no sample yet · warn 300k",
		);
	});

	test("warn off", () => {
		expect(
			contextLine({ ...base, warnPercent: null, warnTokens: null, tokens: 10 }),
		).toBe("10 tokens · warn off");
	});
});
