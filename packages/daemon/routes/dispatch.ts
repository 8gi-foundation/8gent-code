/**
 * Dispatch WebSocket route (`ws://<host>:<port>/dispatch`).
 *
 * Surfaces connect, register with a scoped token, then dispatch
 * commands to other surfaces (or to the daemon itself, which executes
 * via AgentPool). Result events fan out to the originator AND any
 * surfaces that asked to subscribe to the correlation_id.
 *
 * Spec: docs/specs/DAEMON-PROTOCOL.md (Dispatch section)
 */

import { intersectChannelCaps } from "../../permissions/dispatch-policy";
import type { AgentPool } from "../agent-pool";
import type {
	DispatchEnvelope,
	DispatchEventFrame,
	DispatchHub,
	DispatchLedger,
	DispatchRateLimiter,
	DispatchRouter,
	SurfaceRegistration,
	SurfaceRegistry,
	TokenVerifier,
} from "../dispatch";
import { type EventName, bus } from "../events";
import {
	type DispatchAckOutbound,
	type DispatchErrorOutbound,
	type DispatchEventOutbound,
	type DispatchInbound,
	type DispatchRegisteredOutbound,
	PROTOCOL_VERSION,
} from "../types";

export interface DispatchWS {
	send(data: string | ArrayBufferView | ArrayBuffer): number | -1 | undefined;
	close(code?: number, reason?: string): void;
}

interface DispatchRouteState {
	id: string;
	surfaceId: string | null;
	authenticated: boolean;
	/** Correlation ids this socket is observing - cleaned up on close. */
	observedCorrelations: Map<string, () => void>;
	/** Bus subscriptions for active executions originated by this socket. */
	busSubs: Map<string, number[]>;
}

const stateBySocket = new WeakMap<DispatchWS, DispatchRouteState>();
let nextClientId = 0;

export interface DispatchRouteDeps {
	pool: AgentPool;
	registry: SurfaceRegistry;
	router: DispatchRouter;
	ledger: DispatchLedger;
	rateLimiter: DispatchRateLimiter;
	verifier: TokenVerifier;
	hub: DispatchHub;
}

function send(ws: DispatchWS, msg: object): void {
	try {
		ws.send(JSON.stringify(msg));
	} catch {
		// Client gone.
	}
}

function sendError(ws: DispatchWS, error: string, code: string): void {
	const out: DispatchErrorOutbound = {
		protocol_version: PROTOCOL_VERSION,
		type: "dispatch:error",
		error,
		code,
	};
	send(ws, out);
}

/** Route a parsed message into the right handler. */
export function handleDispatchMessage(ws: DispatchWS, deps: DispatchRouteDeps, raw: string): void {
	const state = stateBySocket.get(ws);
	if (!state) return;

	let msg: DispatchInbound;
	try {
		msg = JSON.parse(raw) as DispatchInbound;
	} catch {
		sendError(ws, "invalid JSON", "bad_request");
		return;
	}

	switch (msg.type) {
		case "ping":
			send(ws, { protocol_version: PROTOCOL_VERSION, type: "pong" });
			return;

		case "dispatch:register":
			handleRegister(ws, state, deps, msg);
			return;

		case "dispatch:send":
			void handleSend(ws, state, deps, msg);
			return;

		case "dispatch:subscribe":
			handleSubscribe(ws, state, deps, msg);
			return;

		default:
			sendError(ws, `unknown message type: ${(msg as { type?: string }).type}`, "unknown_type");
	}
}

function handleRegister(
	ws: DispatchWS,
	state: DispatchRouteState,
	deps: DispatchRouteDeps,
	msg: Extract<DispatchInbound, { type: "dispatch:register" }>,
): void {
	const claims = deps.verifier.verify(msg.token);
	if (!claims) {
		sendError(ws, "token verification failed", "unauthenticated");
		return;
	}
	if (msg.surface_id && msg.surface_id !== claims.surfaceId) {
		sendError(ws, "surface_id does not match token claims", "claim_mismatch");
		return;
	}

	// Intersect claimed caps with the channel ceiling to enforce the
	// per-channel default capability table.
	const effectiveCaps = intersectChannelCaps(claims.channel, claims.capabilities);

	const reg: SurfaceRegistration = {
		surfaceId: claims.surfaceId,
		channel: claims.channel,
		userId: claims.userId,
		capabilities: effectiveCaps,
		token: msg.token,
		registeredAt: Date.now(),
		lastActiveAt: Date.now(),
	};
	deps.registry.register(reg);
	state.surfaceId = reg.surfaceId;
	state.authenticated = true;

	const out: DispatchRegisteredOutbound = {
		protocol_version: PROTOCOL_VERSION,
		type: "dispatch:registered",
		surface_id: reg.surfaceId,
		channel: reg.channel,
		capabilities: effectiveCaps,
	};
	send(ws, out);
}

