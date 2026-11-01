/** A scripted model for the demo: replays demo-script.json, picked by the transcript alone. No network. */
export interface ToolCall {
	id: string;
	name: string;
	args: unknown;
}
export type Message =
	| { role: "user"; content: string }
	| { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
	| { role: "toolResult"; callId: string; text: string; isError?: boolean };
export interface Reply {
	text?: string;
	toolCalls?: ToolCall[];
}
export interface Provider {
	next(messages: Message[]): Promise<Reply>;
}

/** `steps[i]` answers a conversation holding i tool results; the last step repeats. */
export function scriptedProvider(steps: Reply[]): Provider {
	return {
		async next(messages) {
			const results = messages.filter((m) => m.role === "toolResult").length;
			return steps[Math.min(results, steps.length - 1)] ?? { text: "" };
		},
	};
}
