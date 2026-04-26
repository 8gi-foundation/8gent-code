/**
 * Computer-channel WebSocket route.
 *
 * Mounts at `ws://<host>:<port>/computer`. Each connection owns one session in
 * the AgentPool tagged `channel=computer`. Loopback-only in v0 (the gateway
 * rejects non-127.0.0.1 peers before reaching this module).
 *
 * The streaming protocol is documented in docs/specs/DAEMON-PROTOCOL.md.
 * Every outbound message carries `protocol_version: 1`.
 */

import type { AgentPool } from "../agent-pool";
import { type EventName, bus } from "../events";
import {
	type ChannelInbound,
	type ChannelOutbound,
	PROTOCOL_VERSION,
	type StreamEvent,
} from "../types";

/** Minimum surface we need from the underlying Bun.ServerWebSocket. */
export interface ComputerWS {
	send(data: string | ArrayBufferView | ArrayBuffer): number | -1 | void;
	close(code?: number, reason?: string): void;
	readyState?: number;
}

interface ComputerRouteState {
	id: string;
	channel: string;
	sessionId: string | null;
	authenticated: boolean;
	isComputerRoute?: boolean;
}

/** 5-min idle timeout per the issue (longer per-session cap is on the pool). */
const ROUTE_IDLE_MS = 5 * 60 * 1000;

const idleTimers = new WeakMap<ComputerWS, ReturnType<typeof setTimeout>>();
/** Track which bus subscriptions belong to which socket so we can clean up. */
const socketSubs = new WeakMap<ComputerWS, number[]>();

function envelope(msg: ChannelOutbound): string {
	return JSON.stringify({ ...msg, protocol_version: PROTOCOL_VERSION });
}

function sendEvent(ws: ComputerWS, ev: StreamEvent): void {
	try {
		ws.send(
			envelope({
				protocol_version: PROTOCOL_VERSION,
				type: "event",
				event: ev,
			}),
		);
	} catch {
		// Client gone; reaper will clean up.
	}
}

function sendAck(ws: ComputerWS, payload: unknown): void {
	try {
		ws.send(
			envelope({ protocol_version: PROTOCOL_VERSION, type: "ack", payload }),
		);
	} catch {}
}

function sendError(ws: ComputerWS, message: string): void {
	try {
		ws.send(
			envelope({
				protocol_version: PROTOCOL_VERSION,
				type: "error",
				payload: { message },
			}),
		);
	} catch {}
}

function resetIdleTimer(ws: ComputerWS, state: ComputerRouteState): void {
	const existing = idleTimers.get(ws);
	if (existing) clearTimeout(existing);
	const t = setTimeout(() => {
		if (state.sessionId) {
			sendEvent(ws, {
				kind: "done",
				sessionId: state.sessionId,
				reason: "idle-timeout",
			});
		}
		try {
			ws.close(1000, "idle");
		} catch {}
	}, ROUTE_IDLE_MS);
	idleTimers.set(ws, t);
}