async function handleSend(
	ws: DispatchWS,
	state: DispatchRouteState,
	deps: DispatchRouteDeps,
	msg: Extract<DispatchInbound, { type: "dispatch:send" }>,
): Promise<void> {
	if (!state.authenticated || !state.surfaceId) {
		sendError(ws, "not registered - send dispatch:register first", "unauthenticated");
		return;
	}

	const reg = deps.registry.get(state.surfaceId);
	if (!reg) {
		sendError(ws, "surface no longer registered", "stale_registration");
		return;
	}

	const env: DispatchEnvelope = {
		dispatchId: msg.dispatch_id,
		originatingChannel: msg.originating_channel,
		targetChannel: msg.target_channel,
		targetSurfaceId: msg.target_surface_id ?? null,
		correlationId: msg.correlation_id,
		replayTo: msg.replay_to ?? [],
		intent: msg.intent,
		capabilityRequired: msg.capability_required,
	};

	// Subscribe the originator and any replay_to subscribers to the
	// correlation. The router emits an "accepted" frame on success;
	// per-event streaming flows in via the bus bridge below.
	const originSink = (frame: DispatchEventFrame) => sendDispatchEvent(ws, frame);
	const unsubOrigin = deps.hub.subscribe(env.correlationId, originSink);
	state.observedCorrelations.set(env.correlationId, unsubOrigin);

	// For each replay_to channel, fan out to all surfaces of the same
	// user on that channel that have a live socket on this route.
	subscribeReplayChannels(env, reg, deps);

	const result = await deps.router.dispatch(env, reg);

	const ack: DispatchAckOutbound = {
		protocol_version: PROTOCOL_VERSION,
		type: "dispatch:ack",
		dispatch_id: env.dispatchId,
		correlation_id: env.correlationId,
		ok: result.ok,
	};
	if (result.ok) {
		ack.session_id = result.sessionId;
		ack.target_channel = result.targetChannel;
		ack.target_surface_id = result.targetSurfaceId ?? null;
	} else {
		ack.error = result.error;
		ack.code = result.code;
		if (result.retryAfterMs) ack.retry_after_ms = result.retryAfterMs;
	}
	send(ws, ack);

	// On failure, drop the subscription right away.
	if (!result.ok) {
		const u = state.observedCorrelations.get(env.correlationId);
		if (u) {
			u();
			state.observedCorrelations.delete(env.correlationId);
		}
		return;
	}

	// On success, bridge the agent-pool bus events on the executing
	// session into the dispatch hub. The route layer owns this bridge
	// because it's session-scoped.
	bridgeBusToHub(deps, env, result.sessionId, result.targetChannel, state);
}

function subscribeReplayChannels(
	env: DispatchEnvelope,
	originator: SurfaceRegistration,
	deps: DispatchRouteDeps,
): void {
	if (env.replayTo.length === 0) return;
	// For each replay channel, find connected surfaces in the registry
	// that share the user. Their sockets will already be subscribed via
	// dispatch:subscribe if they want events; the registry membership is
	// not enough on its own. We log a no-op when no subscribers exist
	// rather than failing the dispatch.
	const peers = deps.registry.byUser(originator.userId);
	for (const peer of peers) {
		if (peer.surfaceId === originator.surfaceId) continue;
		if (!env.replayTo.includes(peer.channel)) continue;
		// We can't know which socket belongs to which peer from the
		// registry alone; the peer subscribes via dispatch:subscribe.
		// This loop's job is just to keep the registry hot.
		deps.registry.touch(peer.surfaceId);
	}
}

