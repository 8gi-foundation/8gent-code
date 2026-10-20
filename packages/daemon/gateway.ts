/**
 * Gateway - WebSocket server for the daemon.
 *
 * Accepts connections from OS frontend, Telegram, Discord, etc.
 * Routes messages to the AgentPool, broadcasts agent events to clients.
 */

import { logAccess } from "../audit/index";
import type { LogAccessInput } from "../audit/types";
import { SessionManager, defaultSessionsDir } from "../eight/session-manager";
import { handleHarnessRoute } from "../harness/http";
import {
	SPEAK_URL_RE,
	TableStore,
	handleTableAudioHttp,
	handleTableSpeakHttp,
	installTablePolicies,
} from "../table/index";
import { type AgentPool, KNOWN_CHANNELS } from "./agent-pool";
import { telegramBridgeHealth } from "./bridge-health";
import { channelApprovals, isBridgeSecret, parseTurn } from "./channel-approvals";
import { CLASSROOM_CHANNEL, classroomCreateRefusal, installClassroomPolicies } from "./classroom";
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
import { handleStageHttp } from "./huddle-stage";
import { gateInput } from "./input-gate";
import {
	handleLiveHttp,
	installLiveAnatomy,
	liveClose,
	liveMessage,
	liveOpen,
} from "./live-anatomy";
import { assertSafeBind, guardRequest, resolveBindHost } from "./origin-guard";
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
import {
	ResumeSecrets,
	SHAREABLE_CHANNELS,
	type SharedPool,
	type SharedSessionInbound,
	type SharedSessionOutbound,
	type SharedStore,
	handleResume,
	handleSharedSession,
	isSharedSessionType,
	persistSession,
} from "./shared-sessions";
import { bindParticipant, handleTableFrame, isLoopbackAddress, isTableFrame } from "./table-routes";
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
	/** Proved it is the Telegram approval bridge (#3621): only it answers approvals. */
	approvalBridge?: boolean;
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
	/** Times of this connection's restores from disk, for the rate limit (#3929). */
	restores?: number[];
}

type InboundMessage =
	| { type: "auth"; token: string; participantId?: string }
	/** persist: true saves the session after every turn (#3929), so it can be resumed later. */
	| { type: "session:create"; channel: string; persist?: boolean }
	| { type: "session:resume"; sessionId: string; channel?: string; resumeSecret?: string }
	| { type: "session:compact"; sessionId: string }
	| { type: "session:destroy"; sessionId: string }
	/** `turn` counts only from the registered approval bridge (#3621). */
	| { type: "prompt"; text: string; turn?: unknown }
	| { type: "approvals:register"; secret: string }
	| { type: "sessions:list" }
	| { type: "cron:list" }
	| { type: "cron:add"; job: unknown }
	| { type: "cron:remove"; jobId: string }
	| { type: "health" }
	| {
			type: "approval:response";
			requestId: string;
			approved: boolean;
			scope?: "chat";
			/** The surface could not show the card: closes it as undelivered, not declined. */
			undelivered?: boolean;
			/** Telegram id of who pressed, for the audit log. */
			approver?: string;
	  }
	| { type: "ping" }
	| TimeTravelInbound
	| SharedSessionInbound;

type OutboundMessage =
	| { type: "auth:ok" }
	| { type: "auth:fail" }
	| {
			type: "session:created";
			sessionId: string;
			resumeSecret?: string;
			/** Effective policy scope and tool list, so a client can fail closed (#3939). */
			scope?: string;
			tools?: string[];
	  }
	| { type: "session:resumed"; sessionId: string }
	| { type: "sessions:list"; sessions: unknown[] }
	| { type: "cron:list"; jobs: unknown[] }
	| { type: "cron:added"; jobId: string }
	| { type: "cron:removed"; jobId: string }
	| { type: "health"; data: unknown }
	| { type: "event"; event: EventName; payload: unknown }
	| { type: "error"; message: string }
	| { type: "pong" }
	| { type: "approval:resolved"; requestId: string; ok: boolean; reason?: string }
	| { type: "approvals:registered"; ok: boolean }
	| TimeTravelOutbound
	| SharedSessionOutbound;

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

/**
 * The session store shared with the TUI (~/.8gent/sessions, SessionManager's
 * format). Lazy, so a daemon that never shares a session never creates it.
 */
