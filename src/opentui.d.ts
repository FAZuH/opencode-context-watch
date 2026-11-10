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
	export const Show: any;
}

declare module "@opentui/solid/jsx-runtime" {
	export function jsx(type: unknown, props?: Record<string, unknown>): unknown;
	export function jsxs(type: unknown, props?: Record<string, unknown>): unknown;
}

declare namespace JSX {
	type Element = any;
	interface ElementChildrenAttribute {
		children: {};
	}
	interface IntrinsicElements {
		box: any;
		text: any;
		b: any;
	}
}
