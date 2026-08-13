import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOptions } from "../src/config";
import { LiveConfig, handleSettingsAction } from "../src/live";

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

function withConfig(
	contents: string | null,
	fn: (configPath: string) => void,
): void {
	const home = mkdtempSync(join(tmpdir(), "context-watch-live-test-"));
	const configPath = join(home, "opencode-context-watch.json");
	if (contents !== null) writeFileSync(configPath, contents, "utf8");

	const savedEnv = new Map<string, string | undefined>();
	for (const v of ENV_VARS) {
		savedEnv.set(v, process.env[v]);
		delete process.env[v];
	}
	try {
		fn(configPath);
	} finally {
		rmSync(home, { recursive: true, force: true });
		for (const v of ENV_VARS) {
			const prev = savedEnv.get(v);
			if (prev === undefined) delete process.env[v];
			else process.env[v] = prev;
		}
	}
}

describe("LiveConfig", () => {
	test("reload mutates the SAME options object identity and updates notifyFlags", () => {
		withConfig(
			JSON.stringify({ warnPercent: 90, toast: false, verbose: false }),
			(configPath) => {
				const initial = loadOptions(configPath).options;
				const live = new LiveConfig(configPath, initial);
				expect(live.options).toBe(initial);
				expect(live.notifyFlags).toEqual({
					toastEnabled: false,
					verbose: false,
				});

				writeFileSync(
					configPath,
					JSON.stringify({ warnPercent: 50, toast: true, verbose: true }),
					"utf8",
				);
				const { problems } = live.reload();

				expect(problems).toHaveLength(0);
				expect(live.options).toBe(initial); // in-place: captured refs stay live
				expect(live.options.warnPercent).toBe(0.5);
				expect(live.notifyFlags).toEqual({
					toastEnabled: true,
					verbose: true,
				});
			},
		);
	});

	test("enabled starts true, toggles via setEnabled, and survives reload", () => {
		withConfig(null, (configPath) => {
			const live = new LiveConfig(configPath, loadOptions(configPath).options);
			expect(live.enabled).toBe(true);
			live.setEnabled(false);
			expect(live.enabled).toBe(false);
			live.reload();
			// runtime-only gate: reload does not re-enable
			expect(live.enabled).toBe(false);
			live.setEnabled(true);
			expect(live.enabled).toBe(true);
		});
	});

	test("statusText includes the effective thresholds and the config path", () => {
		withConfig(
			JSON.stringify({
				warnPercent: 77,
				warnTokens: 150_000,
				windowTokens: 100_000,
				rearmPercent: 5,
				rearmTokens: 5_000,
			}),
			(configPath) => {
				const live = new LiveConfig(
					configPath,
					loadOptions(configPath).options,
				);
				const text = live.statusText();
				expect(text).toContain("enabled=true");
				expect(text).toContain("77%");
				expect(text).toContain("150,000");
				expect(text).toContain("100,000");
				expect(text).toContain(configPath);
			},
		);
	});
});

describe("handleSettingsAction", () => {
	test("disable and enable toggle the gate and return status strings", () => {
		withConfig(null, (configPath) => {
			const live = new LiveConfig(configPath, loadOptions(configPath).options);
			const hooks = {
				clearLastWarned: () => {},
				reportProblems: () => {
					throw new Error("must not be called");
				},
			};
			expect(handleSettingsAction("disable", live, hooks)).toBe(
				"Warning injection disabled",
			);
			expect(live.enabled).toBe(false);
			expect(handleSettingsAction("enable", live, hooks)).toBe(
				"Warning injection enabled",
			);
			expect(live.enabled).toBe(true);
		});
	});

	test("status delegates to statusText", () => {
		withConfig(null, (configPath) => {
			const live = new LiveConfig(configPath, loadOptions(configPath).options);
			const result = handleSettingsAction("status", live, {
				clearLastWarned: () => {},
				reportProblems: () => {},
			});
			expect(result).toBe(live.statusText());
		});
	});

	test("unknown or missing actions return the help string without throwing", () => {
		withConfig(null, (configPath) => {
			const live = new LiveConfig(configPath, loadOptions(configPath).options);
			const hooks = {
				clearLastWarned: () => {},
				reportProblems: () => {
					throw new Error("must not be called");
				},
			};
			const help = handleSettingsAction("bogus", live, hooks);
			expect(help).toContain("reload");
			expect(help).toContain("disable");
			expect(help).toContain("enable");
			expect(help).toContain("status");
			expect(handleSettingsAction(undefined, live, hooks)).toBe(help);
		});
	});

	test("reload with a clean file reports no problems and clears lastWarned + window lookups", () => {
		withConfig(JSON.stringify({ warnPercent: 90 }), (configPath) => {
			const live = new LiveConfig(configPath, loadOptions(configPath).options);
			let cleared = 0;
			let reported = 0;
			let windowsCleared = 0;
			const result = handleSettingsAction("reload", live, {
				clearLastWarned: () => cleared++,
				reportProblems: () => reported++,
				clearWindowLookups: () => windowsCleared++,
			});
			expect(result).toContain("Reloaded");
			expect(reported).toBe(0);
			expect(cleared).toBe(1);
			expect(windowsCleared).toBe(1);
			expect(live.options.warnPercent).toBe(0.9);
		});
	});

	test("reload with a bad file reports problems via the callback without throwing", () => {
		withConfig("{ not json !!", (configPath) => {
			const live = new LiveConfig(configPath, loadOptions(configPath).options);
			let reported: unknown[] = [];
			const result = handleSettingsAction("reload", live, {
				clearLastWarned: () => {},
				reportProblems: (problems) => {
					reported = problems;
				},
			});
			expect(result).toContain("Reloaded");
			expect(reported.length).toBeGreaterThan(0);
		});
	});
});
