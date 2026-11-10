/** The RPC contract the sidebar reads context state through. */
export const RPC_ID = "context-watch";

export const Contract = {
	id: RPC_ID,
	methods: {
		status: {
			input: {
				type: "object",
				properties: { sessionID: { type: "string" } },
				required: ["sessionID"],
				additionalProperties: false,
			},
			output: {
				type: "object",
				properties: {
					ok: { type: "boolean" },
					status: { type: "object", additionalProperties: true },
				},
				required: ["ok"],
				additionalProperties: false,
			},
		},
	},
	events: {
		changed: {
			schema: {
				type: "object",
				properties: {
					sessionID: { type: "string" },
					status: { type: "object", additionalProperties: true },
				},
				required: ["sessionID", "status"],
				additionalProperties: false,
			},
		},
	},
} as const;