let sessionStore: { dir: string; store: SessionManager } | null = null;
function getSessionStore(): SharedStore {
	// The same directory the TUI uses (SessionManager's default, which honours
	// EIGHT_DATA_DIR). Resolved per call: it can differ between test files.
	const dir = defaultSessionsDir();
	if (sessionStore?.dir !== dir) sessionStore = { dir, store: new SessionManager(dir) };
	return sessionStore.store as unknown as SharedStore;
}

/**
 * Sessions whose store file this daemon may write (#3929): restored from it,
 * or shared when no file existed. See SharedSessionDeps.persistable.
 */
const persistable = new Set<string>();

/** Resume secrets for remote session:resume (#3929). */
const resumeSecrets = new ResumeSecrets();

/** Most restores from disk one connection may make per minute. */
const RESTORES_PER_MINUTE = 5;
function allowRestore(state: ClientState): boolean {
	const now = Date.now();
	state.restores = (state.restores ?? []).filter((t) => now - t < 60_000);
	if (state.restores.length >= RESTORES_PER_MINUTE) return false;
	state.restores.push(now);
	return true;
}

/** Connections bound to a session (shared sessions, #3929). */
function clientsOn(sessionId: string, except?: unknown): number {
	let n = 0;
	for (const [ws, s] of clients) {
		if (ws !== except && s.sessionId === sessionId && !s.isComputerRoute) n++;
	}
	return n;
}

