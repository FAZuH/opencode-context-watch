import { resolveOptions } from "./config";
import {
	type LastWarned,
	assess,
	renderMessage,
	usageTotal,
	warningMessage,
} from "./context";
import type { PluginContext, StepEndedData, StepTokens } from "./types";

const PREFIX = "[context-watch]";

const windowKey = (providerID: string, modelID: string) =>
	`${providerID}/${modelID}`;

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
		const cancel = new AbortController();
		void (async () => {
			try {
				for await (const event of await ctx.event.subscribe({
					signal: cancel.signal,
				})) {
					if (event.type !== "session.step.ended") continue;
					// A malformed payload must not throw out of the loop: that would
					// kill the only usage source for the rest of the session.
					const step = event.data as Partial<StepEndedData> | undefined;
					if (!step || typeof step.sessionID !== "string" || !step.tokens)
						continue;
					usage.set(step.sessionID, step.tokens);
				}
			} catch (err) {
				if (!cancel.signal.aborted)
					console.error(`${PREFIX} event stream failed:`, err);
			}
		})();

		const registration = await ctx.session
			.hook("context", (event) => {
				const tokens = usageTotal(usage.get(event.sessionID));
				if (tokens === undefined) return;
				const window =
					options.windowTokens ??
					windows.get(windowKey(event.model.providerID, event.model.id));
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
							`${PREFIX} ${event.sessionID} at ${Math.round(result.pct ?? 0)}% (${tokens}/${window ?? "unknown"} tokens)`,
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
