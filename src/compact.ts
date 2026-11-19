/**
 * Session identity comes from the tool context, never from the model-supplied
 * input.
 */

import type { SessionCommands, ToolDefinition, ToolResult } from "./types";

const result = (content: string): ToolResult => ({ content });

/** Identify a conflict by its tag or name without importing an OpenCode SDK. */
const errorTag = (err: unknown): string => {
	if (typeof err !== "object" || err === null) return "";
	const { _tag, name } = err as { _tag?: unknown; name?: unknown };
	return typeof _tag === "string" ? _tag : typeof name === "string" ? name : "";
};

export function compactContextTool(session: SessionCommands): ToolDefinition {
	return {
		name: "compact_context",
		description:
			"Compact the current session and post a continuation message after the summary.",
		input: {
			type: "object",
			properties: { message: { type: "string" } },
			required: ["message"],
		},
		async execute(input, context): Promise<ToolResult> {
			const message = (input as { message?: unknown } | undefined)?.message;
			if (typeof message !== "string" || message.trim().length === 0) {
				return result("compact_context requires a non-empty message.");
			}
			const sessionID = context.sessionID;
			if (typeof sessionID !== "string" || !sessionID) {
				return result("compact_context has no calling session.");
			}
			if (
				typeof session.compact !== "function" ||
				typeof session.prompt !== "function"
			) {
				return result(
					"This OpenCode host does not support session compaction.",
				);
			}

			try {
				await session.compact({ sessionID });
			} catch (err) {
				return result(
					errorTag(err) === "CompactionConflictError"
						? "Compaction already pending; retry."
						: "Compaction failed.",
				);
			}

			try {
				await session.prompt({ sessionID, text: message, delivery: "steer" });
			} catch (err) {
				return result(
					errorTag(err) === "PromptConflictError"
						? "Prompt already pending; retry."
						: "Continuation prompt failed.",
				);
			}

			return result("Compaction requested; continuation queued.");
		},
	};
}
