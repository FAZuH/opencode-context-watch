/**
 * Config module — the plugin's configuration domain.
 *
 * Pure validation of the options object opencode hands the plugin through
 * `ctx.options`, with per-key fallback to defaults and a problem per rejected
 * value. No filesystem, no environment: opencode owns both now.
 */

export interface ContextWatchOptions {
	warnPercent?: number;
	warnTokens?: number;
	windowTokens?: number | null;
	rearmPercent?: number;
	rearmTokens?: number;
	verbose?: boolean;
	message?: string;
}

export interface ConfigProblem {
	key: string;
	message: string;
}

export const DEFAULTS: Required<ContextWatchOptions> = {
	warnPercent: 0.77,
	warnTokens: 150_000,
	windowTokens: null,
	rearmPercent: 5,
	rearmTokens: 5_000,
	verbose: false,
	message:
		"[context-watch] Context window usage is at {percent}% ({tokens}/{window} tokens). The session is getting full: wrap up the current step soon, keep replies concise, avoid re-reading large files, and be ready to prepare for compaction if you continue.",
};

const CONFIG_KEYS = new Set(Object.keys(DEFAULTS));

export function resolveOptions(raw: unknown): {
	options: Required<ContextWatchOptions>;
	problems: ConfigProblem[];
} {
	const problems: ConfigProblem[] = [];
	let conf: Record<string, unknown> = {};
	if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
		conf = raw as Record<string, unknown>;
	} else if (raw !== undefined) {
		problems.push({
			key: "options",
			message: `must be an object (got ${JSON.stringify(raw)})`,
		});
	}

	for (const key of Object.keys(conf)) {
		if (!CONFIG_KEYS.has(key)) {
			problems.push({ key, message: `unknown option "${key}" (ignored)` });
		}
	}

	// Booleans, null and objects are not numbers, so they fail validation rather
	// than coercing to 0/1 behind the user's back.
	const toNumber = (value: unknown): number =>
		typeof value === "number" || typeof value === "string"
			? Number(value)
			: Number.NaN;

	const num = (
		key: keyof ContextWatchOptions,
		expected: string,
		test: (n: number) => boolean,
	): number => {
		const value = conf[key];
		if (value === undefined) return DEFAULTS[key] as number;
		const n = toNumber(value);
		if (Number.isFinite(n) && test(n)) return n;
		problems.push({
			key,
			message: `must be ${expected} (got ${JSON.stringify(value)})`,
		});
		return DEFAULTS[key] as number;
	};

	const warnPercent = num(
		"warnPercent",
		"a number greater than 0 and at most 100",
		(n) => n > 0 && n <= 100,
	);
	const warnTokens = num("warnTokens", "a positive number", (n) => n > 0);
	const rearmPercent = num("rearmPercent", "a positive number", (n) => n > 0);
	const rearmTokens = num("rearmTokens", "a positive number", (n) => n > 0);

	const windowValue = conf.windowTokens;
	let windowTokens: number | null = DEFAULTS.windowTokens;
	if (windowValue !== undefined && windowValue !== null) {
		const n = toNumber(windowValue);
		if (Number.isFinite(n) && n > 0) {
			windowTokens = n;
		} else {
			problems.push({
				key: "windowTokens",
				message: `must be a positive number or null (got ${JSON.stringify(windowValue)})`,
			});
		}
	}

	const verboseValue = conf.verbose;
	let verbose = DEFAULTS.verbose;
	if (verboseValue !== undefined) {
		if (typeof verboseValue === "boolean") {
			verbose = verboseValue;
		} else {
			problems.push({
				key: "verbose",
				message: `must be a boolean (got ${JSON.stringify(verboseValue)})`,
			});
		}
	}

	let message = DEFAULTS.message;
	if (conf.message !== undefined) {
		if (typeof conf.message === "string" && conf.message.trim().length > 0) {
			message = conf.message;
		} else {
			problems.push({
				key: "message",
				message: `must be a non-empty string (got ${JSON.stringify(conf.message)})`,
			});
		}
	}

	return {
		options: {
			warnPercent: warnPercent > 1 ? warnPercent / 100 : warnPercent,
			warnTokens,
			windowTokens,
			rearmPercent,
			rearmTokens,
			verbose,
			message,
		},
		problems,
	};
}
