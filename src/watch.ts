import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { ConfigProblem } from "./config";
import { loadOptions } from "./config";

/**
 * Watch module — the config-file watcher that bridges file writes from the
 * TUI commands into the server-side live state.
 *
 * The config file is replaced atomically by the TUI commands (write to
 * `<path>.tmp`, then rename), which replaces the inode, so we watch the PARENT
 * directory and filter by basename rather than watching the file directly.
 * Callbacks are debounced because a single write may emit several rename
 * events. `close()` stops the watcher (clearing any pending debounce) and the
 * callback becomes a no-op afterwards. Never throws: a failed watch or a
 * missing parent directory makes the watcher inert.
 */
export function watchConfigFile(
	configPath: string,
	onChange: (problems: ConfigProblem[]) => void,
	debounceMs = 150,
): { close: () => void } {
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let watcher: ReturnType<typeof watch> | undefined;

	const fire = () => {
		timer = undefined;
		if (closed) return;
		let problems: ConfigProblem[] = [];
		try {
			problems = loadOptions(configPath).problems;
		} catch {
			// The file (or its parent dir) may have disappeared between the
			// watch event and this read; report nothing rather than throw.
		}
		onChange(problems);
	};

	const debouncedFire = () => {
		if (closed) return;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(fire, debounceMs);
	};

	try {
		watcher = watch(dirname(configPath), (_event, filename) => {
			try {
				if (filename !== null && basename(filename) !== basename(configPath))
					return;
				debouncedFire();
			} catch {
				// The watched directory may be gone mid-event (e.g. teardown);
				// stay inert rather than throwing into the runner.
			}
		});
		watcher.on("error", () => {
			// The watched directory may disappear (e.g. test teardown); real
			// node crashes without an error listener, so always attach one.
		});
	} catch {
		// Unwatchable (missing parent dir, permission issues): stay inert.
	}

	return {
		close: () => {
			closed = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			try {
				watcher?.close();
			} catch {
				// already closed / closing: nothing to do
			}
			watcher = undefined;
		},
	};
}
