/**
 * Context module — the session context-usage assessment domain.
 *
 * Pure functions that turn one completed step's token usage plus config
 * thresholds into a concrete assessment: how full the window is, whether a
 * band is crossed, and whether the log line should re-fire. The composition
 * root routes the result.
 */

import type { ContextMessage, StepTokens } from "./types";

/**
 * The threshold settings that drive the assessment. A subset of the resolved
 * config; `warnPercent` is the normalized fraction (0.77, not 77).
 */
export interface AssessOptions {
	warnPercent: number;
	warnTokens: number;
	rearmPercent: number;
	rearmTokens: number;
}

/** The last value each band was notified at, per session. */
export interface LastWarned {
	pct?: number;
	tokens?: number;
}

export interface Assessment {
	/** Context size as a percent of the window, when the window is known. */
	pct?: number;
	overPercent: boolean;
	overTokens: boolean;
	/** The warning must be appended on every step above a band. */
	shouldInject: boolean;
	/** The verbose log fires only on a rearm rise. */
	shouldNotify: boolean;
	/** The `lastWarned` value to store when `shouldNotify` is true. */
	next: LastWarned;
}

/**
 * Context size for one completed step, matching opencode's TUI context meter:
 * `input + output + reasoning + cache.read + cache.write`. Never sum `input`
 * across steps — each step's `input` is the whole context at request time, so
 * a sum overcounts. Returns undefined when there is no usable sample yet.
 */
export function usageTotal(tokens: StepTokens | undefined): number | undefined {
	const input = tokens?.input ?? 0;
	if (input <= 0) return undefined;
	return (
		input +
		(tokens?.output ?? 0) +
		(tokens?.reasoning ?? 0) +
		(tokens?.cache?.read ?? 0) +
		(tokens?.cache?.write ?? 0)
	);
}

/**
 * Assess a context sample against the threshold bands (OR semantics) and the
 * rearm rule. Pure: same inputs, same assessment, no mutation — the caller
 * owns storing `next`.
 */
export function assess(
	opts: AssessOptions,
	tokens: number,
	window: number | undefined,
	last: LastWarned | undefined,
): Assessment {
	const pct = window && window > 0 ? (tokens / window) * 100 : undefined;
	const thresholdPct = opts.warnPercent * 100;
	const overPercent = pct !== undefined && pct >= thresholdPct;
	const overTokens = tokens >= opts.warnTokens;

	const pctReArmed =
		overPercent &&
		(last?.pct === undefined || (pct ?? 0) - last.pct >= opts.rearmPercent);
	const tokensReArmed =
		overTokens &&
		(last?.tokens === undefined || tokens - last.tokens >= opts.rearmTokens);

	return {
		pct,
		overPercent,
		overTokens,
		shouldInject: overPercent || overTokens,
		shouldNotify: pctReArmed || tokensReArmed,
		next: {
			...last,
			...(pctReArmed ? { pct } : {}),
			...(tokensReArmed ? { tokens } : {}),
		},
	};
}

/**
 * Render the warning template, substituting the `{percent}`, `{tokens}` and
 * `{window}` placeholders.
 */
export function renderMessage(
	template: string,
	pct: number | undefined,
	tokens: number,
	window: number | undefined,
): string {
	return template
		.replaceAll("{percent}", String(Math.round(pct ?? 0)))
		.replaceAll("{tokens}", tokens.toLocaleString())
		.replaceAll("{window}", window?.toLocaleString() ?? "unknown");
}

/**
 * The synthetic message carrying the warning to the model. It lives only in
 * the current hook call's array — opencode never persists it — so the caller
 * must append one on every above-threshold request.
 */
export function warningMessage(text: string): ContextMessage {
	return { role: "user", content: [{ type: "text", text }] };
}
