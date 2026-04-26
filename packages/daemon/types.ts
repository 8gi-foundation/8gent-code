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

// ============================================================
// Dispatch protocol (issue #1896)
// ============================================================

/**
 * Capability tiers a surface can hold for dispatch. Defined here (the
 * shared types module) so dispatch.ts and permissions/dispatch-policy.ts
 * can both import it without a runtime cycle.
 */
export type DispatchCapability = "read" | "write_basic" | "write_full" | "admin";

/** @deprecated Use DispatchCapability. Retained briefly for in-flight callers. */
export type DispatchCapabilityWire = DispatchCapability;

/** Inbound message: register a surface for dispatch. */
export interface DispatchRegisterInbound {
	type: "dispatch:register";
	token: string;
	/** Pre-shared surface_id; daemon validates against token claims. */
	surface_id?: string;
}

/** Inbound: send a dispatch envelope. */
export interface DispatchSendInbound {
	type: "dispatch:send";
	dispatch_id: string;
	originating_channel: DaemonChannel;
	target_channel: DaemonChannel | "auto";
	target_surface_id?: string | null;
	correlation_id: string;
	replay_to: DaemonChannel[];
	intent: string;
	capability_required: DispatchCapabilityWire;
}

/** Inbound: subscribe (without dispatching) to a correlation_id, e.g. an os web tab listening for replies. */
export interface DispatchSubscribeInbound {
	type: "dispatch:subscribe";
	correlation_id: string;
}

/** Inbound: ping. */
export interface DispatchPingInbound {
	type: "ping";
}

export type DispatchInbound =
	| DispatchRegisterInbound
	| DispatchSendInbound
	| DispatchSubscribeInbound
	| DispatchPingInbound;

/** Outbound: registration ack. */
export interface DispatchRegisteredOutbound {
	protocol_version: typeof PROTOCOL_VERSION;
	type: "dispatch:registered";
	surface_id: string;
	channel: DaemonChannel;
	capabilities: DispatchCapabilityWire[];
}

/** Outbound: dispatch was accepted (or rejected with code). */
export interface DispatchAckOutbound {
	protocol_version: typeof PROTOCOL_VERSION;
	type: "dispatch:ack";
	dispatch_id: string;
	correlation_id: string;
	ok: boolean;
	error?: string;
	code?: string;
	retry_after_ms?: number;
	session_id?: string;
	target_channel?: DaemonChannel;
	target_surface_id?: string | null;
}

/** Outbound: streamed event for a dispatch. */
export interface DispatchEventOutbound {
	protocol_version: typeof PROTOCOL_VERSION;
	type: "dispatch:event";
	dispatch_id: string;
	correlation_id: string;
	originating_channel: DaemonChannel;
	target_channel: DaemonChannel;
	dispatch_source: DaemonChannel;
	event: {
		kind: "accepted" | "stream" | "tool_call" | "tool_result" | "error" | "done";
		[key: string]: unknown;
	};
}

/** Outbound: error not tied to a dispatch (auth fail, malformed message). */
export interface DispatchErrorOutbound {
	protocol_version: typeof PROTOCOL_VERSION;
	type: "dispatch:error";
	error: string;
	code: string;
}
