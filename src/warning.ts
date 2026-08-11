import type { Message, Part } from "@opencode-ai/sdk";

/**
 * Warning module — the transient synthetic warning message.
 *
 * Builds the `role: "user"` synthetic message that carries the rendered
 * warning text into the provider's assembled context. The message is never
 * persisted; the caller pushes it into the current transform call's in-memory
 * array, so it must be produced on every step while above threshold.
 */

export interface OutputMessage {
	info: Message;
	parts: Part[];
}

/**
 * Build the synthetic user warning for a session, cloning agent/model
 * metadata from the last real user message when available so the injected
 * message looks like a normal user turn to the provider.
 */
export function createWarning(
	sessionID: string,
	text: string,
	lastUser: { info: Message } | undefined,
): OutputMessage {
	const stamp = Date.now().toString(36);
	const userInfo = lastUser?.info;
	const isUser = userInfo?.role === "user";
	return {
		info: {
			id: `msg_cw_${stamp}`,
			sessionID,
			role: "user",
			time: { created: Date.now() },
			agent: isUser ? userInfo.agent : "build",
			model:
				isUser && userInfo.model
					? userInfo.model
					: { providerID: "opencode", modelID: "context-watch" },
		},
		parts: [
			{
				id: `part_cw_${stamp}`,
				sessionID,
				messageID: `msg_cw_${stamp}`,
				type: "text",
				text,
				synthetic: true,
			},
		],
	};
}
