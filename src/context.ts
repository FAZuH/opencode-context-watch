import type { Message, Part } from "@opencode-ai/sdk";
import type { Notifier } from "./notify";

/**
 * Context module — the session context-usage assessment domain.
 *
 * Pure functions that turn raw message lists and config thresholds into a
 * concrete assessment: how full the window is, whether a band is crossed,
 * and whether the user-facing notification should re-fire (the rearm rule).
 * `notifyWarning` is the one impure helper — the shared band-notification
 * glue both backends call; everything else is side-effect free.
 */

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
	/** The transient warning must be injected on every step above a band. */
	shouldInject: boolean;
	/** The toast + verbose log fire only on a rearm rise. */
	shouldNotify: boolean;
	/** The `lastWarned` value to store when `shouldNotify` is true. */
	next: LastWarned;
}

/**
 * Assess a context sample against the threshold bands (OR semantics) and the
 * rearm rule. Pure: given the same inputs it returns the same assessment and
 * mutates nothing — the caller owns storing `next`.
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
			...(pctReArmed && overPercent ? { pct } : {}),
			...(tokensReArmed && overTokens ? { tokens } : {}),
		},
	};
}

/**
 * Return the provider-reported context size, matching opencode's TUI context
 * meter: the most recent completed assistant message's
 * `input + output + reasoning + cache.read + cache.write`. This is the ground
 * truth for how full the window actually is.
 */
export function contextTokens(
	messages: { info: Message; parts: Part[] }[],
): number | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const info = messages[i].info;
		if (info.role !== "assistant") continue;
		const t = info.tokens;
		if (!t || !t.input || t.input <= 0) continue;
		if (!t.output || t.output <= 0) continue;
		return (
			t.input +
			(t.output ?? 0) +
			(t.reasoning ?? 0) +
			(t.cache?.read ?? 0) +
			(t.cache?.write ?? 0)
		);
	}
	return undefined;
}

/**
 * The v2 event-stream equivalent of `contextTokens`: reduce the
 * provider-reported `TokenUsageInfo` (the `data.tokens` of
 * `session.step.ended` / `session.usage.updated`) with the same ground-truth
 * sum rule as the v1 message path. The v2 `Message` carries no token counts,
 * so the event stream is the only source.
 */
export function tokensFromUsage(usage: {
	input?: number;
	output?: number;
	reasoning?: number;
	cache?: { read?: number; write?: number };
}): number | undefined {
	// Same pickiness as `contextTokens`: only a completed step (input AND
	// output > 0) is ground truth. A mid-stream `usage.updated` with no
	// output yet must not fire an early warning against a partial sample.
	const input = usage.input;
	const output = usage.output;
	if (!input || input <= 0) return undefined;
	if (!output || output <= 0) return undefined;
	return (
		input +
		output +
		(usage.reasoning ?? 0) +
		(usage.cache?.read ?? 0) +
		(usage.cache?.write ?? 0)
	);
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
 * Shared band notification: the verbose log + warning toast that fire on a
 * rearm rise. Both backends call this after injecting — only the extraction
 * of the injected warning's last text part differs (v1 reads `parts[0]`, v2
 * reads `content.at(-1)`), which the caller passes as `lastPart`. Behavior
 * matches the original v1 glue exactly: `lastMessageText` is the text part
 * sliced to 80 chars or "none", and the toast strings are unchanged.
 */
export function notifyWarning(args: {
	notifier: Notifier;
	result: Assessment;
	tokens: number;
	window: number | undefined;
	sessionID: string;
	messageCount: number;
	/** The injected warning's last text part (`parts[0]` / `content.at(-1)`). */
	lastPart: unknown;
}): void {
	const lastText =
		args.lastPart &&
		typeof args.lastPart === "object" &&
		"type" in args.lastPart &&
		(args.lastPart as { type?: unknown }).type === "text" &&
		typeof (args.lastPart as { text?: unknown }).text === "string"
			? (args.lastPart as { type: "text"; text: string }).text.slice(0, 80)
			: "none";
	args.notifier.log("warn", "context warning injected", {
		sessionID: args.sessionID,
		percent:
			args.result.pct === undefined ? undefined : Math.round(args.result.pct),
		messageTokens: args.tokens,
		window: args.window,
		lastMessageText: lastText,
		messageCount: args.messageCount,
	});
	void args.notifier.toast(
		args.result.overPercent && args.result.pct !== undefined
			? `Context window at ${Math.round(args.result.pct)}% — getting full`
			: `Session context reached ${args.tokens.toLocaleString()} tokens — getting full`,
		"warning",
	);
}