function generateSessionId(): string {
	return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const TOOL_CALL_IDS = new WeakMap<object, Map<string, string>>();

/** Wire bus events for a session into this socket as StreamEvents. */
function subscribeBus(ws: ComputerWS, sessionId: string): void {
	// Per-session call-id allocator so tool_call/tool_result can be paired.
	const callIds = new Map<string, string>();
	TOOL_CALL_IDS.set(ws as unknown as object, callIds);
	let nextCall = 0;

	const subs: number[] = [];
	const events: EventName[] = [
		"tool:start",
		"tool:result",
		"agent:thinking",
		"agent:stream",
		"agent:error",
		"approval:required",
		"session:end",
	];

	for (const ev of events) {
		const id = bus.on(ev, (payload: any) => {
			if (payload?.sessionId !== sessionId) return;
			switch (ev) {
				case "tool:start": {
					const callId = `tc_${(nextCall++).toString(36)}`;
					callIds.set(`${payload.tool}:${nextCall}`, callId);
					// Stash by tool name as fallback for the matching tool:result.
					callIds.set(payload.tool, callId);
					sendEvent(ws, {
						kind: "tool_call",
						sessionId,
						tool: payload.tool,
						input: payload.input,
						callId,
					});
					break;
				}
				case "tool:result": {
					const callId = callIds.get(payload.tool) ?? "tc_unknown";
					sendEvent(ws, {
						kind: "tool_result",
						sessionId,
						tool: payload.tool,
						output: payload.output,
						callId,
						durationMs: payload.durationMs ?? 0,
					});
					break;
				}
				case "agent:stream": {
					sendEvent(ws, {
						kind: "token",
						sessionId,
						chunk: String(payload.chunk ?? ""),
						final: payload.final === true,
					});
					break;
				}
				case "agent:error": {
					sendEvent(ws, {
						kind: "error",
						sessionId,
						error: String(payload.error ?? "unknown error"),
					});
					break;
				}
				case "approval:required": {
					sendEvent(ws, {
						kind: "approval_required",
						sessionId,
						tool: payload.tool,
						input: payload.input,
						requestId: payload.requestId,
					});
					break;
				}
				case "session:end": {
					const reason = payload.reason as StreamEvent extends {
						kind: "done";
						reason: infer R;
					}
						? R
						: never;
					sendEvent(ws, { kind: "done", sessionId, reason });
					break;
				}
				case "agent:thinking": {
					// Agent thinking is not in the spec taxonomy. Surface as a zero-token
					// chunk so clients can show a typing indicator without a new event kind.
					sendEvent(ws, { kind: "token", sessionId, chunk: "" });
					break;
				}
			}
		});
		subs.push(id);
	}

	socketSubs.set(ws, subs);
}

function unsubscribeBus(ws: ComputerWS): void {
	const subs = socketSubs.get(ws);
	if (!subs) return;
	for (const id of subs) bus.off(id);
	socketSubs.delete(ws);
}

/** Called from gateway.ws.open when the upgrade landed on /computer. */
export function handleComputerOpen(
	ws: ComputerWS,
	pool: AgentPool,
	state: ComputerRouteState,
): void {
	// Auto-create a session on connect so the round-trip stays one round less.
	const sessionId = generateSessionId();
	state.sessionId = sessionId;
	state.channel = "computer";
	bus.emit("session:start", { sessionId, channel: "computer" });
	setTimeout(() => {
		try {
			pool.createSession(sessionId, "computer");
		} catch (err) {
			sendError(
				ws,
				`failed to create session: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}, 0);
	subscribeBus(ws, sessionId);
	sendAck(ws, { type: "session:created", sessionId, channel: "computer" });
	resetIdleTimer(ws, state);
}

/** Called from gateway.ws.message for /computer connections. */
export function handleComputerMessage(
	ws: ComputerWS,
	pool: AgentPool,
	state: ComputerRouteState,
	raw: string,
): void {
	let msg: ChannelInbound;
	try {
		msg = JSON.parse(raw) as ChannelInbound;
	} catch {
		sendError(ws, "invalid JSON");
		return;
	}

	resetIdleTimer(ws, state);

	switch (msg.type) {
		case "ping": {
			sendAck(ws, { type: "pong" });
			return;
		}

		case "intent": {
			const sid = state.sessionId;
			const text = (msg.text ?? "").trim();
			if (!sid) {
				sendError(ws, "no active session");
				return;
			}
			if (!text) {
				sendError(ws, "intent text is empty");
				return;
			}
			// Fire-and-forget. Stream events flow back via the bus subscription.
			pool
				.chat(sid, text)
				.then(() =>
					bus.emit("session:end", { sessionId: sid, reason: "turn-complete" }),
				)
				.catch((err) => {
					bus.emit("agent:error", {
						sessionId: sid,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			return;
		}

		case "approval:response": {
			if (!msg.requestId) {
				sendError(ws, "approval:response missing requestId");
				return;
			}
			bus.emit("approval:required", {
				sessionId: state.sessionId ?? "unknown",
				tool: "approval-response",
				input: { requestId: msg.requestId, approved: !!msg.approved },
				requestId: msg.requestId,
			});
			return;
		}

		case "session:destroy": {
			if (state.sessionId) {
				pool.destroySession(state.sessionId);
				bus.emit("session:end", {
					sessionId: state.sessionId,
					reason: "client-destroy",
				});
				state.sessionId = null;
			}
			try {
				ws.close(1000, "destroyed");
			} catch {}
			return;
		}

		default:
			sendError(
				ws,
				`unknown message type: ${(msg as { type?: string }).type ?? "<missing>"}`,
			);
	}
}

/** Called from gateway.ws.close for /computer connections. */
export function handleComputerClose(
	pool: AgentPool,
	state: ComputerRouteState,
): void {
	if (state.sessionId) {
		bus.emit("session:end", {
			sessionId: state.sessionId,
			reason: "client-disconnect",
		});
	}
}

/** Test hook - exposed only for the smoke test to flush bus subs. */
export function _testCleanup(ws: ComputerWS): void {
	unsubscribeBus(ws);
	const t = idleTimers.get(ws);
	if (t) clearTimeout(t);
	idleTimers.delete(ws);
}
