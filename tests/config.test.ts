import { describe, expect, test } from "bun:test";
import { DEFAULTS, resolveOptions } from "../src/config";

const keysOf = (raw: unknown) => resolveOptions(raw).problems.map((p) => p.key);

describe("resolveOptions", () => {
	test("absent options resolve to the defaults with no problems", () => {
		const { options, problems } = resolveOptions(undefined);
		expect(problems).toEqual([]);
		expect(options).toEqual(DEFAULTS);
	});

	test("valid options are applied verbatim", () => {
		const { options, problems } = resolveOptions({
			warnPercent: 0.5,
			warnTokens: 42,
			windowTokens: 1_000,
			rearmPercent: 1,
			rearmTokens: 2,
			verbose: true,
			message: "hi",
		});
		expect(problems).toEqual([]);
		expect(options).toEqual({
			warnPercent: 0.5,
			warnTokens: 42,
			windowTokens: 1_000,
			rearmPercent: 1,
			rearmTokens: 2,
			verbose: true,
			message: "hi",
		});
	});

	test("a percent-style warnPercent is normalized to a fraction", () => {
		expect(resolveOptions({ warnPercent: 77 }).options.warnPercent).toBe(0.77);
		expect(resolveOptions({ warnPercent: 0.77 }).options.warnPercent).toBe(
			0.77,
		);
	});

	test("a bad value falls back per key and reports only that key", () => {
		const { options, problems } = resolveOptions({
			warnPercent: 0.5,
			warnTokens: "nope",
			rearmTokens: -1,
			verbose: "yes",
		});
		expect(options.warnPercent).toBe(0.5);
		expect(options.warnTokens).toBe(DEFAULTS.warnTokens);
		expect(options.rearmTokens).toBe(DEFAULTS.rearmTokens);
		expect(options.verbose).toBe(DEFAULTS.verbose);
		expect(problems.map((p) => p.key)).toEqual([
			"warnTokens",
			"rearmTokens",
			"verbose",
		]);
	});

	test("a boolean cannot sneak into a numeric option", () => {
		const { options, problems } = resolveOptions({ warnPercent: true });
		expect(options.warnPercent).toBe(DEFAULTS.warnPercent);
		expect(problems.map((p) => p.key)).toEqual(["warnPercent"]);
	});

	test("windowTokens accepts null, a positive number, and rejects the rest", () => {
		expect(
			resolveOptions({ windowTokens: null }).options.windowTokens,
		).toBeNull();
		expect(resolveOptions({ windowTokens: 500 }).options.windowTokens).toBe(
			500,
		);
		expect(resolveOptions({ windowTokens: 0 }).options.windowTokens).toBeNull();
		expect(keysOf({ windowTokens: -5 })).toEqual(["windowTokens"]);
	});

	test("an empty message template is rejected", () => {
		const { options, problems } = resolveOptions({ message: "  " });
		expect(options.message).toBe(DEFAULTS.message);
		expect(problems.map((p) => p.key)).toEqual(["message"]);
	});

	test("unknown keys and a non-object root are reported", () => {
		expect(keysOf({ toast: false, compact_context: true })).toEqual([
			"toast",
			"compact_context",
		]);
		expect(keysOf([{ warnPercent: 0.5 }])).toEqual(["options"]);
		expect(resolveOptions([{ warnPercent: 0.5 }]).options.warnPercent).toBe(
			DEFAULTS.warnPercent,
		);
	});
});
