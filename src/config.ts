import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Config module — the plugin's configuration domain.
 *
 * Resolves the plugin options from the config file and environment overrides
 * with per-key fallback to defaults. Pure and side-effect free apart from
 * `loadOptions`, which owns the filesystem read.
 */

export interface ContextWatchOptions {
	warnPercent?: number;
	warnTokens?: number;
	windowTokens?: number | null;
	rearmPercent?: number;
	rearmTokens?: number;
	toast?: boolean;
	verbose?: boolean;
	message?: string;
	postCompactContinue?: boolean;
	postCompactMsg?: string;
}

export interface ConfigProblem {
	key: string;
	message: string;
}

export const CONFIG_PATH = join(
	homedir(),
	".config/opencode/opencode-context-watch.json",
);

const DEFAULTS = {
	warnPercent: 0.77,
	warnTokens: 150_000,
	windowTokens: null as number | null,
	rearmPercent: 5,
	rearmTokens: 5_000,
	toast: true,
	verbose: false,
	message:
		"[context-watch] Context window usage is at {percent}% ({tokens}/{window} tokens). The session is getting full: wrap up the current step soon, keep replies concise, avoid re-reading large files, and be ready to prepare for compaction if you continue.",
	postCompactContinue: false,
	postCompactMsg:
		"[context-watch] Session context was compacted. Continue your work from where you left off, keeping replies concise.",
};

const CONFIG_KEYS = new Set([
	"warnPercent",
	"warnTokens",
	"windowTokens",
	"rearmPercent",
	"rearmTokens",
	"toast",
	"verbose",
	"message",
	"postCompactContinue",
	"postCompactMsg",
]);

/**
 * Pure config resolution: given the parsed config file contents and an env
 * map, validate every option and fall back to the default for each bad value.
 * Returns the resolved options plus a list of problems describing what was
 * wrong. No filesystem, no `process.env` — both are injected by callers.
 */
