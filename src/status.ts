import { type AssessOptions, assess, usageTotal } from "./context";
import type { StepTokens } from "./types";

/** One session's current context state, as the sidebar reads it. */
export interface ContextStatus {
	sessionID: string;
	tokens?: number;
	window?: number;
	percent?: number;
	warnPercent: number | null;
	warnTokens: number | null;
	over: boolean;
	compacting: boolean;
}

export function contextStatus(
	sessionID: string,
	tokens: StepTokens | undefined,
	window: number | undefined,
	options: AssessOptions,
	compacting: boolean,
): ContextStatus {
	const total = usageTotal(tokens);
	const result =
		total === undefined ? undefined : assess(options, total, window, undefined);
	return {
		sessionID,
		...(total !== undefined ? { tokens: total } : {}),
		...(window !== undefined && window > 0 ? { window } : {}),
		...(result?.pct !== undefined ? { percent: result.pct } : {}),
		warnPercent: options.warnPercent,
		warnTokens: options.warnTokens,
		over: !compacting && (result?.shouldInject ?? false),
		compacting,
	};
}
