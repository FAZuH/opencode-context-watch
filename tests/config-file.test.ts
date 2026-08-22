import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOptions, readConfigFile, updateConfigFile } from "../src/config";

function tempDir(label: string): string {
	return mkdtempSync(join(tmpdir(), `context-watch-${label}-`));
}

describe("updateConfigFile", () => {
	test("writes a new key into an existing file and preserves existing keys", () => {
		const dir = tempDir("cfg");
		const configPath = join(dir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({ warnPercent: 60, toast: false }),
			"utf8",
		);

		const problems = updateConfigFile(configPath, { enabled: false });

		expect(problems).toEqual([]);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			warnPercent: 60,
			toast: false,
			enabled: false,
		});
		rmSync(dir, { recursive: true, force: true });
	});

	test("overwrites an existing key with the update value", () => {
		const dir = tempDir("cfg");
		const configPath = join(dir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({ enabled: true, warnPercent: 50 }),
			"utf8",
		);

		const problems = updateConfigFile(configPath, { enabled: false });

		expect(problems).toEqual([]);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			enabled: false,
			warnPercent: 50,
		});
		rmSync(dir, { recursive: true, force: true });
	});

	test("creates a missing file with just the update", () => {
		const dir = tempDir("cfg");
		const configPath = join(dir, "config.json");

		const problems = updateConfigFile(configPath, { enabled: false });

		expect(problems).toEqual([]);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			enabled: false,
		});
		rmSync(dir, { recursive: true, force: true });
	});

	test("writes 2-space-indented JSON with a trailing newline", () => {
		const dir = tempDir("cfg");
		const configPath = join(dir, "config.json");

		updateConfigFile(configPath, { enabled: true });

		const text = readFileSync(configPath, "utf8");
		expect(text).toBe('{\n  "enabled": true\n}\n');
		rmSync(dir, { recursive: true, force: true });
	});

	test("leaves no .tmp file behind after a successful write", () => {
		const dir = tempDir("cfg");
		const configPath = join(dir, "config.json");

		updateConfigFile(configPath, { enabled: true });

		expect(existsSync(`${configPath}.tmp`)).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	test("returns a problem and does not overwrite an invalid-JSON file", () => {
		const dir = tempDir("cfg");
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, "{ not json !!", "utf8");

		const problems = updateConfigFile(configPath, { enabled: false });

		expect(problems).toHaveLength(1);
		expect(problems[0].key).toBe("file");
		expect(readFileSync(configPath, "utf8")).toBe("{ not json !!");
		rmSync(dir, { recursive: true, force: true });
	});

	test("returns a problem and does not clobber a non-object root", () => {
		const dir = tempDir("cfg");
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, "42", "utf8");

		const problems = updateConfigFile(configPath, { enabled: false });

		expect(problems).toHaveLength(1);
		expect(problems[0].key).toBe("file");
		expect(readFileSync(configPath, "utf8")).toBe("42");
		rmSync(dir, { recursive: true, force: true });
	});

	test("returns a problem and does not create the file when the parent dir is missing", () => {
		const dir = tempDir("cfg");
		const configPath = join(dir, "missing", "config.json");

		const problems = updateConfigFile(configPath, { enabled: false });

		expect(problems).toHaveLength(1);
		expect(problems[0].key).toBe("file");
		expect(existsSync(join(dir, "missing"))).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("readConfigFile", () => {
	test("returns an empty object with no problems for a missing file", () => {
		const dir = tempDir("cfg");
		const result = readConfigFile(join(dir, "config.json"));
		expect(result).toEqual({ raw: {}, problems: [] });
		rmSync(dir, { recursive: true, force: true });
	});

	test("returns the parsed object for a valid file", () => {
		const dir = tempDir("cfg");
		const configPath = join(dir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({ enabled: false, warnPercent: 40 }),
			"utf8",
		);
		const result = readConfigFile(configPath);
		expect(result.problems).toEqual([]);
		expect(result.raw).toEqual({ enabled: false, warnPercent: 40 });
		rmSync(dir, { recursive: true, force: true });
	});

	test("returns a file problem and an empty object for invalid JSON", () => {
		const dir = tempDir("cfg");
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, "{ nope", "utf8");
		const result = readConfigFile(configPath);
		expect(result.raw).toEqual({});
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0].key).toBe("file");
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("loadOptions overlay", () => {
	const ENV_VARS = ["CONTEXT_WATCH_PERCENT", "CONTEXT_WATCH_TOKENS"];

	function withEnv(
		env: Record<string, string | undefined>,
		body: () => void,
	): void {
		const saved = new Map<string, string | undefined>();
		for (const v of ENV_VARS) {
			saved.set(v, process.env[v]);
			delete process.env[v];
		}
		try {
			for (const [k, v] of Object.entries(env)) {
				if (v !== undefined) process.env[k] = v;
			}
			body();
		} finally {
			for (const v of ENV_VARS) {
				const prev = saved.get(v);
				if (prev === undefined) delete process.env[v];
				else process.env[v] = prev;
			}
		}
	}

	test("overlay values override the config file per key", () => {
		const dir = tempDir("cfg");
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, JSON.stringify({ warnPercent: 90 }), "utf8");

		withEnv({}, () => {
			const { options, problems } = loadOptions(configPath, {
				warnPercent: 50,
			});
			expect(problems).toEqual([]);
			expect(options.warnPercent).toBe(0.5);
		});
		rmSync(dir, { recursive: true, force: true });
	});

	test("file values still govern keys the overlay omits", () => {
		const dir = tempDir("cfg");
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, JSON.stringify({ warnTokens: 123_456 }), "utf8");

		withEnv({}, () => {
			const { options, problems } = loadOptions(configPath, {
				warnPercent: 50,
			});
			expect(problems).toEqual([]);
			expect(options.warnPercent).toBe(0.5);
			expect(options.warnTokens).toBe(123_456);
		});
		rmSync(dir, { recursive: true, force: true });
	});

	test("env overrides win over both the overlay and the file", () => {
		const dir = tempDir("cfg");
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, JSON.stringify({ warnPercent: 90 }), "utf8");

		withEnv({ CONTEXT_WATCH_PERCENT: "20" }, () => {
			const { options, problems } = loadOptions(configPath, {
				warnPercent: 50,
			});
			expect(problems).toEqual([]);
			expect(options.warnPercent).toBe(0.2);
		});
		rmSync(dir, { recursive: true, force: true });
	});

	test("still reports the invalid-JSON file problem when an overlay is present", () => {
		const dir = tempDir("cfg");
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, "{ nope", "utf8");

		withEnv({}, () => {
			const { options, problems } = loadOptions(configPath, {
				warnPercent: 50,
			});
			expect(problems).toHaveLength(1);
			expect(problems[0].key).toBe("file");
			// A parse failure leaves an empty raw object, so the trusted
			// overlay still applies over the defaults.
			expect(options.warnPercent).toBe(0.5);
		});
		rmSync(dir, { recursive: true, force: true });
	});

	test("still reports the non-object-root file problem when an overlay is present", () => {
		const dir = tempDir("cfg");
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, "42", "utf8");

		withEnv({}, () => {
			const { options, problems } = loadOptions(configPath, {
				warnPercent: 50,
			});
			expect(problems).toHaveLength(1);
			expect(problems[0].key).toBe("file");
			// A non-object root cannot be merged, so neither it nor the
			// overlay governs — defaults do.
			expect(options.warnPercent).toBe(0.77);
		});
		rmSync(dir, { recursive: true, force: true });
	});

	test.each([
		["an array", ["warnPercent"]],
		["a string", "warnPercent"],
		["null", null],
	])("ignores %s as an overlay and reads only the file", (_label, overlay) => {
		const dir = tempDir("cfg");
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, JSON.stringify({ warnPercent: 90 }), "utf8");

		withEnv({}, () => {
			const { options, problems } = loadOptions(configPath, overlay as unknown);
			expect(problems).toEqual([]);
			expect(options.warnPercent).toBe(0.9);
		});
		rmSync(dir, { recursive: true, force: true });
	});
});
