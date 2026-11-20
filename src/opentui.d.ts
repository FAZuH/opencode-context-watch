/**
 * The host resolves the TUI runtime and solid-js for plugins, so nothing is
 * vendored or installed here. These declarations keep `tsc` quiet; the running
 * app supplies the real modules.
 */
declare module "solid-js" {
	export function createSignal<T>(
		value: T,
	): [() => T, (value: T | ((previous: T) => T)) => void];
	export function createEffect(fn: () => void): void;
	export function onCleanup(fn: () => void): void;
	// biome-ignore lint/suspicious/noExplicitAny: host JSX helper type is not vendored
	export const Show: any;
}

declare module "@opentui/solid/jsx-runtime" {
	export function jsx(type: unknown, props?: Record<string, unknown>): unknown;
	export function jsxs(type: unknown, props?: Record<string, unknown>): unknown;
}

declare namespace JSX {
	// biome-ignore lint/suspicious/noExplicitAny: host JSX element type is not vendored
	type Element = any;
	interface ElementChildrenAttribute {
		// biome-ignore lint/complexity/noBannedTypes: JSX children marker follows the host runtime
		children: {};
	}
	interface IntrinsicElements {
		// biome-ignore lint/suspicious/noExplicitAny: host intrinsic element type is not vendored
		box: any;
		// biome-ignore lint/suspicious/noExplicitAny: host intrinsic element type is not vendored
		text: any;
		// biome-ignore lint/suspicious/noExplicitAny: host intrinsic element type is not vendored
		b: any;
	}
}
