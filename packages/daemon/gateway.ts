/**
 * Gateway - WebSocket server for the daemon.
 *
 * Accepts connections from OS frontend, Telegram, Discord, etc.
 * Routes messages to the AgentPool, broadcasts agent events to clients.
 */

import { logAccess } from "../audit/index";
import type { LogAccessInput } from "../audit/types";
import type { AgentPool } from "./agent-pool";
import { type CronJob, addJob, getJobs, removeJob } from "./cron";
import { type EventName, bus } from "./events";
import {
	type ComputerWS,
	handleComputerClose,
	handleComputerMessage,
	handleComputerOpen,
} from "./routes/computer";

export interface GatewayConfig {
	port: number;
	authToken: string | null; // null = no auth required
	pool: AgentPool;
}

interface ClientState {
	id: string;
	channel: string; // "os", "telegram", "discord", "api", "computer"
	sessionId: string | null;
	authenticated: boolean;
	/** Marks a connection upgraded on the /computer route. */
	isComputerRoute?: boolean;
}

type InboundMessage =
	| { type: "auth"; token: string }
	| { type: "session:create"; channel: string }
	| { type: "session:resume"; sessionId: string }
	| { type: "session:compact"; sessionId: string }
	| { type: "session:destroy"; sessionId: string }
	| { type: "prompt"; text: string }
	| { type: "sessions:list" }
	| { type: "cron:list" }
	| { type: "cron:add"; job: unknown }
	| { type: "cron:remove"; jobId: string }
	| { type: "health" }
	| { type: "approval:response"; requestId: string; approved: boolean }
	| { type: "ping" };

type OutboundMessage =
	| { type: "auth:ok" }
	| { type: "auth:fail" }
	| { type: "session:created"; sessionId: string }
	| { type: "session:resumed"; sessionId: string }
	| { type: "sessions:list"; sessions: unknown[] }
	| { type: "cron:list"; jobs: unknown[] }
	| { type: "cron:added"; jobId: string }
	| { type: "cron:removed"; jobId: string }
	| { type: "health"; data: unknown }
	| { type: "event"; event: EventName; payload: unknown }
	| { type: "error"; message: string }
	| { type: "pong" };

const clients = new Map<any, ClientState>();
let nextClientId = 0;

