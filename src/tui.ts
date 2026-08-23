import { existsSync } from "node:fs";
import type {
	TuiCommand,
	TuiPluginApi,
	TuiToast,
} from "@opencode-ai/plugin/tui";
import type { ConfigProblem } from "./config";
import {
	CONFIG_PATH,
	readConfigFile,
	resolveOptions,
	updateConfigFile,
} from "./config";
import { settingsSummary } from "./live";

/**
 * TUI module — the command-palette surface for live settings, registered as a
 * SEPARATE plugin entry (`src/tui.ts`) because the opencode v1 loader rejects a
 * module that default-exports both `server` and `tui`.
 *
 * The default export carries BOTH host contracts on one object: v1 (1.18.x)
 * validates and calls `tui(api)` (unknown keys ignored), while the opencode2
 * beta TUI host validates `{ id, setup }` and calls `setup(ctx)` — so each
 * runtime uses its own function and tolerates the other's key.
 *
 * The commands write the plugin config file directly (read-modify-write,
 * atomic rename) and the server-side `fs.watch` on that file re-applies the
 * changes live — no direct coupling between the TUI process and the server
 * backend. The file is the bridge.
 */

/**
 * The filesystem + toast surface the command builders need. Injected so the
 * command builders are pure and unit-testable; both entries wire the real
 * config file and their host's toast API (`TuiToast` and the beta's
 * `ToastOptions` are structurally identical).
 */
export interface TuiCommandDeps {
	/** The config file path, shown in the status summary. */
	configPath: string;
	/** Whether the config file exists (reload must not create one). */
	configExists: () => boolean;
	/** Read the config file as a plain object ({ raw, problems }). */
	readConfig: () => { raw: Record<string, unknown>; problems: ConfigProblem[] };
	/** Merge `updates` into the config file; returns problems, never throws. */
	updateConfigFile: (updates: Record<string, unknown>) => ConfigProblem[];
	/**
	 * The effective environment for resolving displayed settings — the same
	 * CONTEXT_WATCH_* overrides the server-side backends honor.
	 */
	env: () => Record<string, string | undefined>;
	/** Surface a message to the user. */
	toast: (input: TuiToast) => void;
}

/**
 * The four command bodies shared by both hosts' registrations. Each is
 * try/catch-wrapped so invoking it can never throw (a failure surfaces as an
 * error toast).
 */
export interface TuiHandlers {
	status(): void;
	reload(): void;
	disable(): void;
	enable(): void;
}

/** Toast an error message and swallow the failure — handlers must never throw. */
function toastError(
	toast: (input: TuiToast) => void,
	label: string,
	err: unknown,
): void {
	toast({
		variant: "error",
		message: `${label}: ${err instanceof Error ? err.message : String(err)}`,
	});
}

/**
 * Build the four context-watch handler bodies. `status` reads the file and
 * summarizes it with the effective env applied; `reload` touches the file
 * with its current contents so the server watcher re-applies them live — and
 * reports instead of creating a file when none exists; `disable`/`enable`
 * persist the `enabled` key.
 */
