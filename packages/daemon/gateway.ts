/**
 * Gateway - WebSocket server for the daemon.
 *
 * Accepts connections from OS frontend, Telegram, Discord, etc.
 * Routes messages to the AgentPool, broadcasts agent events to clients.
 */

import { logAccess } from "../audit/index";
import type { LogAccessInput } from "../audit/types";
import { SPEAK_URL_RE, TableStore, handleTableAudioHttp, handleTableSpeakHttp, installTablePolicies } from "../table/index";
import { handleHarnessRoute } from "../harness/http";
import type { AgentPool } from "./agent-pool";
import { type CronJob, addJob, getJobs, removeJob } from "./cron";
import type {
	DispatchHub,
	DispatchLedger,
	DispatchRateLimiter,
	DispatchRouter,
	SurfaceRegistry,
	TokenVerifier,
} from "./dispatch";
import { type EventName, bus } from "./events";
import { type GoalManager, type GoalRpcOutbound, handleGoalRpc } from "./goal-rpc";
import {
	type ComputerWS,
	handleComputerClose,
	handleComputerMessage,
	handleComputerOpen,
} from "./routes/computer";
import {
	type DispatchWS,
	handleDispatchClose,
	handleDispatchMessage,
	handleDispatchOpen,
} from "./routes/dispatch";
import {
	type StoreWS,
	ensureServerToken,
	handleStoreClose,
	handleStoreMessage,
	handleStoreOpen,
} from "./routes/store/index";
import { handleStageHttp } from "./huddle-stage";
import { bindParticipant, handleTableFrame, isTableFrame } from "./table-routes";
import {
	type TimeTravelInbound,
	type TimeTravelOutbound,
	handleTimeTravel,
} from "./timetravel-verbs";

export interface GatewayConfig {
	port: number;
	authToken: string | null; // null = no auth required
	pool: AgentPool;
	/** Optional dispatch deps. When omitted, /dispatch route returns 503. */
	dispatch?: {
		registry: SurfaceRegistry;
		router: DispatchRouter;
		ledger: DispatchLedger;
		rateLimiter: DispatchRateLimiter;
		verifier: TokenVerifier;
		hub: DispatchHub;
	};
	/** Optional goal-loop manager. When omitted, goal.* RPCs return an error. */
	goal?: GoalManager;
}

interface ClientState {
	id: string;
	channel: string; // "os", "telegram", "discord", "api", "computer"
	sessionId: string | null;
	authenticated: boolean;
	/** Marks a connection upgraded on the /computer route. */
	isComputerRoute?: boolean;
	/** Marks a connection upgraded on the /dispatch route. */
	isDispatchRoute?: boolean;
	/** Marks a connection upgraded on the /store route. */
	isStoreRoute?: boolean;
	/** Table channels this connection is subscribed to (message:appended fan-out). */
	subscribedChannels: Set<string>;
	/** The participant this connection acts as for Table ("human:<handle>"). Pinned
	 *  once via bindParticipant(); never reassigned on the same connection. */
	participantId?: string;
	/** Peer address captured at open, for the Table per-frame loopback guard (F1). */
	remoteAddress?: string;
}

type InboundMessage =
	| { type: "auth"; token: string; participantId?: string }
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
	| { type: "ping" }
	| TimeTravelInbound;

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
	| { type: "pong" }
	| TimeTravelOutbound;

const clients = new Map<any, ClientState>();
let nextClientId = 0;

/**
 * Shared Table store, constructed lazily on first table frame. Opens the
 * bun:sqlite DB at ~/.8gent/table/table.db and the signed Table ledger. Policies
 * are installed once at gateway boot (installTablePolicies() in startGateway).
 */
let tableStore: TableStore | null = null;
function getTableStore(): TableStore {
	if (!tableStore) tableStore = new TableStore();
	return tableStore;
}

