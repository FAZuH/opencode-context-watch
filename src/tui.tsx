/** @jsxImportSource @opentui/solid */
/**
 * Context Watch in the TUI: one sidebar section for the routed session.
 *
 * The server half owns the numbers; this half reads them over the plugin's own
 * RPC, so the status never depends on another plugin's copy of the contract.
 * The section is on by default; `/context-watch` toggles it.
 */
import { Show, createEffect, createSignal, onCleanup } from "solid-js";

import { Contract } from "./rpc";
import { contextLine } from "./line";
import type { ContextStatus } from "./status";

function Section(props: {
	ctx: any;
	sessionID: string;
	status: () => ContextStatus | undefined;
	refresh: (sessionID: string) => void;
}) {
	// The RPC event is the fast path; the poll covers a client that misses it.
	createEffect(() => {
		const sessionID = props.sessionID;
		if (!sessionID) return;
		props.refresh(sessionID);
		const timer = setInterval(() => props.refresh(sessionID), 5_000);
		onCleanup(() => clearInterval(timer));
	});

	const theme = props.ctx.theme;

	return (
		<Show when={props.status()}>
			{(status: () => ContextStatus) => (
				<box>
					<box flexDirection="row" gap={1}>
						<text
							fg={
								status().compacting || status().over
									? theme.text.feedback.warning.base
									: theme.text.base
							}
						>
							<b>Context Watch</b>
						</text>
						<Show when={status().over}>
							<text fg={theme.text.feedback.warning.base}> · over</text>
						</Show>
					</box>
					<text fg={theme.text.muted} wrapMode="none" truncate>
						{contextLine(status())}
					</text>
				</box>
			)}
		</Show>
	);
}

export default {
	id: "opencode-context-watch-tui",

	setup(ctx: any) {
		if (typeof ctx.client?.rpc !== "function" || typeof ctx.ui?.slot !== "function") return;

		const rpc = ctx.client.rpc(Contract);
		const [contexts, setContexts] = createSignal<
			Record<string, ContextStatus | undefined>
		>({});
		const [view, setView] = ctx.storage.store("context-watch-view-v1", {
			initial: { shown: true },
		});

		const remember = (sessionID: string, status: ContextStatus) => {
			setContexts((previous) => ({ ...previous, [sessionID]: status }));
		};

		const refresh = (sessionID: string) => {
			try {
				void rpc
					.status({ sessionID })
					.then((result: any) => {
						if (result?.ok && result.status) remember(sessionID, result.status);
					})
					.catch(() => {});
			} catch {}
		};

		let off: (() => void) | undefined;
		try {
			off = rpc.events.on("changed", (event: any) => {
				const sessionID = String(event?.data?.sessionID ?? "");
				const status = event?.data?.status;
				if (sessionID && status) remember(sessionID, status);
			});
		} catch {
			// No event stream: the section still polls while it is on screen.
		}
		onCleanup(() => off?.());

		ctx.ui.slot({
			append: "sidebar.content",
			render: (input: any) => {
				const sessionID = String(input?.sessionID ?? "");
				return (
					<Show when={view.shown !== false}>
						<Section
							ctx={ctx}
							sessionID={sessionID}
							status={() => contexts()[sessionID]}
							refresh={refresh}
						/>
					</Show>
				);
			},
		});

		// The keymap layer is owned by a component, like the host's own plugins.
		ctx.ui.slot({
			append: "app",
			render: () => {
				ctx.keymap.layer(() => ({
					mode: "global",
					priority: 1,
					enabled: true,
					commands: [
						{
							id: "context-watch.toggle",
							title: "Context Watch",
							group: "context-watch",
							palette: true,
							slash: { name: "context-watch" },
							run: () => {
								void setView((draft: any) => {
									draft.shown = draft.shown === false;
								});
							},
						},
					],
				}));
				return null;
			},
		});
	},
};
