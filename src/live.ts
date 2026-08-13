import type { ConfigProblem, ContextWatchOptions } from "./config";
import { loadOptions } from "./config";

/**
 * Live module — the live mutable plugin state behind the
 * `context_watch_settings` tool.
 *
 * Both backends read the resolved options from a closure object on every
 * event (`assess(opts, …)`, `renderMessage(opts.message, …)`,
 * `opts.postCompactContinue`, `opts.windowTokens`) and `Notifier` reads its
 * opts per call, so mutating the SAME object in place makes a reload effective
 * immediately with zero re-registration. `enabled` is a runtime-only gate:
 * it is NOT a config key and reload never touches it.
 */
export class LiveConfig {
	/** The SAME object identity the hooks read per event. reload() mutates it in place. */
	readonly options: Required<ContextWatchOptions>;
	/** Runtime-only gate; survives reload, resets on restart. NOT a config key. */
	enabled = true;
	/** Passed to the Notifier by reference so reload updates toast/verbose live. */
	readonly notifyFlags: LiveNotifyFlags;

	constructor(
		private readonly configPath: string,
		initial: Required<ContextWatchOptions>,
	) {
		this.options = initial;
		this.notifyFlags = {
			toastEnabled: initial.toast,
			verbose: initial.verbose,
		};
	}

	/**
	 * Re-read the config file + env overrides and apply them live: the
	 * returned options are copied INTO `this.options` (the object every hook
	 * already reads) and `notifyFlags` is updated for the Notifier. Problems
	 * are returned to the caller, which reports them — never thrown.
	 */
	reload(): {
		options: Required<ContextWatchOptions>;
		problems: ConfigProblem[];
	} {
		const { options, problems } = loadOptions(this.configPath);
		Object.assign(this.options, options);
		this.notifyFlags.toastEnabled = options.toast;
		this.notifyFlags.verbose = options.verbose;
		return { options, problems };
	}

	setEnabled(v: boolean): void {
		this.enabled = v;
	}

	/** Human-readable settings summary for the tool's `status` action. */
	statusText(): string {
		return [
			"context-watch settings:",
			`enabled=${this.enabled}`,
			`warnPercent=${Math.round(this.options.warnPercent * 100)}%`,
			`warnTokens=${this.options.warnTokens.toLocaleString()}`,
			`windowTokens=${this.options.windowTokens?.toLocaleString() ?? "auto"}`,
			`rearmPercent=${this.options.rearmPercent}%`,
			`rearmTokens=${this.options.rearmTokens.toLocaleString()}`,
			`toast=${this.options.toast ? "on" : "off"}`,
			`verbose=${this.options.verbose ? "on" : "off"}`,
			`config=${this.configPath}`,
		].join(" | ");
	}
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
		case "disable":
			live.setEnabled(false);
			return "Warning injection disabled";
		case "enable":
			live.setEnabled(true);
			return "Warning injection enabled";
		case "status":
			return live.statusText();
		default:
			return "context_watch_settings: unknown action. Actions: reload (re-read the config file + env overrides), disable (stop warning injection until re-enabled), enable (resume warning injection), status (show current settings).";
	}
}
