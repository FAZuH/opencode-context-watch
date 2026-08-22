import { describe, expect, test } from "bun:test";
import type {
	TuiCommand,
	TuiPluginApi,
	TuiToast,
} from "@opencode-ai/plugin/tui";
import tuiPlugin, { type TuiCommandDeps, buildTuiCommands } from "../src/tui";

function fakeDeps(overrides: Partial<TuiCommandDeps> = {}): {
	deps: TuiCommandDeps;
	toasts: TuiToast[];
	updates: Record<string, unknown>[];
} {
	const toasts: TuiToast[] = [];
	const updates: Record<string, unknown>[] = [];
	const deps: TuiCommandDeps = {
		configPath: "/tmp/config/opencode-context-watch.json",
		configExists: () => true,
		readConfig: () => ({ raw: {}, problems: [] }),
		updateConfigFile: (updatesArg) => {
			updates.push(updatesArg);
			return [];
		},
		env: () => ({}),
		toast: (input) => {
			toasts.push(input);
		},
		...overrides,
	};
	return { deps, toasts, updates };
}

function commandNamed(commands: TuiCommand[], value: string): TuiCommand {
	const cmd = commands.find((c) => c.value === value);
	if (!cmd) throw new Error(`command ${value} missing`);
	return cmd;
}

describe("buildTuiCommands", () => {
	test("returns four commands with the expected titles, values, and slashes", () => {
		const { deps } = fakeDeps();
		const commands = buildTuiCommands(deps);
		expect(commands).toHaveLength(4);
		expect(commands.map((c) => c.value)).toEqual([
			"context-watch.status",
			"context-watch.reload",
			"context-watch.disable",
			"context-watch.enable",
		]);
		expect(commands.map((c) => c.title)).toEqual([
			"Context-watch: status",
			"Context-watch: reload config",
			"Context-watch: disable warning",
			"Context-watch: enable warning",
		]);
		expect(commands.map((c) => c.slash?.name)).toEqual([
			"context-watch-status",
			"context-watch-reload",
			"context-watch-disable",
			"context-watch-enable",
		]);
	});

	test("status toasts a settings summary built from the read config", () => {
		const { deps, toasts } = fakeDeps({
			configPath: "/tmp/conf.json",
			readConfig: () => ({
				raw: { warnPercent: 50, warnTokens: 100_000 },
				problems: [],
			}),
		});
		const status = commandNamed(buildTuiCommands(deps), "context-watch.status");
		status.onSelect?.();
		expect(toasts).toHaveLength(1);
		expect(toasts[0].message).toContain("enabled=true");
		expect(toasts[0].message).toContain("warnPercent=50%");
		expect(toasts[0].message).toContain("/tmp/conf.json");
	});

	test("status applies CONTEXT_WATCH_* env overrides to the displayed settings", () => {
		const { deps, toasts } = fakeDeps({
			readConfig: () => ({
				raw: { warnPercent: 50 },
				problems: [],
			}),
			env: () => ({ CONTEXT_WATCH_TOKENS: "42" }),
		});
		const status = commandNamed(buildTuiCommands(deps), "context-watch.status");
		status.onSelect?.();
		expect(toasts[0].message).toContain("warnTokens=42");
	});

	test("reload writes the same content back (touch) to trigger the server watcher", () => {
		const { deps, updates, toasts } = fakeDeps({
			readConfig: () => ({
				raw: { warnPercent: 50, message: "hi" },
				problems: [],
			}),
		});
		const reload = commandNamed(buildTuiCommands(deps), "context-watch.reload");
		reload.onSelect?.();
		expect(updates).toEqual([{ warnPercent: 50, message: "hi" }]);
		expect(toasts[0].variant).toBe("success");
		expect(toasts[0].message).toContain("reloaded");
	});

	test("reload without a config file reports info and creates nothing", () => {
		const { deps, updates, toasts } = fakeDeps({
			configExists: () => false,
		});
		const reload = commandNamed(buildTuiCommands(deps), "context-watch.reload");
		reload.onSelect?.();
		expect(updates).toEqual([]);
		expect(toasts[0].variant).toBe("info");
		expect(toasts[0].message).toContain("no config file to reload");
	});

	test("disable writes { enabled: false }; enable writes { enabled: true }", () => {
		const { deps, updates, toasts } = fakeDeps();
		const disable = commandNamed(
			buildTuiCommands(deps),
			"context-watch.disable",
		);
		disable.onSelect?.();
		expect(updates).toEqual([{ enabled: false }]);
		expect(toasts[0].message).toContain("disabled");
		expect(toasts[0].variant).toBe("success");

		const enable = commandNamed(buildTuiCommands(deps), "context-watch.enable");
		enable.onSelect?.();
		expect(updates).toEqual([{ enabled: false }, { enabled: true }]);
		expect(toasts[1].message).toContain("enabled");
		expect(toasts[1].variant).toBe("success");
	});

	test("a failing updateConfigFile reports an error toast and never throws", () => {
		const { deps, toasts } = fakeDeps({
			updateConfigFile: () => [
				{
					key: "file",
					message: "/tmp/conf.json parent directory does not exist",
				},
			],
		});
		const disable = commandNamed(
			buildTuiCommands(deps),
			"context-watch.disable",
		);
		expect(() => disable.onSelect?.()).not.toThrow();
		expect(toasts).toHaveLength(1);
		expect(toasts[0].variant).toBe("error");
		expect(toasts[0].message).toContain("parent directory does not exist");
	});

	test("a throwing read reports an error toast and never throws", () => {
		const { deps, toasts } = fakeDeps({
			readConfig: () => {
				throw new Error("boom");
			},
		});
		const status = commandNamed(buildTuiCommands(deps), "context-watch.status");
		expect(() => status.onSelect?.()).not.toThrow();
		expect(toasts).toHaveLength(1);
		expect(toasts[0].variant).toBe("error");
		expect(toasts[0].message).toContain("boom");
	});
});

describe("tui plugin entry", () => {
	test("exports the expected plugin id and a tui factory", async () => {
		expect(tuiPlugin).toMatchObject({ id: "opencode-context-watch" });
		expect(typeof tuiPlugin.tui).toBe("function");
	});

	test("registers the four commands via api.command when present", async () => {
		let registered: TuiCommand[] = [];
		const api = {
			command: {
				register: (cb: () => TuiCommand[]) => {
					registered = cb();
					return () => {};
				},
			},
		};
		await tuiPlugin.tui(api as unknown as TuiPluginApi);
		expect(registered.map((c) => c.value)).toEqual([
			"context-watch.status",
			"context-watch.reload",
			"context-watch.disable",
			"context-watch.enable",
		]);
	});

	test("does nothing when api.command is absent", async () => {
		const api = {} as TuiPluginApi;
		await expect(tuiPlugin.tui(api)).resolves.toBeUndefined();
	});
});