function generateSessionId(): string {
	return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function send(ws: any, msg: OutboundMessage): void {
	try {
		ws.send(JSON.stringify(msg));
	} catch {
		// Client disconnected
	}
}

function broadcastToSession(sessionId: string, event: EventName, payload: unknown): void {
	for (const [ws, state] of clients) {
		// Computer-route clients use the v1.1 protocol envelope; the legacy v1.0
		// broadcast skips them so they only see the typed StreamEvent stream.
		if (state.isComputerRoute) continue;
		if (state.sessionId === sessionId && state.authenticated) {
			send(ws, { type: "event", event, payload });
		}
	}
}

function handleMessage(ws: any, config: GatewayConfig, raw: string): void {
	const state = clients.get(ws);
	if (!state) return;

	let msg: InboundMessage;
	try {
		msg = JSON.parse(raw);
	} catch {
		send(ws, { type: "error", message: "invalid JSON" });
		return;
	}

	// Auth check
	if (config.authToken && !state.authenticated) {
		if (msg.type === "auth") {
			if (msg.token === config.authToken) {
				state.authenticated = true;
				send(ws, { type: "auth:ok" });
			} else {
				send(ws, { type: "auth:fail" });
			}
			return;
		}
		send(ws, { type: "error", message: "not authenticated" });
		return;
	}

	const pool = config.pool;

	switch (msg.type) {
		case "ping":
			send(ws, { type: "pong" });
			break;

		case "session:create": {
			const sessionId = generateSessionId();
			state.sessionId = sessionId;
			state.channel = msg.channel || "api";

			// Respond to the client first, then emit events and create agent
			send(ws, { type: "session:created", sessionId });
			bus.emit("session:start", { sessionId, channel: state.channel });

			// Create Agent instance async (constructor does blocking AST indexing)
			setTimeout(() => pool.createSession(sessionId, state.channel), 0);
			break;
		}

		case "session:resume": {
			state.sessionId = msg.sessionId;

			// If pool doesn't have this session, create a new agent for it
			if (!pool.hasSession(msg.sessionId)) {
				pool.createSession(msg.sessionId, state.channel);
			}

			bus.emit("session:start", {
				sessionId: msg.sessionId,
				channel: state.channel,
			});
			send(ws, { type: "session:resumed", sessionId: msg.sessionId });
			break;
		}

		case "session:compact": {
			if (msg.sessionId) {
				bus.emit("agent:thinking", { sessionId: msg.sessionId });
			}
			break;
		}

		case "session:destroy": {
			if (msg.sessionId) {
				pool.destroySession(msg.sessionId);
				bus.emit("session:end", {
					sessionId: msg.sessionId,
					reason: "client-destroy",
				});
				for (const [, s] of clients) {
					if (s.sessionId === msg.sessionId) s.sessionId = null;
				}
			}
			break;
		}

		case "prompt": {
			if (!state.sessionId) {
				send(ws, { type: "error", message: "no active session" });
				return;
			}

			// Route the message to the agent via the pool
			// This runs async - events will be broadcast as the agent works
			const sid = state.sessionId;
			pool
				.chat(sid, msg.text)
				.then((response) => {
					// Final response - signal session:end for this turn
					bus.emit("session:end", { sessionId: sid, reason: "turn-complete" });
				})
				.catch((err) => {
					bus.emit("agent:error", {
						sessionId: sid,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			break;
		}

		case "sessions:list": {
			send(ws, { type: "sessions:list", sessions: pool.getActiveSessions() });
			break;
		}

		case "cron:list": {
			send(ws, { type: "cron:list", jobs: getJobs() });
			break;
		}

		case "cron:add": {
			const job = msg.job as CronJob;
			if (!job || !job.id || !job.name) {
				send(ws, {
					type: "error",
					message: "invalid cron job: requires id, name, expression, type, payload",
				});
				break;
			}
			addJob(job);
			send(ws, { type: "cron:added", jobId: job.id });
			break;
		}

		case "cron:remove": {
			const removed = removeJob(msg.jobId);
			if (removed) {
				send(ws, { type: "cron:removed", jobId: msg.jobId });
			} else {
				send(ws, { type: "error", message: `cron job ${msg.jobId} not found` });
			}
			break;
		}

		case "approval:response": {
			// Route approval decision back through the event bus
			bus.emit("approval:required", {
				sessionId: state.sessionId || "unknown",
				tool: "approval-response",
				input: { requestId: msg.requestId, approved: msg.approved },
				requestId: msg.requestId,
			});
			break;
		}

		case "health": {
			send(ws, {
				type: "health",
				data: {
					status: "ok",
					sessions: pool.size,
					uptime: process.uptime(),
					cronJobs: getJobs().length,
				},
			});
			break;
		}

		default:
			send(ws, { type: "error", message: "unknown message type" });
	}
}

/** Subscribe the gateway to all bus events and broadcast to relevant sessions */
function subscribeToBus(): void {
	const events: EventName[] = [
		"tool:start",
		"tool:result",
		"agent:thinking",
		"agent:stream",
		"agent:error",
		"memory:saved",
		"approval:required",
		"session:start",
		"session:end",
	];
	for (const event of events) {
		bus.on(event, (payload: any) => {
			if (payload.sessionId) {
				broadcastToSession(payload.sessionId, event, payload);
			}
		});
	}
}

async function handleAuditAccess(req: Request, config: GatewayConfig): Promise<Response> {
	if (config.authToken) {
		const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
		if (provided !== config.authToken) {
			return Response.json({ error: "unauthorized" }, { status: 401 });
		}
	}
	let body: Partial<LogAccessInput>;
	try {
		body = (await req.json()) as Partial<LogAccessInput>;
	} catch {
		return Response.json({ error: "invalid JSON" }, { status: 400 });
	}
	const { actor, actorKind, targetTable, targetId, operation, reason, sessionId } = body;
	if (!actor || !actorKind || !targetTable || !targetId || !operation || !reason) {
		return Response.json({ error: "missing required field" }, { status: 400 });
	}
	try {
		const id = logAccess({
			actor,
			actorKind,
			targetTable,
			targetId,
			operation,
			reason,
			sessionId: sessionId ?? null,
		});
		return Response.json({ id }, { status: 201 });
	} catch (err) {
		return Response.json({ error: (err as Error).message }, { status: 400 });
	}
}

export function startGateway(config: GatewayConfig): ReturnType<typeof Bun.serve> {
	subscribeToBus();

	// v0: the computer channel is loopback-only. We keep the global bind unchanged
	// (other channels still listen on 0.0.0.0) and reject non-loopback peers on
	// the /computer route. Set DAEMON_HOSTNAME=127.0.0.1 to lock everything down.
	const hostname = process.env.DAEMON_HOSTNAME || "0.0.0.0";

	const server = Bun.serve({
		port: config.port,
		hostname,
		fetch(req, server) {
			const url = new URL(req.url);

			// Tag computer-route upgrades so the websocket open handler can branch.
			if (url.pathname === "/computer") {
				const peer = (
					server as unknown as {
						requestIP?: (r: Request) => { address?: string } | null;
					}
				).requestIP?.(req);
				const ip = peer?.address ?? "";
				const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
				if (!loopback) {
					return new Response("forbidden: computer channel is loopback-only in v0", {
						status: 403,
					});
				}
				// Bun's upgrade typings vary across versions; cast the data option.
				if (
					(server.upgrade as (r: Request, opts?: any) => boolean)(req, {
						data: { route: "computer" },
					})
				) {
					return undefined;
				}
				return new Response("WebSocket upgrade required", { status: 426 });
			}

			if (server.upgrade(req)) return undefined;

			// Health check endpoint
			if (url.pathname === "/health") {
				return Response.json({
					status: "ok",
					sessions: config.pool.size,
					uptime: process.uptime(),
				});
			}

			// Per-channel pool status for the ops dashboard.
			if (url.pathname === "/ops/agent-pool/status") {
				return Response.json(config.pool.getStatus());
			}

			// Access audit log endpoint (DPIA G7). POST-only, metadata only.
			if (url.pathname === "/audit/access" && req.method === "POST") {
				return handleAuditAccess(req, config);
			}

			return new Response(`Eight Daemon - ws://localhost:${config.port}`, {
				status: 200,
			});
		},
		websocket: {
			open(ws) {
				const id = `c_${nextClientId++}`;
				const data = (ws as unknown as { data?: { route?: string } }).data;
				const isComputer = data?.route === "computer";
				const state: ClientState = {
					id,
					channel: isComputer ? "computer" : "api",
					sessionId: null,
					authenticated: !config.authToken,
					isComputerRoute: isComputer,
				};
				clients.set(ws, state);
				console.log(`[gateway] client ${id} connected${isComputer ? " (computer)" : ""}`);
				if (isComputer) {
					handleComputerOpen(ws as unknown as ComputerWS, config.pool, state);
				}
			},
			message(ws, raw) {
				const state = clients.get(ws);
				const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
				if (state?.isComputerRoute) {
					handleComputerMessage(ws as unknown as ComputerWS, config.pool, state, text);
					return;
				}
				handleMessage(ws, config, text);
			},
			close(ws) {
				const state = clients.get(ws);
				if (state) {
					console.log(`[gateway] client ${state.id} disconnected`);
					if (state.isComputerRoute) {
						handleComputerClose(config.pool, state);
					} else if (state.sessionId) {
						bus.emit("session:end", {
							sessionId: state.sessionId,
							reason: "client-disconnect",
						});
					}
				}
				clients.delete(ws);
			},
		},
	});

	console.log(`[gateway] WebSocket server listening on ws://${hostname}:${config.port}`);
	console.log(`[gateway] computer channel: ws://${hostname}:${config.port}/computer`);
	return server;
}
