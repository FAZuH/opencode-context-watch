/**
 * Notify module — user-facing notifications (TUI toast + opencode app log).
 *
 * The plugin surfaces three kinds of notification: band warnings (toast +
 * verbose log), config errors (always logged, always toasted even when toasts
 * are disabled), and verbose diagnostics. This module is the single seam
 * between the domain and `client.tui` / `client.app`.
 */

export interface NotifyClient {
	tui: {
		showToast(arg: {
			body: { message: string; variant: string };
		}): Promise<unknown>;
	};
	app: {
		log(arg: {
			body: {
				service: string;
				level: string;
				message: string;
				extra: unknown;
			};
		}): Promise<unknown>;
	};
}

export interface NotifierOptions {
	toastEnabled: boolean;
	verbose: boolean;
}

export class Notifier {
	constructor(
		private readonly client: NotifyClient,
		private readonly opts: NotifierOptions,
	) {}

	/**
	 * Show a TUI toast. Warning toasts are gated by the `toast` config; error
	 * toasts (config problems) always fire. Any failure falls back to the
	 * opencode log and is never raised. Returns whether the toast was shown.
	 */
	async toast(text: string, variant: "warning" | "error"): Promise<boolean> {
		if (variant === "warning" && !this.opts.toastEnabled) return false;
		try {
			await this.client.tui.showToast({
				body: { message: text, variant },
			});
			return true;
		} catch (err) {
			console.log("[context-watch]", text, err ?? "");
			return false;
		}
	}

	/** Verbose-gated diagnostic log: console + opencode app log. */
	log(
		level: "debug" | "warn",
		message: string,
		extra: Record<string, unknown>,
	): void {
		if (!this.opts.verbose) return;
		console.log("[context-watch]", message, JSON.stringify(extra));
		this.client.app
			.log({ body: { service: "context-watch", level, message, extra } })
			.catch(() => {});
	}

	/** Always-logged entry (config errors): console + opencode app log. */
	alwaysLog(
		level: "error",
		message: string,
		extra: Record<string, unknown>,
	): void {
		console.log("[context-watch]", message, JSON.stringify(extra));
		this.client.app
			.log({ body: { service: "context-watch", level, message, extra } })
			.catch(() => {});
	}
}
