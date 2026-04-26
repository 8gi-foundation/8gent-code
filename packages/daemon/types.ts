/**
 * Daemon protocol types - shared by gateway, channel routes, and clients.
 *
 * The streaming event taxonomy below is the public contract documented in
 * docs/specs/DAEMON-PROTOCOL.md. Every outbound message carries
 * `protocol_version: 1` so clients can detect breakage early.
 */

export const PROTOCOL_VERSION = 1 as const;

/** Channels the daemon accepts. Must stay in sync with agent-pool.KNOWN_CHANNELS. */
export type DaemonChannel =
	| "os"
	| "app"
	| "telegram"
	| "discord"
	| "api"
	| "delegation"
	| "computer";

/** Streaming event taxonomy - what flows from daemon to client during a turn. */
export type StreamEvent =
	| { kind: "token"; sessionId: string; chunk: string; final?: boolean }
	| {
			kind: "tool_call";
			sessionId: string;
			tool: string;
			input: unknown;
			callId: string;
	  }
	| {
			kind: "tool_result";
			sessionId: string;
			tool: string;
			output: unknown;
			callId: string;
			durationMs: number;
	  }
	| {
			kind: "approval_required";
			sessionId: string;
			tool: string;
			input: unknown;
			requestId: string;
			reason?: string;
	  }
	| { kind: "error"; sessionId: string; error: string; recoverable?: boolean }
	| {
			kind: "done";
			sessionId: string;
			reason:
				| "turn-complete"
				| "client-disconnect"
				| "client-destroy"
				| "idle-timeout"
				| "channel-cap-evict";
	  };

/** Wire envelope for every server -> client message on a channel route. */
export interface ChannelOutbound {
	protocol_version: typeof PROTOCOL_VERSION;
	type: "event" | "ack" | "error";
	event?: StreamEvent;
	/** Free-form payload for non-event messages (session:created, ack, etc.). */
	payload?: unknown;
}

/** Wire envelope for every client -> server message. */
export interface ChannelInbound {
	protocol_version?: typeof PROTOCOL_VERSION;
	type: "intent" | "approval:response" | "session:destroy" | "ping";
	/** User-provided text for "intent". */
	text?: string;
	requestId?: string;
	approved?: boolean;
}
