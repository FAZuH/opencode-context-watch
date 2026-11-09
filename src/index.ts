import { resolveOptions } from "./config";
import {
	type LastWarned,
	assess,
	renderMessage,
	usagePhrase,
	usageTotal,
	warningMessage,
} from "./context";
import { Contract } from "./rpc";
import { contextStatus } from "./status";
import type {
	PluginContext,
	RpcRegistration,
	StepEndedData,
	StepTokens,
} from "./types";

const PREFIX = "[context-watch]";

const windowKey = (providerID: string, modelID: string) =>
	`${providerID}/${modelID}`;

interface SessionInfoResult {
	data?: { model?: { id?: unknown; providerID?: unknown } };
	model?: { id?: unknown; providerID?: unknown };
}

const sessionIDOf = (data: unknown): string | undefined => {
	if (!data || typeof data !== "object") return undefined;
	const id = (data as { sessionID?: unknown }).sessionID;
	return typeof id === "string" && id ? id : undefined;
};

export default {
	id: "opencode-context-watch",

	async setup(ctx: PluginContext) {
		const { options, problems } = resolveOptions(ctx.options);
		for (const problem of problems) {
			console.error(`${PREFIX} ${problem.key}: ${problem.message}`);
		}

		const windows = new Map<string, number>();
		try {
			const list = await ctx.model.list();
			for (const model of list.data ?? []) {
				const size = model.limit?.context;
				if (typeof size === "number" && size > 0) {
					windows.set(windowKey(model.providerID, model.id), size);
				}
			}
		} catch (err) {
			// Without the map the percent band is off; the tokens band still works.
			console.error(
				`${PREFIX} model list unavailable, percent band disabled:`,
				err,
			);
		}

		// Only `session.step.ended` carries one step's own context size.
		// `session.usage.updated` is cumulative consumption for the whole session.
		// The event lands after the next hook call, so the cache trails the
		// request by one step; the first requests of a session have no sample.
		const usage = new Map<string, StepTokens>();
		const lastWarned = new Map<string, LastWarned>();
		const lastWindow = new Map<string, number>();
		const compacting = new Set<string>();

		const statusOf = async (sessionID: string) => {
			const window = await windowOf(sessionID);
			return contextStatus(
				sessionID,
				usage.get(sessionID),
				window,
				options,
				compacting.has(sessionID),
			);
		};

		/**
		 * The model window for a session. The hook is the cheap source, but a
		 * service can answer the RPC from another project instance, so fall
		 * back to the session's own model record.
		 */
		const windowOf = async (sessionID: string) => {
			const remembered = lastWindow.get(sessionID);
			if (remembered !== undefined) return remembered;
			if (
				typeof options.windowTokens === "number" &&
				options.windowTokens > 0
			) {
				return options.windowTokens;
			}
			if (typeof ctx.session.get !== "function") return undefined;
			try {
				const result = (await ctx.session.get({ sessionID })) as
					| SessionInfoResult
					| undefined;
				const session = result?.data ?? result;
				const model = session?.model;
				if (
					typeof model?.providerID !== "string" ||
					typeof model?.id !== "string"
				)
					return undefined;
				return windows.get(windowKey(model.providerID, model.id));
			} catch {
				return undefined;
			}
		};

		let rpc: RpcRegistration | undefined;
		if (typeof ctx.rpc?.register === "function") {
			try {
				rpc = await ctx.rpc.register(Contract, {
					status: async (input: unknown) => {
						const sessionID = String(
							(input as { sessionID?: unknown } | undefined)?.sessionID ?? "",
						);
						if (!sessionID) return { ok: false };
						return { ok: true, status: await statusOf(sessionID) };
					},
				});
			} catch (err) {
				// The sidebar is a read-only view; losing it must not stop warnings.
				console.error(`${PREFIX} RPC registration failed:`, err);
			}
		}

		const publish = async (sessionID: string) => {
			if (!rpc) return;
			try {
				await rpc.events.emit("changed", {
					sessionID,
					status: await statusOf(sessionID),
				});
			} catch (err) {
				console.error(`${PREFIX} status event failed:`, err);
			}
		};

		const cancel = new AbortController();
		void (async () => {
			try {
				for await (const event of await ctx.event.subscribe({
					signal: cancel.signal,
				})) {
					const sessionID = sessionIDOf(event.data);
					if (event.type === "session.compaction.started") {
						if (sessionID) {
							compacting.add(sessionID);
							await publish(sessionID);
						}
						continue;
					}
					if (
						event.type === "session.compaction.ended" ||
						event.type === "session.compaction.failed"
					) {
						// The pre-compaction sample describes a context that no longer
						// exists. Drop it and wait for the next completed step.
						if (sessionID) {
							compacting.delete(sessionID);
							usage.delete(sessionID);
							lastWarned.delete(sessionID);
							await publish(sessionID);
						}
						continue;
					}
					if (event.type === "session.deleted") {
						if (sessionID) {
							usage.delete(sessionID);
							lastWarned.delete(sessionID);
							lastWindow.delete(sessionID);
							compacting.delete(sessionID);
						}
						continue;
					}
					if (event.type !== "session.step.ended") continue;
					// A malformed payload must not throw out of the loop: that would
					// kill the only usage source for the rest of the session.
					const step = event.data as Partial<StepEndedData> | undefined;
					if (!step || typeof step.sessionID !== "string" || !step.tokens)
						continue;
					usage.set(step.sessionID, step.tokens);
					await publish(step.sessionID);
				}
			} catch (err) {
				if (!cancel.signal.aborted)
					console.error(`${PREFIX} event stream failed:`, err);
			}
		})();

		const registration = await ctx.session
			.hook("context", (event) => {
				if (compacting.has(event.sessionID)) return;
				const window =
					options.windowTokens ??
					windows.get(windowKey(event.model.providerID, event.model.id));
				if (window !== undefined && window > 0) {
					lastWindow.set(event.sessionID, window);
				}
				const tokens = usageTotal(usage.get(event.sessionID));
				if (tokens === undefined) return;
				const result = assess(
					options,
					tokens,
					window,
					lastWarned.get(event.sessionID),
				);
				if (!result.shouldInject) return;
				if (result.shouldNotify) {
					lastWarned.set(event.sessionID, result.next);
					if (options.verbose) {
						console.log(
							`${PREFIX} ${event.sessionID} at ${usagePhrase(result.pct, tokens, window)}`,
						);
					}
				}
				// The appended message is never persisted, so the rearm must not gate
				// it: every above-threshold request needs its own copy.
				event.messages.push(
					warningMessage(
						renderMessage(options.message, result.pct, tokens, window),
					),
				);
			})
			.catch((err: unknown) => {
				// A rejected registration must not leave the event stream running
				// with nothing to dispose it.
				cancel.abort();
				throw err;
			});

		return () => {
			cancel.abort();
			registration.dispose();
		};
	},
};