/** Show the other clients on a session what this one sent (#3929). */
function echoPrompt(from: unknown, sessionId: string, text: string, channel: string): void {
	for (const [ws, s] of clients) {
		if (ws === from || s.isComputerRoute || !s.authenticated || s.sessionId !== sessionId) continue;
		send(ws, { type: "event", event: "user:message", payload: { sessionId, text, channel } });
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
		// Approval traffic names commands and carries live ids: the bridge only.
		if (event.startsWith("approval:") && !state.approvalBridge) continue;
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

	// Shared sessions (#3929): list, attach, detach, abort. Loopback-only on
	// every frame, like Table, whatever the listener's bind.
	if (isSharedSessionType((msg as { type?: unknown }).type)) {
		if (!isLoopbackAddress(state.remoteAddress)) {
			send(ws, { type: "error", message: "shared sessions are loopback-only" });
			return;
		}
		const { reply, bind, surface } = handleSharedSession(msg as SharedSessionInbound, {
			pool: pool as unknown as SharedPool,
			store: getSessionStore(),
			boundSessionId: state.sessionId,
			clientsOn: (id) => clientsOn(id),
			persistable,
			allowRestore: () => allowRestore(state),
		});
		if (bind !== undefined) state.sessionId = bind;
		if (surface) state.channel = surface;
		send(
			ws,
			reply.type === "session:attached"
				? { ...reply, resumeSecret: resumeSecrets.issue(reply.sessionId) }
				: reply,
		);
		return;
	}

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
			// classroom (#3939) runs on untrusted web text: authenticated loopback only.
			if (msg.channel === CLASSROOM_CHANNEL) {
				const refusal = classroomCreateRefusal({
					loopback: isLoopbackAddress(state.remoteAddress),
					authenticated: state.authenticated,
				});
				if (refusal) {
					send(ws, { type: "error", message: refusal });
					break;
				}
			}
			// An unknown channel string is refused, never defaulted into a wider scope.
			if (msg.channel && !(KNOWN_CHANNELS as readonly string[]).includes(msg.channel)) {
				send(ws, {
					type: "error",
					message: `unknown channel: ${String(msg.channel).slice(0, 40)}`,
				});
				break;
			}
			const sessionId = generateSessionId();
			state.sessionId = sessionId;
			state.channel = msg.channel || "api";
			// Opt-in save after every turn, so a panel-only chat can be resumed
			// later, also after a daemon restart (#3929). Shareable channels only.
			if (msg.persist === true && SHAREABLE_CHANNELS.has(state.channel)) persistable.add(sessionId);

			// Respond to the client first, then emit events and create agent
			send(ws, {
				type: "session:created",
				sessionId,
				resumeSecret: resumeSecrets.issue(sessionId),
				...(state.channel === CLASSROOM_CHANNEL
					? { scope: CLASSROOM_CHANNEL, tools: [] as string[] }
					: {}),
			});
			bus.emit("session:start", { sessionId, channel: state.channel });

			// Create Agent instance async (constructor does blocking AST indexing)
			setTimeout(() => pool.createSession(sessionId, state.channel), 0);
			break;
		}

		case "session:resume": {
			// A resume on a fresh socket would otherwise default to "api" (#3538).
			// session:create already takes the channel from the client.
			const channel = msg.channel || state.channel;
			// Shared-session rules (#3929): private channels stay private, a saved
			// session is restored with its history, never recreated empty.
			const { reply, bind, surface } = handleResume(msg.sessionId, {
				pool: pool as unknown as SharedPool,
				store: getSessionStore(),
				boundSessionId: state.sessionId,
				clientsOn: (id) => clientsOn(id, ws),
				persistable,
				allowRestore: () => allowRestore(state),
				isBridge: state.approvalBridge === true,
				loopback: isLoopbackAddress(state.remoteAddress),
				channel,
				resumeSecretOk: resumeSecrets.matches(msg.sessionId, msg.resumeSecret),
			});
			if (reply.type === "error") {
				send(ws, reply);
				break;
			}
			state.sessionId = bind ?? state.sessionId;
			state.channel = surface ?? channel;
			bus.emit("session:start", {
				sessionId: msg.sessionId,
				channel: state.channel,
			});
			send(
				ws,
				reply.type === "session:resumed"
					? { ...reply, resumeSecret: resumeSecrets.issue(msg.sessionId) }
					: reply,
			);
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
				// Only the session this connection is on (#3929).
				if (msg.sessionId !== state.sessionId) {
					send(ws, { type: "error", message: "can only end the session you are on" });
					break;
				}
				// Others are still on it: this client leaves, the session goes on.
				if (clientsOn(msg.sessionId, ws) > 0) {
					state.sessionId = null;
					break;
				}
				persistable.delete(msg.sessionId);
				resumeSecrets.forget(msg.sessionId);
				// Only the bridge's own socket may cancel its live prompt.
				if (state.approvalBridge) channelApprovals.endSession(msg.sessionId);
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
			// Only the bridge's own socket can make a turn ask for approval; a
			// client that merely resumed the session cannot.
			const turn = state.approvalBridge ? parseTurn(msg.turn) : undefined;
			if (typeof msg.text === "string") echoPrompt(ws, sid, msg.text, state.channel);
			const runModelTurn = (): void => {
				pool
					.chat(sid, msg.text, turn)
					.then((response) => {
						// Final response - signal session:end for this turn
						bus.emit("session:end", { sessionId: sid, reason: "turn-complete" });
					})
					.catch((err) => {
						bus.emit("agent:error", {
							sessionId: sid,
							error: err instanceof Error ? err.message : String(err),
						});
					})
					.finally(() => {
						// Shareable sessions are saved after every turn so the TUI and a
						// later session:attach can resume them (#3929).
						persistSession(pool as unknown as SharedPool, getSessionStore, sid, persistable);
					});
			};
			// Every channel's text passes the deterministic gate before the model (#4530).
			const agent = pool.getAgent(sid);
			const info = pool.getSessionInfo(sid);
			void gateInput(msg.text, {
				sessionId: sid,
				channel: state.channel,
				model: agent?.getModel?.(),
				runtime: agent?.getRuntime?.(),
				messageCount: info?.messageCount,
				busy: info?.busy,
			}).then((r) => {
				if (!r.handled) return runModelTurn();
				bus.emit("agent:stream", { sessionId: sid, chunk: r.text ?? "", final: true });
				bus.emit("session:end", { sessionId: sid, reason: "turn-complete" });
			});
			break;
		}

		case "sessions:list": {
			// Classroom sessions are private to their creator: not even listed (#3939).
			send(ws, {
				type: "sessions:list",
				sessions: pool.getActiveSessions().filter((s) => s.channel !== CLASSROOM_CHANNEL),
			});
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

		case "approvals:register": {
			state.approvalBridge = isBridgeSecret(msg.secret);
			if (!state.approvalBridge)
				console.warn(`[gateway] client ${state.id} failed approval-bridge registration`);
			send(ws, { type: "approvals:registered", ok: state.approvalBridge });
			break;
		}

		case "approval:response": {
			// Resolve the waiting prompt. This used to re-emit approval:required,
			// so every press drew a second card and resolved nothing (#3621).
			if (!state.approvalBridge) {
				console.warn(`[gateway] refused approval:response from non-bridge client ${state.id}`);
				send(ws, {
					type: "approval:resolved",
					requestId: String(msg.requestId),
					ok: false,
					reason: "not-bridge",
				});
				break;
			}
			const decision = msg.undelivered
				? "undelivered"
				: !msg.approved
					? "deny"
					: msg.scope === "chat"
						? "allow_chat"
						: "approve";
			const result = channelApprovals.respond(
				state.sessionId,
				String(msg.requestId),
				decision,
				typeof msg.approver === "string" ? msg.approver : null,
			);
			send(ws, { type: "approval:resolved", requestId: String(msg.requestId), ...result });
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

/**
 * Subscribe the gateway to all bus events and broadcast to relevant sessions.
 * Once per process: the listeners use the module-level client map, so a
 * second startGateway (a restart, or a second test file) would otherwise
 * deliver every event twice - two approval cards for one prompt.
 */
let busSubscribed = false;
function subscribeToBus(): void {
	if (busSubscribed) return;
	busSubscribed = true;
	const events: EventName[] = [
		"tool:start",
		"tool:result",
		"agent:thinking",
		"agent:stream",
		"agent:error",
		"memory:saved",
		"approval:required",
		"approval:closed",
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
	// The live anatomy page's event log (#4190).
	installLiveAnatomy(bus, config.authToken);
	// An attached session is never evicted from under its clients (#3929).
	config.pool.setInUse?.((id) => clientsOn(id) > 0);

	// Install the Table deny-by-default policy set once (idempotent). Table
	// agents bind under the "__table__" scope; these rules block
	// run_command/network/write_file and explicitly allow only channel_post.
	installTablePolicies();
	installClassroomPolicies();

	// Loopback unless DAEMON_HOSTNAME says otherwise, and never a wider bind
	// without a token. The /computer route and Table frames keep their own
	// per-surface loopback checks on top of this.
	const hostname = resolveBindHost();
	assertSafeBind(hostname, config.authToken);

	const server = Bun.serve({
		port: config.port,
		hostname,
		fetch(req, server) {
			// Before any route or upgrade: refuse web pages that are not ours
			// (cross-site WebSocket hijack) and foreign Host headers (DNS rebinding).
			const refused = guardRequest(req, hostname, config.port);
			if (refused) return refused;

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

			// The live anatomy page (#4190) answers loopback peers only, whatever
			// the daemon binds to (8SO, message 5844). /live/ws asks for the daemon
			// token in its first frame when one is set.
			const livePeer = isLoopbackAddress(
				(
					server as unknown as {
						requestIP?: (r: Request) => { address?: string } | null;
					}
				).requestIP?.(req)?.address ?? "",
			);
			if (url.pathname === "/live/ws") {
				if (!livePeer) {
					return new Response("forbidden: the live view is loopback-only", { status: 403 });
				}
				if (
					(server.upgrade as (r: Request, opts?: any) => boolean)(req, {
						data: { route: "live" },
					})
				) {
					return undefined;
				}
				return new Response("WebSocket upgrade required", { status: 426 });
			}

			if (server.upgrade(req)) return undefined;

			// GET /live and its pinned Mermaid copy (#4190).
			{
				const live = handleLiveHttp(req, url, livePeer);
				if (live) return live;
			}

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
				const telegram = telegramBridgeHealth();
				return Response.json({
					status: "ok",
					sessions: config.pool.size,
					uptime: process.uptime(),
					...(telegram ? { telegram } : {}),
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
				// The live page is a viewer, never a session client (#4190).
				if (data?.route === "live") return liveOpen(ws);
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
				if ((ws as unknown as { data?: { route?: string } }).data?.route === "live") {
					return liveMessage(ws, text);
				}
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
				if ((ws as unknown as { data?: { route?: string } }).data?.route === "live") {
					return liveClose(ws);
				}
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
						// A classroom session dies with the socket that made it (#3939).
						if (state.channel === CLASSROOM_CHANNEL) {
							config.pool.destroySession(state.sessionId);
							persistable.delete(state.sessionId);
							resumeSecrets.forget(state.sessionId);
						}
						if (state.approvalBridge) channelApprovals.endSession(state.sessionId);
						// A shared session goes on for the clients still on it (#3929):
						// only the last one leaving ends it for listeners.
						if (clientsOn(state.sessionId, ws) === 0) {
							bus.emit("session:end", {
								sessionId: state.sessionId,
								reason: "client-disconnect",
							});
						}
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