export function resolveOptions(
	raw: unknown,
	env: Record<string, string | undefined>,
): { options: Required<ContextWatchOptions>; problems: ConfigProblem[] } {
	// opencode's bootstrap plugin-load pass may call this with `env === undefined`.
	const envMap = env ?? {};
	const problems: ConfigProblem[] = [];

	let conf: Record<string, unknown>;
	if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
		conf = raw as Record<string, unknown>;
	} else {
		problems.push({
			key: "file",
			message: "config root must be a JSON object",
		});
		conf = {};
	}

	for (const key of Object.keys(conf)) {
		if (!CONFIG_KEYS.has(key)) {
			problems.push({ key, message: `unknown option "${key}" (ignored)` });
		}
	}

	const num = (
		envName: string,
		fileKey: string,
		fallback: number,
		expected: string,
		test: (n: number) => boolean,
	): number => {
		const envValue = envMap[envName];
		if (envValue !== undefined) {
			const n = Number(envValue);
			if (Number.isFinite(n) && test(n)) return n;
			problems.push({
				key: fileKey,
				message: `${envName} must be ${expected} (got ${JSON.stringify(envValue)}); falling back to config/default`,
			});
		}
		const value = conf[fileKey];
		if (value !== undefined) {
			const n = Number(value);
			if (Number.isFinite(n) && test(n)) return n;
			problems.push({
				key: fileKey,
				message: `${fileKey} must be ${expected} (got ${JSON.stringify(value)})`,
			});
		}
		return fallback;
	};

	const warnPercent = num(
		"CONTEXT_WATCH_PERCENT",
		"warnPercent",
		DEFAULTS.warnPercent,
		"a number greater than 0 and at most 100",
		(n) => n > 0 && n <= 100,
	);

	const warnTokens = num(
		"CONTEXT_WATCH_TOKENS",
		"warnTokens",
		DEFAULTS.warnTokens,
		"a positive number",
		(n) => n > 0,
	);

	const windowTokens = (() => {
		const envValue = envMap.CONTEXT_WATCH_WINDOW;
		if (envValue !== undefined) {
			const n = Number(envValue);
			if (Number.isFinite(n) && n > 0) return n;
			problems.push({
				key: "windowTokens",
				message: `CONTEXT_WATCH_WINDOW must be a positive number or null (got ${JSON.stringify(envValue)}); falling back to config/default`,
			});
		}
		const value = conf.windowTokens;
		if (value === null) return null;
		if (value !== undefined) {
			const n = Number(value);
			if (Number.isFinite(n) && n > 0) return n;
			problems.push({
				key: "windowTokens",
				message: `windowTokens must be a positive number or null (got ${JSON.stringify(value)})`,
			});
		}
		return DEFAULTS.windowTokens;
	})();

	const rearmPercent = num(
		"CONTEXT_WATCH_REARM",
		"rearmPercent",
		DEFAULTS.rearmPercent,
		"a positive number",
		(n) => n > 0,
	);

	const rearmTokens = num(
		"CONTEXT_WATCH_REARM_TOKENS",
		"rearmTokens",
		DEFAULTS.rearmTokens,
		"a positive number",
		(n) => n > 0,
	);

	const bool = (fileKey: string, fallback: boolean): boolean => {
		const value = conf[fileKey];
		if (value !== undefined) {
			if (typeof value === "boolean") return value;
			problems.push({
				key: fileKey,
				message: `${fileKey} must be a boolean (got ${JSON.stringify(value)})`,
			});
		}
		return fallback;
	};

	let message = DEFAULTS.message;
	if (envMap.CONTEXT_WATCH_MESSAGE !== undefined) {
		message = envMap.CONTEXT_WATCH_MESSAGE;
	} else {
		const value = conf.message;
		if (value !== undefined) {
			if (typeof value === "string" && value.trim().length > 0) {
				message = value;
			} else {
				problems.push({
					key: "message",
					message: `message must be a non-empty string (got ${JSON.stringify(value)})`,
				});
			}
		}
	}

	const postCompactContinue = (() => {
		const envValue = envMap.CONTEXT_WATCH_POST_COMPACT_CONTINUE;
		if (envValue !== undefined) {
			if (envValue === "true") return true;
			if (envValue === "false") return false;
			const n = Number(envValue);
			if (Number.isFinite(n)) return n !== 0;
			problems.push({
				key: "postCompactContinue",
				message: `CONTEXT_WATCH_POST_COMPACT_CONTINUE must be a boolean (got ${JSON.stringify(envValue)}); falling back to config/default`,
			});
		}
		return bool("postCompactContinue", DEFAULTS.postCompactContinue);
	})();

	let postCompactMsg = DEFAULTS.postCompactMsg;
	if (envMap.CONTEXT_WATCH_POST_COMPACT_MSG !== undefined) {
		postCompactMsg = envMap.CONTEXT_WATCH_POST_COMPACT_MSG;
	} else {
		const value = conf.postCompactMsg;
		if (value !== undefined) {
			if (typeof value === "string" && value.trim().length > 0) {
				postCompactMsg = value;
			} else {
				problems.push({
					key: "postCompactMsg",
					message: `postCompactMsg must be a non-empty string (got ${JSON.stringify(value)})`,
				});
			}
		}
	}

	return {
		options: {
			warnPercent: warnPercent > 1 ? warnPercent / 100 : warnPercent,
			warnTokens,
			windowTokens,
			rearmPercent,
			rearmTokens,
			toast: envMap.CONTEXT_WATCH_NO_TOAST
				? false
				: bool("toast", DEFAULTS.toast),
			verbose: bool("verbose", DEFAULTS.verbose),
			message,
			postCompactContinue,
			postCompactMsg,
		},
		problems,
	};
}

export function loadOptions(configPath: string = CONFIG_PATH): {
	options: Required<ContextWatchOptions>;
	problems: ConfigProblem[];
} {
	const problems: ConfigProblem[] = [];
	let raw: unknown = {};
	try {
		if (existsSync(configPath)) {
			raw = JSON.parse(readFileSync(configPath, "utf8"));
		}
	} catch (err) {
		problems.push({
			key: "file",
			message: `${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		});
	}
	const { options, problems: resolvedProblems } = resolveOptions(
		raw,
		process.env,
	);
	return { options, problems: [...problems, ...resolvedProblems] };
}