/** Fan-out a Table frame to every connection subscribed to `channelId`. */
function broadcastToChannel(channelId: string, frame: unknown): void {
	for (const [ws, s] of clients) {
		if (!s.authenticated) continue;
		if (s.subscribedChannels.has(channelId)) {
			try {
				ws.send(JSON.stringify(frame));
			} catch {
				// client disconnected
			}
		}
	}
}

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
				// F2: bind + PIN the Table participant to a verified human identity
				// BEFORE authenticating. A bad/agent/duplicate declaration fails auth,
				// so one connection can never post as arbitrary different participants.
				if (msg.participantId) {
					const r = bindParticipant(state, msg.participantId);
					if (!r.ok) {
						send(ws, { type: "error", message: `participant rejected: ${r.error}` });
						send(ws, { type: "auth:fail" });
						return;
					}
				}
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

	// goal.* RPC interception. Fire-and-forget; handler emits responses
	// via the ws.send callback. Returns true if handled.
	if (typeof (msg as any).type === "string" && (msg as any).type.startsWith("goal.")) {
		if (!config.goal) {
			send(ws, { type: "error", message: "goal-loop manager not configured" });
			return;
		}
		const sendGoal = (out: GoalRpcOutbound) => {
			try {
				ws.send(JSON.stringify(out));
			} catch {
				// client disconnected
			}
		};
		void handleGoalRpc(msg, { manager: config.goal, send: sendGoal });
		return;
	}

	// Table channel:* / message:* frame interception (contract §3). Delegated to
	// table-routes.ts, backed by the shared @8gent/table store. Untrusted channel
	// text never reaches a shell tool - the @mention flow hands it to the agent
	// as a data envelope and the only agent write is the ToolG8-gated post tool.
	if (isTableFrame((msg as { type?: unknown }).type)) {
		handleTableFrame(
			{
				store: getTableStore(),
				pool: config.pool,
				broadcast: broadcastToChannel,
				sendRaw: (frame) => {
					try {
						ws.send(JSON.stringify(frame));
					} catch {
						// client disconnected
					}
				},
				state,
			},
			msg as unknown as Record<string, unknown>,
		);
		return;
	}

	const pool = config.pool;

	switch (msg.type) {
		case "ping":
			send(ws, { type: "pong" });
			break;

		case "auth": {
			// Reached only in no-auth mode (the guarded auth handler above returns
			// early when config.authToken is set). A loopback client may declare its
			// Table participant without a token, but F2 still applies: only a
			// "human:<handle>" id, pinned once. A bad/agent/re-bind attempt is refused
			// so one connection cannot switch identity between posts.
			if (msg.participantId) {
				const r = bindParticipant(state, msg.participantId);
				if (!r.ok) {
					send(ws, { type: "error", message: `participant rejected: ${r.error}` });
					send(ws, { type: "auth:fail" });
					return;
				}
			}
			send(ws, { type: "auth:ok" });
			break;
		}

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

		case "timetravel:list":
		case "timetravel:rewind":
		case "timetravel:fork": {
			// Session time-travel verbs (#2757 step 2): list checkpoints,
			// rewind the live agent, or fork a new session from a checkpoint.
			const out = handleTimeTravel(msg, {
				pool,
				activeSessionId: state.sessionId,
				channel: state.channel,
			});
			if (out.type === "timetravel:forked") {
				// Bind this client to the fork so its next prompt continues there.
				state.sessionId = out.sessionId;
				bus.emit("session:start", {
					sessionId: out.sessionId,
					channel: state.channel,
				});
			}
			send(ws, out);
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

	// Install the Table deny-by-default policy set once (idempotent). Table
	// agents bind under the "__table__" scope; these rules block
	// run_command/network/write_file and explicitly allow only channel_post.
	installTablePolicies();

	// v0: the /computer route and Table frames are loopback-only. We keep the
	// global bind unchanged (other channels still listen on 0.0.0.0) and enforce
	// loopback PER-SURFACE: the /computer route rejects non-loopback peers at
	// upgrade, and Table channel:*/message:* frames are rejected per-frame in
	// table-routes (isLoopbackAddress) regardless of this global bind. Set
	// DAEMON_HOSTNAME=127.0.0.1 to lock every surface down.
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

			// /store route - JSON-RPC 2.0 over WS for session/kg/fs cross-host sharing.
			if (url.pathname === "/store") {
				// Eagerly create the token so first-time clients can pull it
				// from `~/.8gent/server.token`.
				ensureServerToken();
				if (
					(server.upgrade as (r: Request, opts?: any) => boolean)(req, {
						data: { route: "store" },
					})
				) {
					return undefined;
				}
				return new Response("WebSocket upgrade required", { status: 426 });
			}

			// /dispatch route - cross-surface remote dispatch.
			if (url.pathname === "/dispatch") {
				if (!config.dispatch) {
					return new Response("dispatch protocol not configured", { status: 503 });
				}
				if (
					(server.upgrade as (r: Request, opts?: any) => boolean)(req, {
						data: { route: "dispatch" },
					})
				) {
					return undefined;
				}
				return new Response("WebSocket upgrade required", { status: 426 });
			}

			if (server.upgrade(req)) return undefined;

			// The huddle STAGE and its assets (spec section 8): the loopback page a
			// Flow desktop pane points a WKWebView at once and never navigates
			// again, plus that huddle's rendered slides and synthesised narration.
			// Anchored to /huddle/<id>/{stage,slides,audio}, so it can never shadow
			// a control endpoint; anything else falls straight through.
			{
				const staged = handleStageHttp(url, `ws://127.0.0.1:${server.port}`);
				if (staged) return staged;
			}

			// A persisted Table message's narration wav, e.g. one attached after
			// the fact via message:attachAudio (table-routes.ts). Anchored to
			// /table/audio/<messageId>/<file>, the exact string both the DB's
			// audio_url column and the relay's proxy route use - never shadows a
			// control endpoint, falls straight through for anything else.
			{
				const tableAudio = handleTableAudioHttp(url);
				if (tableAudio) return tableAudio;
			}

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

			// Meta-harness surface (part of #2797): GET /harnesses,
			// POST /harness/run, GET /harness/tasks (SSE). Local-first:
			// the default backend is 8gent-local. Returns null for
			// non-harness paths so everything below stays untouched.
			const harnessResponse = handleHarnessRoute(req, url);
			if (harnessResponse) return harnessResponse;

			// Access audit log endpoint (DPIA G7). POST-only, metadata only.
			if (url.pathname === "/audit/access" && req.method === "POST") {
				return handleAuditAccess(req, config);
			}

			// On-demand Table message narration (2026-08-21 correction: real-time
			// synthesis + immediate playback only, NEVER persisted - see
			// message-speak.ts's header for why this replaced the earlier
			// per-message audio_url-for-everything direction). POST-only, matches
			// its own messageId inside the handler; falls through (null) for
			// everything else, same optional-handler contract as the huddle stage
			// and table-audio handlers above.
			if (req.method === "POST" && SPEAK_URL_RE.test(url.pathname)) {
				// handleTableSpeakHttp's null case (path/method mismatch) cannot occur
				// past this guard - both check the same SPEAK_URL_RE/"POST" - but its
				// signature stays Promise<Response | null> so it composes with the
				// other optional handlers above; map that impossible null to a 404
				// here so this branch's return type is the plain Promise<Response>
				// Bun.serve's fetch signature requires.
				return handleTableSpeakHttp(req, url, getTableStore()).then(
					(r) => r ?? Response.json({ error: "message not found" }, { status: 404 }),
				);
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
				const isDispatch = data?.route === "dispatch";
				const isStore = data?.route === "store";
				const state: ClientState = {
					id,
					channel: isComputer ? "computer" : isDispatch ? "dispatch" : isStore ? "store" : "api",
					sessionId: null,
					authenticated: !config.authToken,
					isComputerRoute: isComputer,
					isDispatchRoute: isDispatch,
					isStoreRoute: isStore,
					subscribedChannels: new Set<string>(),
					// Captured for the Table per-frame loopback guard (F1). Empty when
					// unavailable, which isLoopbackAddress() treats as non-loopback.
					remoteAddress: (ws as unknown as { remoteAddress?: string }).remoteAddress,
				};
				clients.set(ws, state);
				const tag = isComputer
					? " (computer)"
					: isDispatch
						? " (dispatch)"
						: isStore
							? " (store)"
							: "";
				console.log(`[gateway] client ${id} connected${tag}`);
				if (isComputer) {
					handleComputerOpen(ws as unknown as ComputerWS, config.pool, state);
				} else if (isDispatch) {
					handleDispatchOpen(ws as unknown as DispatchWS);
				} else if (isStore) {
					handleStoreOpen(ws as unknown as StoreWS);
				}
			},
			message(ws, raw) {
				const state = clients.get(ws);
				const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
				if (state?.isComputerRoute) {
					handleComputerMessage(ws as unknown as ComputerWS, config.pool, state, text);
					return;
				}
				if (state?.isDispatchRoute && config.dispatch) {
					handleDispatchMessage(
						ws as unknown as DispatchWS,
						{ pool: config.pool, ...config.dispatch },
						text,
					);
					return;
				}
				if (state?.isStoreRoute) {
					handleStoreMessage(ws as unknown as StoreWS, text).catch((err) => {
						console.warn("[store-route] handler error:", err);
					});
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
					} else if (state.isDispatchRoute && config.dispatch) {
						handleDispatchClose(ws as unknown as DispatchWS, {
							pool: config.pool,
							...config.dispatch,
						});
					} else if (state.isStoreRoute) {
						handleStoreClose(ws as unknown as StoreWS);
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
	if (config.dispatch) {
		console.log(`[gateway] dispatch protocol: ws://${hostname}:${config.port}/dispatch`);
	}
	console.log(`[gateway] store route: ws://${hostname}:${config.port}/store`);
	return server;
}
