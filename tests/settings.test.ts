import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import {
	type AssistantTokens,
	type Harness,
	buildMessages,
	createHarness,
	must,
} from "./harness";

const BAND = JSON.stringify({
	warnPercent: 50,
	warnTokens: 1_000_000,
	windowTokens: 100_000,
	rearmPercent: 5,
	rearmTokens: 5_000,
	message: "usage {percent}% {tokens}/{window}",
});

async function runTransform(h: Harness, tokens: AssistantTokens) {
	const output = buildMessages(tokens);
	const transform = must(
		h.handlers["experimental.chat.messages.transform"],
		"transform hook",
	);
	await transform({}, output);
	return output;
}

function settingsTool(h: Harness) {
	return must(h.handlers.tool?.context_watch_settings, "settings tool");
}

describe("context_watch_settings (v1)", () => {
	test("registers the tool on the v1 tool surface with an action arg schema", async () => {
		const h = await createHarness(null);
		const tool = settingsTool(h);
		expect(tool.description).toContain("reload");
		expect(tool.description).toContain("disable");
		const actionArg = tool.args.action as unknown as { options?: string[] };
		expect(actionArg.options).toEqual([
			"reload",
			"disable",
			"enable",
			"status",
		]);
		h.cleanup();
	});

	test("reload applies a rewritten warnPercent live", async () => {
		// 60% of the window: under the 90% boot band, over the 50% reloaded band.
		const h = await createHarness(
			JSON.stringify({
				warnPercent: 90,
				warnTokens: 1_000_000,
				windowTokens: 100_000,
				rearmPercent: 5,
				rearmTokens: 5_000,
				message: "usage {percent}% {tokens}/{window}",
			}),
		);
		const output1 = await runTransform(h, { input: 55_000, output: 5_000 });
		expect(output1.messages).toHaveLength(2); // no warning at 60% < 90%

		writeFileSync(
			h.configPath,
			JSON.stringify({
				warnPercent: 50,
				warnTokens: 1_000_000,
				windowTokens: 100_000,
				rearmPercent: 5,
				rearmTokens: 5_000,
				message: "usage {percent}% {tokens}/{window}",
			}),
			"utf8",
		);
		const result = await settingsTool(h).execute(
			{ action: "reload" },
			{} as never,
		);
		expect(result).toContain("Reloaded");

		const output2 = await runTransform(h, { input: 55_000, output: 5_000 });
		expect(output2.messages).toHaveLength(3); // warning injected at 60% >= 50%
		const text = (output2.messages[2].parts[0] as { text: string }).text;
		expect(text).toContain("60%");
		h.cleanup();
	});

	test("disable stops injection; enable resumes it", async () => {
		const h = await createHarness(BAND);
		const tool = settingsTool(h);

		expect(
			(await runTransform(h, { input: 60_000, output: 10_000 })).messages,
		).toHaveLength(3); // 70% >= 50%

		expect(await tool.execute({ action: "disable" }, {} as never)).toBe(
			"Warning injection disabled",
		);
		expect(
			(await runTransform(h, { input: 70_000, output: 10_000 })).messages,
		).toHaveLength(2); // above band, but disabled

		expect(await tool.execute({ action: "enable" }, {} as never)).toBe(
			"Warning injection enabled",
		);
		expect(
			(await runTransform(h, { input: 70_000, output: 10_000 })).messages,
		).toHaveLength(3);
		h.cleanup();
	});

	test("status returns a string mentioning the config path and enabled state", async () => {
		const h = await createHarness(null);
		const result = await settingsTool(h).execute(
			{ action: "status" },
			{} as never,
		);
		expect(typeof result).toBe("string");
		expect(result).toContain(h.configPath);
		expect(result).toContain("enabled=true");
		h.cleanup();
	});

	test("reload with an invalid config file reports problems without throwing", async () => {
		const h = await createHarness(null);
		writeFileSync(h.configPath, "{ not json !!", "utf8");
		const result = await settingsTool(h).execute(
			{ action: "reload" },
			{} as never,
		);
		expect(result).toContain("Reloaded");
		expect(result).toContain("problem");

		const reloadErr = h.appLogs.find(
			(l) => l.message === "invalid config (reload)",
		);
		expect(reloadErr).toBeDefined();
		const keys = (
			(reloadErr?.extra as { problems: { key: string }[] }).problems ?? []
		).map((p) => p.key);
		expect(keys).toContain("file");
		// reload problems are error-toasted like load-time problems
		expect(h.toasts.filter((t) => t.variant === "error")).toHaveLength(1);
		h.cleanup();
	});

	test("unknown action returns the help string without throwing", async () => {
		const h = await createHarness(null);
		const result = await settingsTool(h).execute(
			{ action: "bogus" } as never,
			{} as never,
		);
		expect(result).toContain("reload");
		expect(result).toContain("disable");
		expect(result).toContain("enable");
		expect(result).toContain("status");
		h.cleanup();
	});

	test("reload clears the per-session rearm state so the toast re-fires", async () => {
		const h = await createHarness(BAND);
		// first crossing fires the warning toast
		await runTransform(h, { input: 60_000, output: 10_000 }); // 70%
		expect(h.toasts.filter((t) => t.variant === "warning")).toHaveLength(1);
		// same tokens again: no rearm rise -> no new toast
		await runTransform(h, { input: 60_000, output: 10_000 });
		expect(h.toasts.filter((t) => t.variant === "warning")).toHaveLength(1);

		// reload with the same thresholds clears lastWarned
		await settingsTool(h).execute({ action: "reload" }, {} as never);

		await runTransform(h, { input: 60_000, output: 10_000 });
		expect(h.toasts.filter((t) => t.variant === "warning")).toHaveLength(2);
		h.cleanup();
	});
});