function handleSubscribe(
	ws: DispatchWS,
	state: DispatchRouteState,
	deps: DispatchRouteDeps,
	msg: Extract<DispatchInbound, { type: "dispatch:subscribe" }>,
): void {
	if (!state.authenticated) {
		sendError(ws, "not registered", "unauthenticated");
		return;
	}
	const sink = (frame: DispatchEventFrame) => sendDispatchEvent(ws, frame);
	const unsub = deps.hub.subscribe(msg.correlation_id, sink);
	state.observedCorrelations.set(msg.correlation_id, unsub);
	send(ws, {
		protocol_version: PROTOCOL_VERSION,
		type: "dispatch:subscribed",
		correlation_id: msg.correlation_id,
	});
}

function sendDispatchEvent(ws: DispatchWS, frame: DispatchEventFrame): void {
	const out: DispatchEventOutbound = {
		protocol_version: PROTOCOL_VERSION,
		type: "dispatch:event",
		dispatch_id: frame.dispatchId,
		correlation_id: frame.correlationId,
		originating_channel: frame.originatingChannel,
		target_channel: frame.targetChannel,
		dispatch_source: frame.dispatchSource,
		event: frame.event,
	};
	send(ws, out);
}

/**
 * Bridge bus events from the executing session into the dispatch hub
 * so all subscribers (originator + replay_to peers) see the same
 * stream.
 */
function bridgeBusToHub(
	deps: DispatchRouteDeps,
	env: DispatchEnvelope,
	sessionId: string,
	targetChannel: import("../types").DaemonChannel,
	state: DispatchRouteState,
): void {
	const subs: number[] = [];
	const events: EventName[] = [
		"tool:start",
		"tool:result",
		"agent:stream",
		"agent:error",
		"session:end",
	];
	for (const ev of events) {
		const id = bus.on(ev, (payload: any) => {
			if (payload?.sessionId !== sessionId) return;
			let event: DispatchEventFrame["event"];
			switch (ev) {
				case "tool:start":
					event = {
						kind: "tool_call",
						tool: payload.tool,
						input: payload.input,
					};
					break;
				case "tool:result":
					event = {
						kind: "tool_result",
						tool: payload.tool,
						output: payload.output,
						durationMs: payload.durationMs ?? 0,
					};
					break;
				case "agent:stream":
					event = {
						kind: "stream",
						chunk: String(payload.chunk ?? ""),
						final: payload.final === true,
					};
					break;
				case "agent:error":
					event = { kind: "error", error: String(payload.error ?? "unknown error") };
					break;
				case "session:end":
					event = { kind: "done", reason: payload.reason };
					break;
				default:
					return;
			}
			deps.hub.emit({
				type: "dispatch:event",
				dispatchId: env.dispatchId,
				correlationId: env.correlationId,
				originatingChannel: env.originatingChannel,
				targetChannel,
				dispatchSource: env.originatingChannel,
				event,
			});
			// Tear down on done.
			if (event.kind === "done") {
				for (const subId of subs) bus.off(subId);
				state.busSubs.delete(env.correlationId);
			}
		});
		subs.push(id);
	}
	state.busSubs.set(env.correlationId, subs);
}

export function handleDispatchOpen(ws: DispatchWS): void {
	const id = `d_${nextClientId++}`;
	const state: DispatchRouteState = {
		id,
		surfaceId: null,
		authenticated: false,
		observedCorrelations: new Map(),
		busSubs: new Map(),
	};
	stateBySocket.set(ws, state);
	console.log(`[dispatch] client ${id} connected`);
}

export function handleDispatchClose(ws: DispatchWS, deps: DispatchRouteDeps): void {
	const state = stateBySocket.get(ws);
	if (!state) return;
	for (const unsub of state.observedCorrelations.values()) {
		try {
			unsub();
		} catch {}
	}
	for (const subList of state.busSubs.values()) {
		for (const id of subList) bus.off(id);
	}
	if (state.surfaceId) deps.registry.unregister(state.surfaceId);
	stateBySocket.delete(ws);
	console.log(`[dispatch] client ${state.id} disconnected`);
}

/** Test hook - returns the registry+hub state for a socket. */
export function _testGetState(ws: DispatchWS): DispatchRouteState | undefined {
	return stateBySocket.get(ws);
}
