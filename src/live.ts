import type { ConfigProblem, ContextWatchOptions } from "./config";
import { loadOptions, updateConfigFile } from "./config";

/**
 * Live module — the live mutable plugin state behind the
 * `context_watch_settings` tool and the TUI commands.
 *
 * Both backends read the resolved options from a closure object on every
 * event (`assess(opts, …)`, `renderMessage(opts.message, …)`,
 * `opts.postCompactContinue`, `opts.windowTokens`) and `Notifier` reads its
 * opts per call, so mutating the SAME object in place makes a reload effective
 * immediately with zero re-registration. `enabled` is a real config key: it
 * initializes from the resolved options, reload re-applies the file value, and
 * the settings tool's disable/enable actions persist it via
 * `persistEnabled`.
 */
export class LiveConfig {
	/** The SAME object identity the hooks read per event. reload() mutates it in place. */
	readonly options: Required<ContextWatchOptions>;
	/** Warning-injection gate; a real config key, persisted by disable/enable. */
	enabled: boolean;
	/** Passed to the Notifier by reference so reload updates toast/verbose live. */
	readonly notifyFlags: LiveNotifyFlags;

	constructor(
		private readonly configPath: string,
		initial: Required<ContextWatchOptions>,
		/** Extra raw options layered over the file on every load/reload (v2 `ctx.options`). */
		private readonly overlay?: unknown,
	) {
		this.options = initial;
		this.enabled = initial.enabled;
		this.notifyFlags = {
			toastEnabled: initial.toast,
			verbose: initial.verbose,
		};
	}

	/**
	 * Re-read the config file + env overrides and apply them live: the
	 * returned options are copied INTO `this.options` (the object every hook
	 * already reads), `notifyFlags` is updated for the Notifier, and `enabled`
	 * re-applies the resolved file value. Problems are returned to the caller,
	 * which reports them — never thrown.
	 */
	reload(): {
		options: Required<ContextWatchOptions>;
		problems: ConfigProblem[];
	} {
		const { options, problems } = loadOptions(this.configPath, this.overlay);
		Object.assign(this.options, options);
		this.notifyFlags.toastEnabled = options.toast;
		this.notifyFlags.verbose = options.verbose;
		this.enabled = options.enabled;
		return { options, problems };
	}

	setEnabled(v: boolean): void {
		this.enabled = v;
	}

	/**
	 * Persist the gate to the config file, then apply it in memory. Returns
	 * any write problems (never throws); the in-memory gate is set regardless
	 * so the user's intent takes effect even when the file write fails.
	 */
	persistEnabled(v: boolean): ConfigProblem[] {
		const problems = updateConfigFile(this.configPath, { enabled: v });
		this.enabled = v;
		return problems;
	}

	/** Human-readable settings summary for the tool's `status` action. */
	statusText(): string {
		return settingsSummary(this.options, this.enabled, this.configPath);
	}
}

/**
 * Pure settings summary shared by the tool's `status` action and the TUI
 * status command: thresholds, flags, the gate, and the config path.
 */
export function settingsSummary(
	options: Required<ContextWatchOptions>,
	enabled: boolean,
	configPath: string,
): string {
	return [
		"context-watch settings:",
		`enabled=${enabled}`,
		`warnPercent=${Math.round(options.warnPercent * 100)}%`,
		`warnTokens=${options.warnTokens.toLocaleString()}`,
		`windowTokens=${options.windowTokens?.toLocaleString() ?? "auto"}`,
		`rearmPercent=${options.rearmPercent}%`,
		`rearmTokens=${options.rearmTokens.toLocaleString()}`,
		`toast=${options.toast ? "on" : "off"}`,
		`verbose=${options.verbose ? "on" : "off"}`,
		`config=${configPath}`,
	].join(" | ");
}

/** The `{ toastEnabled, verbose }` flags the Notifier reads per call. */
export interface LiveNotifyFlags {
	toastEnabled: boolean;
	verbose: boolean;
}

export type SettingsAction = "reload" | "disable" | "enable" | "status";

/** The settings-tool description, shared by both backends' registrations. */
export const SETTINGS_TOOL_DESCRIPTION =
	"Reload the context-watch config or control warning injection without restarting opencode. Actions: reload, disable, enable, status.";

/** The app-log label for reload-time config problems (v1 + v2). */
export const RELOAD_PROBLEM_LABEL = "invalid config (reload)";

/**
 * The shared settings-tool execute handler — both backends call this. Never
 * throws: every path returns a human-readable result string, and problems are
 * reported through the injected hooks instead of raised.
 */
export function handleSettingsAction(
	action: unknown,
	live: LiveConfig,
	hooks: {
		/** Clear per-session rearm state so new thresholds fire immediately. */
		clearLastWarned: () => void;
		/** Report reload problems (v1: alwaysLog + error toast; v2: alwaysLog only). */
		reportProblems: (problems: ConfigProblem[]) => void;
		/** v2-only: clear cached window lookups so a windowTokens null<->N change re-resolves. */
		clearWindowLookups?: () => void;
	},
): string {
	switch (action) {
		case "reload": {
			const { options, problems } = live.reload();
			if (problems.length > 0) hooks.reportProblems(problems);
			hooks.clearLastWarned();
			hooks.clearWindowLookups?.();
			const applied = Object.keys(options).length;
			return problems.length > 0
				? `Reloaded config: ${applied} options applied, ${problems.length} problem(s) reported`
				: `Reloaded config: ${applied} options applied`;
		}
		case "disable": {
			const problems = live.persistEnabled(false);
			if (problems.length > 0) hooks.reportProblems(problems);
			return "Warning injection disabled";
		}
		case "enable": {
			const problems = live.persistEnabled(true);
			if (problems.length > 0) hooks.reportProblems(problems);
			return "Warning injection enabled";
		}
		case "status":
			return live.statusText();
		default:
			return "context_watch_settings: unknown action. Actions: reload (re-read the config file + env overrides), disable (stop warning injection until re-enabled), enable (resume warning injection), status (show current settings).";
	}
}