export function buildTuiHandlers(deps: TuiCommandDeps): TuiHandlers {
	return {
		status: () => {
			try {
				const { raw, problems } = deps.readConfig();
				const { options } = resolveOptions(raw, deps.env());
				const summary = settingsSummary(
					options,
					options.enabled,
					deps.configPath,
				);
				deps.toast({
					variant: problems.length > 0 ? "warning" : "info",
					message: summary,
				});
			} catch (err) {
				toastError(deps.toast, "context-watch status failed", err);
			}
		},
		reload: () => {
			try {
				if (!deps.configExists()) {
					deps.toast({
						variant: "info",
						message: "Context-watch: no config file to reload",
					});
					return;
				}
				// Touch: write the current contents back so the atomic rename
				// bumps the inode and the server watcher re-applies them live.
				const { raw } = deps.readConfig();
				const problems = deps.updateConfigFile(raw);
				if (problems.length > 0) {
					toastError(deps.toast, "reload failed", problems[0].message);
				} else {
					deps.toast({
						variant: "success",
						message: "Context-watch config reloaded",
					});
				}
			} catch (err) {
				toastError(deps.toast, "reload failed", err);
			}
		},
		disable: () => {
			try {
				const problems = deps.updateConfigFile({ enabled: false });
				if (problems.length > 0) {
					toastError(deps.toast, "disable failed", problems[0].message);
				} else {
					deps.toast({
						variant: "success",
						message: "Context-watch warning injection disabled",
					});
				}
			} catch (err) {
				toastError(deps.toast, "disable failed", err);
			}
		},
		enable: () => {
			try {
				const problems = deps.updateConfigFile({ enabled: true });
				if (problems.length > 0) {
					toastError(deps.toast, "enable failed", problems[0].message);
				} else {
					deps.toast({
						variant: "success",
						message: "Context-watch warning injection enabled",
					});
				}
			} catch (err) {
				toastError(deps.toast, "enable failed", err);
			}
		},
	};
}

/**
 * Build the four context-watch commands. Each `onSelect` runs its body inside
 * try/catch so selecting a command can never throw (a failure surfaces as an
 * error toast).
 */
export function buildTuiCommands(deps: TuiCommandDeps): TuiCommand[] {
	const handlers = buildTuiHandlers(deps);
	const status: TuiCommand = {
		title: "Context-watch: status",
		value: "context-watch.status",
		description: "Show the current context-watch settings and config path",
		slash: { name: "context-watch-status" },
		onSelect: handlers.status,
	};

	const reload: TuiCommand = {
		title: "Context-watch: reload config",
		value: "context-watch.reload",
		description: "Re-apply the config file to the running session",
		slash: { name: "context-watch-reload" },
		onSelect: handlers.reload,
	};

	const disable: TuiCommand = {
		title: "Context-watch: disable warning",
		value: "context-watch.disable",
		description: "Persistently disable context-watch warning injection",
		slash: { name: "context-watch-disable" },
		onSelect: handlers.disable,
	};

	const enable: TuiCommand = {
		title: "Context-watch: enable warning",
		value: "context-watch.enable",
		description: "Persistently enable context-watch warning injection",
		slash: { name: "context-watch-enable" },
		onSelect: handlers.enable,
	};

	return [status, reload, disable, enable];
}

/**
 * Structural subset of the opencode2 beta TUI plugin context (verified
 * against the beta-17898 sources): the keymap layer registration and the
 * toast surface are all `setup` consumes. Types only — never imported at
 * runtime.
 */
export interface V2KeymapCommand {
	readonly id?: string;
	readonly title?: string;
	readonly description?: string;
	readonly group?: string;
	readonly enabled?: boolean | (() => boolean);
	readonly bind?: false | string;
	readonly palette?: true;
	readonly slash?: {
		readonly name: string;
		readonly aliases?: string[];
		readonly arguments?: true;
	};
	readonly suggested?: boolean | (() => boolean);
	readonly run: (input?: string, event?: unknown) => void | false | Promise<void>;
}

/** One keymap layer: `"global"` mode reaches every input mode. */
export interface V2KeymapLayer {
	readonly mode?: string;
	readonly commands?: readonly V2KeymapCommand[];
}

/** The beta toast options — structurally identical to v1's `TuiToast`. */
export interface V2ToastOptions {
	readonly title?: string;
	readonly message: string;
	readonly variant?: "info" | "success" | "warning" | "error";
	readonly duration?: number;
}

/** The beta TUI plugin context pieces `setup` touches. */
export interface V2TuiPluginContext {
	keymap: { layer(input: () => V2KeymapLayer): void };
	ui: {
		toast: { show(options: V2ToastOptions): void };
		/**
		 * Claims a slot boundary (plain data, safe from async setup); the
		 * returned unregister is owned by the host and unwinds on dispose.
		 */
		slot(claim: {
			readonly append: string;
			readonly render: (input: unknown) => undefined;
		}): () => void;
	};
}

