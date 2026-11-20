import { describe, expect, test } from "bun:test";
import { compactContextTool } from "../src/compact";
import type { SessionCommands, ToolContext } from "../src/types";

const toolContext = (sessionID: string): ToolContext => ({ sessionID });

function sessionDouble(
	over: { compactError?: unknown; promptError?: unknown } = {},
) {
	const calls: {
		compact: unknown[];
		prompt: unknown[];
		order: string[];
	} = { compact: [], prompt: [], order: [] };
	const session: SessionCommands = {
		compact: async (input) => {
			calls.compact.push(input);
			calls.order.push("compact");
			if (over.compactError !== undefined) throw over.compactError;
		},
		prompt: async (input) => {
			calls.prompt.push(input);
			calls.order.push("prompt");
			if (over.promptError !== undefined) throw over.promptError;
		},
	};
	return { session, calls };
}

describe("compact_context tool", () => {
	test("declares only a message input", () => {
		const tool = compactContextTool({});
		expect(tool.name).toBe("compact_context");
		expect(tool.input).toEqual({
			type: "object",
			properties: { message: { type: "string" } },
			required: ["message"],
		});
	});

	test("compacts the calling session then posts the message as a steer prompt", async () => {
		const { session, calls } = sessionDouble();
		const result = await compactContextTool(session).execute(
			{ message: "Resume from the summary." },
			toolContext("s-42"),
		);

		expect(calls.compact).toEqual([{ sessionID: "s-42" }]);
		expect(calls.prompt).toEqual([
			{
				sessionID: "s-42",
				text: "Resume from the summary.",
				delivery: "steer",
			},
		]);
		expect(calls.order).toEqual(["compact", "prompt"]);
		expect(typeof result.content).toBe("string");
	});

	test("a compaction conflict identified by _tag skips the prompt and returns a failure", async () => {
		const conflict = Object.assign(new Error("busy"), {
			_tag: "CompactionConflictError",
		});
		const { session, calls } = sessionDouble({ compactError: conflict });
		const result = await compactContextTool(session).execute(
			{ message: "Continue." },
			toolContext("s-1"),
		);

		expect(calls.prompt).toEqual([]);
		expect(result.content).toContain("already pending");
	});

	test("a prompt conflict identified by name returns a failure after compaction", async () => {
		const conflict = new Error("busy");
		conflict.name = "PromptConflictError";
		const { session, calls } = sessionDouble({ promptError: conflict });
		const result = await compactContextTool(session).execute(
			{ message: "Continue." },
			toolContext("s-1"),
		);

		expect(calls.compact).toEqual([{ sessionID: "s-1" }]);
		expect(result.content).toContain("already pending");
	});

	test("an unexpected error returns a failure instead of throwing", async () => {
		const { session } = sessionDouble({
			compactError: new Error("socket exploded"),
		});
		const result = await compactContextTool(session).execute(
			{ message: "Continue." },
			toolContext("s-1"),
		);

		expect(typeof result.content).toBe("string");
		expect(result.content).toContain("failed");
	});

	test("a missing or empty message is rejected before touching the session", async () => {
		const { session, calls } = sessionDouble();
		const tool = compactContextTool(session);
		const empty = await tool.execute({ message: "" }, toolContext("s-1"));
		const absent = await tool.execute({}, toolContext("s-1"));

		expect(calls.order).toEqual([]);
		expect(empty.content).toContain("message");
		expect(absent.content).toContain("message");
	});

	test("a missing calling session is rejected before touching the session", async () => {
		const { session, calls } = sessionDouble();
		const result = await compactContextTool(session).execute(
			{ message: "Continue." },
			{},
		);

		expect(calls.order).toEqual([]);
		expect(result.content).toContain("session");
	});

	test("a host without compact and prompt returns a failure", async () => {
		const result = await compactContextTool({}).execute(
			{ message: "Continue." },
			toolContext("s-1"),
		);

		expect(result.content).toContain("does not support");
	});
});
