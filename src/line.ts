import type { ContextStatus } from "./status";

/** 394_000 → 394k, 1_234_567 → 1.2M. */
export function compactCount(value: number): string {
	if (!Number.isFinite(value) || value < 0) return "?";
	const round = (n: number) => Math.round(n * 10) / 10;
	if (value >= 1_000_000) return `${round(value / 1_000_000)}M`;
	if (value >= 1_000) return `${round(value / 1_000)}k`;
	return String(Math.round(value));
}

/**
 * Usage, then the band that will warn. A missing sample and a running
 * compaction say so instead of showing a stale percent.
 */
export function contextLine(status: ContextStatus): string {
	const warn =
		status.warnTokens !== null
			? `warn ${compactCount(status.warnTokens)}`
			: status.warnPercent !== null
				? `warn ${Math.round(status.warnPercent * 100)}%`
				: "warn off";
	if (status.compacting) return `compacting · ${warn}`;
	if (status.tokens === undefined) return `no sample yet · ${warn}`;
	const usage =
		status.percent !== undefined && status.window !== undefined
			? `${Math.round(status.percent)}% · ${compactCount(status.tokens)}/${compactCount(status.window)}`
			: `${compactCount(status.tokens)} tokens`;
	return `${usage} · ${warn}`;
}
