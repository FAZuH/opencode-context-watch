import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Config module — the plugin's configuration domain.
 *
 * Resolves the plugin options from the config file and environment overrides
 * with per-key fallback to defaults. Pure apart from the filesystem helpers:
 * `loadOptions` owns the read, `readConfigFile`/`updateConfigFile` own the
 * TUI-side read-modify-write of the config file.
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
	/** Whether warning injection is on; a real config key persisted by the TUI commands. */
	enabled?: boolean;
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
	enabled: true,
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
	"enabled",
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
			enabled: bool("enabled", DEFAULTS.enabled),
			message,
			postCompactContinue,
			postCompactMsg,
		},
		problems,
	};
}

/**
 * Read the config file (+ env overrides) and resolve the options. An
 * optional `overlay` (a plain object) is merged OVER the file's raw values
 * per key, so the per-key precedence becomes env > overlay > file > default
 * — the v2 backend uses this to layer `ctx.options` (the opencode.json
 * plugins-entry options) over its own config file. A non-object overlay is
 * ignored. Overlay keys are validated like file keys (unknown/bad values are
 * reported as problems).
 */
export function loadOptions(
	configPath: string = CONFIG_PATH,
	overlay?: unknown,
): {
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
	if (
		typeof overlay === "object" &&
		overlay !== null &&
		!Array.isArray(overlay)
	) {
		const fileObject =
			typeof raw === "object" && raw !== null && !Array.isArray(raw);
		if (fileObject) {
			raw = { ...(raw as Record<string, unknown>), ...overlay };
		}
	}
	const { options, problems: resolvedProblems } = resolveOptions(
		raw,
		process.env,
	);
	return { options, problems: [...problems, ...resolvedProblems] };
}

/**
 * Read the config file as a plain object. Missing file → `{}` with no
 * problems; a non-object root or invalid JSON → `{}` plus a `{ key: "file" }`
 * problem. Never throws.
 */
export function readConfigFile(configPath: string): {
	raw: Record<string, unknown>;
	problems: ConfigProblem[];
} {
	if (!existsSync(configPath)) return { raw: {}, problems: [] };
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			return { raw: parsed as Record<string, unknown>, problems: [] };
		}
		return {
			raw: {},
			problems: [{ key: "file", message: "config root must be a JSON object" }],
		};
	} catch (err) {
		return {
			raw: {},
			problems: [
				{
					key: "file",
					message: `${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
				},
			],
		};
	}
}

/**
 * Merge `updates` over the config file's current contents (flat config: a
 * shallow spread) and write it back atomically (write to `<path>.tmp`, then
 * rename) with 2-space indent + trailing newline, so readers never observe a
 * half-written file and the atomic rename replaces the inode. Missing file is
 * treated as `{}`. An invalid-JSON or non-object file, or a missing parent
 * directory, yields a `{ key: "file" }` problem and leaves the file untouched.
 * Never throws.
 */
export function updateConfigFile(
	configPath: string,
	updates: Record<string, unknown>,
): ConfigProblem[] {
	const dir = dirname(configPath);
	if (!existsSync(dir)) {
		return [
			{
				key: "file",
				message: `${configPath} parent directory does not exist`,
			},
		];
	}
	let existing: Record<string, unknown> = {};
	try {
		if (existsSync(configPath)) {
			const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				return [
					{
						key: "file",
						message: "config root must be a JSON object",
					},
				];
			}
			existing = parsed as Record<string, unknown>;
		}
	} catch (err) {
		return [
			{
				key: "file",
				message: `${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
			},
		];
	}
	const merged = { ...existing, ...updates };
	const tmpPath = `${configPath}.tmp`;
	try {
		writeFileSync(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
		renameSync(tmpPath, configPath);
	} catch (err) {
		try {
			rmSync(tmpPath, { force: true });
		} catch {
			// best-effort tmp cleanup; the problem below is the real signal
		}
		return [
			{
				key: "file",
				message: `failed to write ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
			},
		];
	}
	return [];
}
