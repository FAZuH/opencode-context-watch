import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchConfigFile } from "../src/watch";

const ENV_VARS = [
	"CONTEXT_WATCH_PERCENT",
	"CONTEXT_WATCH_TOKENS",
	"CONTEXT_WATCH_WINDOW",
	"CONTEXT_WATCH_REARM",
	"CONTEXT_WATCH_REARM_TOKENS",
	"CONTEXT_WATCH_MESSAGE",
	"CONTEXT_WATCH_NO_TOAST",
	"CONTEXT_WATCH_POST_COMPACT_CONTINUE",
	"CONTEXT_WATCH_POST_COMPACT_MSG",
];

/**
 * Run a test body against an isolated tmp config dir. The body MUST be
 * awaited before the teardown: a sync `finally` rmSync would delete the dir
 * while the async body is still paused on an `await`, and the resumed
 * writeFileSync would hit ENOENT as an "Unhandled error between tests".
 */
async function withConfigDir(
	fn: (configPath: string) => void | Promise<void>,
): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "context-watch-watch-test-"));
	const configPath = join(home, "opencode-context-watch.json");

	const savedEnv = new Map<string, string | undefined>();
	for (const v of ENV_VARS) {
		savedEnv.set(v, process.env[v]);
		delete process.env[v];
	}
	try {
		await fn(configPath);
	} finally {
		rmSync(home, { recursive: true, force: true });
		for (const v of ENV_VARS) {
			const prev = savedEnv.get(v);
			if (prev === undefined) delete process.env[v];
			else process.env[v] = prev;
		}
	}
}

/** Wait for a condition with a timeout, polling every 10ms. */
async function waitFor(
	cond: () => boolean,
	timeoutMs = 2000,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return cond();
}

/**
 * Drain any pending fs.watch events/timers after close() before the tmp dir
 * is removed. The `closed` flag already makes the callback a no-op; the drain
 * just keeps the native handle from interacting with the removed dir.
 */
async function drainAfterClose(watcher: { close: () => void }): Promise<void> {
	watcher.close();
	await new Promise((r) => setTimeout(r, 20));
}

describe("watchConfigFile", () => {
	test("fires onChange after a config write, after the debounce", async () => {
		await withConfigDir(async (configPath) => {
			const calls: unknown[][] = [];
			const watcher = watchConfigFile(
				configPath,
				(problems) => {
					calls.push(problems);
				},
				50,
			);
			try {
				writeFileSync(configPath, JSON.stringify({ warnPercent: 50 }), "utf8");
				const fired = await waitFor(() => calls.length >= 1);
				expect(fired).toBe(true);
				// the callback receives the reload problems (clean file → no problems)
				expect(calls[0]).toEqual([]);
			} finally {
				await drainAfterClose(watcher);
			}
		});
	});

	test("debounces bursts of writes into few callbacks", async () => {
		await withConfigDir(async (configPath) => {
			let calls = 0;
			const debounceMs = 150;
			const watcher = watchConfigFile(
				configPath,
				() => {
					calls++;
				},
				debounceMs,
			);
			try {
				for (let i = 0; i < 5; i++) {
					writeFileSync(configPath, JSON.stringify({ warnPercent: i }), "utf8");
					await new Promise((r) => setTimeout(r, 10));
				}
				// Settle without fixed sleeps: wait until the count is unchanged
				// across a full debounce window, so every flushed event has
				// fired no matter how the machine stalled mid-burst.
				let last = -1;
				while (calls !== last) {
					last = calls;
					await new Promise((r) => setTimeout(r, debounceMs + 100));
				}
				// A burst must coalesce into at most a couple of callbacks (a
				// long stall can flush once mid-burst), never one per write.
				expect(calls).toBeGreaterThanOrEqual(1);
				expect(calls).toBeLessThanOrEqual(2);
			} finally {
				await drainAfterClose(watcher);
			}
		});
	}, 15_000);

	test("close() stops further callbacks", async () => {
		await withConfigDir(async (configPath) => {
			let calls = 0;
			const watcher = watchConfigFile(
				configPath,
				() => {
					calls++;
				},
				50,
			);
			try {
				writeFileSync(configPath, JSON.stringify({ warnPercent: 50 }), "utf8");
				await waitFor(() => calls >= 1);
				await drainAfterClose(watcher);
				const afterClose = calls;
				writeFileSync(configPath, JSON.stringify({ warnPercent: 60 }), "utf8");
				await new Promise((r) => setTimeout(r, 150));
				expect(calls).toBe(afterClose);
			} finally {
				await drainAfterClose(watcher);
			}
		});
	});

	test("passes problems for an invalid-JSON config", async () => {
		await withConfigDir(async (configPath) => {
			const calls: unknown[][] = [];
			const watcher = watchConfigFile(
				configPath,
				(problems) => {
					calls.push(problems);
				},
				50,
			);
			try {
				writeFileSync(configPath, "{ not json !!", "utf8");
				const fired = await waitFor(() => calls.length >= 1);
				expect(fired).toBe(true);
				expect(calls[0].length).toBeGreaterThan(0);
				expect(calls[0][0]).toMatchObject({ key: "file" });
			} finally {
				await drainAfterClose(watcher);
			}
		});
	});

	test("missing parent directory is a no-op and never throws", async () => {
		await withConfigDir(async (configPath) => {
			const missing = join(configPath, "..", "does-not-exist", "conf.json");
			let calls = 0;
			const watcher = watchConfigFile(
				missing,
				() => {
					calls++;
				},
				50,
			);
			try {
				// no crash; nothing fires because there is nothing to watch
				await new Promise((r) => setTimeout(r, 150));
				expect(calls).toBe(0);
			} finally {
				await drainAfterClose(watcher);
			}
		});
	});
});