/**
 * The four commands as ONE beta keymap layer: palette-visible, unbound
 * (`bind: false`), reachable in every input mode, grouped under
 * "Context-watch".
 */
export function buildV2KeymapCommands(deps: TuiCommandDeps): V2KeymapCommand[] {
	const handlers = buildTuiHandlers(deps);
	return [
		{
			id: "context_watch.status",
			title: "Context-watch: status",
			description: "Show the current context-watch settings and config path",
			group: "Context-watch",
			palette: true,
			bind: false,
			slash: { name: "context-watch-status" },
			run: () => handlers.status(),
		},
		{
			id: "context_watch.reload",
			title: "Context-watch: reload config",
			description: "Re-apply the config file to the running session",
			group: "Context-watch",
			palette: true,
			bind: false,
			slash: { name: "context-watch-reload" },
			run: () => handlers.reload(),
		},
		{
			id: "context_watch.disable",
			title: "Context-watch: disable warning",
			description: "Persistently disable context-watch warning injection",
			group: "Context-watch",
			palette: true,
			bind: false,
			slash: { name: "context-watch-disable-warning" },
			run: () => handlers.disable(),
		},
		{
			id: "context_watch.enable",
			title: "Context-watch: enable warning",
			description: "Persistently enable context-watch warning injection",
			group: "Context-watch",
			palette: true,
			bind: false,
			slash: { name: "context-watch-enable-warning" },
			run: () => handlers.enable(),
		},
	];
}

/**
 * The TUI plugin entry. Registered in `tui.json` as a file path
 * (`/home/fazuh/Projects/opencode-context-watch/src/tui.ts`) — separate from
 * the server entry in `src/index.ts` because the loader rejects dual exports.
 */
export default {
	id: "opencode-context-watch",
	tui: async (api: TuiPluginApi): Promise<void> => {
		const deps: TuiCommandDeps = {
			configPath: CONFIG_PATH,
			configExists: () => existsSync(CONFIG_PATH),
			readConfig: () => readConfigFile(CONFIG_PATH),
			updateConfigFile: (updates) => updateConfigFile(CONFIG_PATH, updates),
			env: () => process.env,
			toast: (input) => api.ui.toast(input),
		};
		api.command?.register(() => buildTuiCommands(deps));
	},
	setup: (ctx: Partial<V2TuiPluginContext>, injectedDeps?: TuiCommandDeps) => {
		// Capture the checked pieces as consts: parameter narrowing does not
		// flow into the closures below.
		const layer = ctx?.keymap?.layer;
		const showToast = ctx?.ui?.toast?.show;
		const slot = ctx?.ui?.slot;
		if (!layer || !showToast || !slot) return;
		const deps: TuiCommandDeps =
			injectedDeps ??
			{
				configPath: CONFIG_PATH,
				configExists: () => existsSync(CONFIG_PATH),
				readConfig: () => readConfigFile(CONFIG_PATH),
				updateConfigFile: (updates) => updateConfigFile(CONFIG_PATH, updates),
				env: () => process.env,
				toast: (input) => showToast(input),
			};
		// Activation runs as a plain async function OUTSIDE the app's provider
		// tree, where a direct keymap.layer call throws (`Keymap.Provider is
		// missing`). The canonical pattern is an invisible slot instead: the
		// claim is plain data registered synchronously, and its render runs
		// inside the app's Solid tree where the provider exists. The guard
		// keeps a reactive re-render from stacking duplicate layers; both the
		// claim and the scoped layer unwind on deactivation.
		let registered = false;
		slot({
			append: "app",
			render: () => {
				if (!registered) {
					registered = true;
					layer(() => ({
						mode: "global",
						commands: buildV2KeymapCommands(deps),
					}));
				}
				return undefined;
			},
		});
	},
};
