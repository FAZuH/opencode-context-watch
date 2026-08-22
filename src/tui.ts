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
 * The commands write the plugin config file directly (read-modify-write,
 * atomic rename) and the server-side `fs.watch` on that file re-applies the
 * changes live — no direct coupling between the TUI process and the server
 * backend. The file is the bridge.
 */

/**
 * The filesystem + toast surface `buildTuiCommands` needs. Injected so the
 * command builders are pure and unit-testable; the default export wires the
 * real config file and `api.ui.toast`.
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

/** Toast an error message and swallow the failure — onSelect must never throw. */
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
 * Build the four context-watch commands. Each `onSelect` runs its body inside
 * try/catch so selecting a command can never throw (a failure surfaces as an
 * error toast). `status` reads the file and summarizes it with the effective
 * env applied; `reload` touches the file with its current contents so the
 * server watcher re-applies them live — and reports instead of creating a
 * file when none exists; `disable`/`enable` persist the `enabled` key.
 */
export function buildTuiCommands(deps: TuiCommandDeps): TuiCommand[] {
	const status: TuiCommand = {
		title: "Context-watch: status",
		value: "context-watch.status",
		description: "Show the current context-watch settings and config path",
		slash: { name: "context-watch-status" },
		onSelect: () => {
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
	};

	const reload: TuiCommand = {
		title: "Context-watch: reload config",
		value: "context-watch.reload",
		description: "Re-apply the config file to the running session",
		slash: { name: "context-watch-reload" },
		onSelect: () => {
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
	};

	const disable: TuiCommand = {
		title: "Context-watch: disable warning",
		value: "context-watch.disable",
		description: "Persistently disable context-watch warning injection",
		slash: { name: "context-watch-disable" },
		onSelect: () => {
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
	};

	const enable: TuiCommand = {
		title: "Context-watch: enable warning",
		value: "context-watch.enable",
		description: "Persistently enable context-watch warning injection",
		slash: { name: "context-watch-enable" },
		onSelect: () => {
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

	return [status, reload, disable, enable];
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
};
