/**
 * Standalone Table server: the WebSocket subset table-gate speaks, over a
 * TableStore, with nothing else in the process.
 *
 * Frames (same shapes as packages/daemon/table-routes.ts and the auth step in
 * packages/daemon/gateway.ts, so ~/.8gent/bin/table-gate works unchanged):
 *   auth              {token, participantId}      -> auth:ok | auth:fail (then close)
 *   channel:list      {id, includeArchived?}      -> channel:listed {channels}
 *   channel:members   {id, channelId, op?, ...}   -> channel:membersList | channel:memberAdded | channel:memberRemoved
 *   message:subscribe {id, channelId, seed?}      -> message:subscribed {backlog}
 *   message:post      {id, channelId, content, replyTo?} -> message:posted {message}, and message:appended to subscribers
 * A store refusal is table:error {id, code, message}. Any other frame type is
 * refused with TABLE_UNSUPPORTED.
 *
 * Not here, by design: no agent pool, providers, cron, LLM or mention flow.
 * A post is stored and fanned out, nothing more.
 *
 * Trust: one bearer token (constant-time compare). A wrong token, a missing
 * or non-human participant, or any frame before auth closes the socket. The
 * identity is pinned once per connection, as in the daemon (F2). Signed or
 * narrated posts (sig, audioUrl) are refused: this server holds no ed25519
 * registry and serves no audio, so it will not store a field it cannot check.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import type { TableStore } from "../../../packages/table/store";
import { TableError } from "../../../packages/table/types";

/** Largest frame accepted. A post is capped well below this by the store. */
export const MAX_FRAME_BYTES = 256 * 1024;
/** Most messages one message:subscribe may seed. */
export const MAX_SEED = 500;

const PARTICIPANT_RE = /^human:[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

export interface ConnState {
	participantId?: string;
}

export interface TableServerOptions {
	store: TableStore;
	/** The one accepted bearer token. Must be non-empty. */
	token: string;
	hostname: string;
	port: number;
}

/** Constant-time token comparison over sha256 digests (length-independent). */
export function sameToken(given: unknown, want: string): boolean {
	if (typeof given !== "string" || want.length === 0) return false;
	const a = createHash("sha256").update(given).digest();
	const b = createHash("sha256").update(want).digest();
	return timingSafeEqual(a, b);
}

/** Row counts for /healthz, straight from the store's own tables. */
export function counts(store: TableStore): { channels: number; members: number; messages: number } {
	const one = (table: string) =>
		(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
	return { channels: one("channels"), members: one("members"), messages: one("messages") };
}

const topic = (channelId: string) => `channel:${channelId}`;

function send(ws: ServerWebSocket<ConnState>, frame: unknown): void {
	ws.send(JSON.stringify(frame));
}

function refuse(ws: ServerWebSocket<ConnState>, id: unknown, err: unknown): void {
	const code = err instanceof TableError ? err.code : "TABLE_INTERNAL";
	const message = err instanceof TableError ? err.message : "internal error";
	send(ws, { type: "table:error", id, code, message });
}

function handleAuth(
	ws: ServerWebSocket<ConnState>,
	msg: Record<string, unknown>,
	token: string,
): void {
	const pid = typeof msg.participantId === "string" ? msg.participantId.trim() : "";
	const pinned = ws.data.participantId;
	if (!sameToken(msg.token, token) || !PARTICIPANT_RE.test(pid) || (pinned && pinned !== pid)) {
		send(ws, { type: "auth:fail" });
		ws.close(4401, "auth failed");
		return;
	}
	ws.data.participantId = pid;
	send(ws, { type: "auth:ok" });
}

/** One authenticated table frame. `server` is used only to fan out message:appended. */
export function handleFrame(
	server: Server<ConnState>,
	store: TableStore,
	ws: ServerWebSocket<ConnState>,
	msg: Record<string, unknown>,
	actor: string,
): void {
	const id = msg.id;
	try {
		switch (msg.type) {
			case "channel:list": {
				const channels = store.listChannels({
					visibleTo: actor,
					includeArchived: msg.includeArchived === true,
				});
				send(ws, { type: "channel:listed", id, channels });
				return;
			}
			case "channel:members": {
				const channelId = String(msg.channelId ?? "");
				if (msg.op === "add") {
					const member = store.addMember({
						channelId,
						participantId: String(msg.participantId ?? ""),
						role: (msg.role as "owner" | "admin" | "member" | "bot") ?? "member",
						addedBy: actor,
					});
					send(ws, { type: "channel:memberAdded", id, member });
					return;
				}
				if (msg.op === "remove") {
					const participantId = String(msg.participantId ?? "");
					store.removeMember(channelId, participantId, actor);
					send(ws, { type: "channel:memberRemoved", id, channelId, participantId });
					return;
				}
				if (msg.op !== undefined)
					throw new TableError("TABLE_VALIDATION", "op must be add or remove");
				// Listing members leaks membership of a private channel; gate it on read access.
				store.listMessages(channelId, { limit: 1, viewerId: actor });
				send(ws, {
					type: "channel:membersList",
					id,
					channelId,
					members: store.listMembers(channelId),
				});
				return;
			}
			case "message:subscribe": {
				const channelId = String(msg.channelId ?? "");
				const seed = typeof msg.seed === "number" ? Math.min(Math.max(0, msg.seed), MAX_SEED) : 0;
				// listMessages authorizes the read (throws on a private channel for a non-member).
				const seen = store.listMessages(channelId, { limit: Math.max(seed, 1), viewerId: actor });
				const backlog = seed > 0 ? seen : [];
				ws.subscribe(topic(channelId));
				send(ws, { type: "message:subscribed", id, channelId, backlog });
				return;
			}
			case "message:post": {
				if (msg.sig !== undefined || msg.audioUrl !== undefined) {
					throw new TableError(
						"TABLE_VALIDATION",
						"signed or narrated posts are not accepted by the standalone Table server",
					);
				}
				const channelId = String(msg.channelId ?? "");
				const message = store.postMessage({
					channelId,
					authorId: actor,
					content: String(msg.content ?? ""),
					replyTo: msg.replyTo ? String(msg.replyTo) : undefined,
				});
				send(ws, { type: "message:posted", id, message });
				server.publish(
					topic(channelId),
					JSON.stringify({ type: "message:appended", channelId, message }),
				);
				return;
			}
			default:
				send(ws, {
					type: "table:error",
					id,
					code: "TABLE_UNSUPPORTED",
					message: `frame type not served here: ${String(msg.type)}`,
				});
		}
	} catch (err) {
		refuse(ws, id, err);
	}
}

/** Start the server. The caller owns the store and closes it after server.stop(). */
export function startTableServer(opts: TableServerOptions): Server<ConnState> {
	if (!opts.token) throw new Error("table-server: refusing to start without a token");
	const { store, token } = opts;
	const server: Server<ConnState> = Bun.serve<ConnState>({
		hostname: opts.hostname,
		port: opts.port,
		fetch(req, srv) {
			const url = new URL(req.url);
			if (url.pathname === "/healthz" && req.method === "GET") {
				try {
					return Response.json({ ok: true, ...counts(store) });
				} catch {
					return Response.json({ ok: false }, { status: 503 });
				}
			}
			if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
				if (srv.upgrade(req, { data: {} })) return undefined;
				return new Response("upgrade failed", { status: 400 });
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			maxPayloadLength: MAX_FRAME_BYTES,
			idleTimeout: 120,
			message(ws, raw) {
				let msg: Record<string, unknown>;
				try {
					const parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString());
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
						throw new Error("not an object");
					msg = parsed as Record<string, unknown>;
				} catch {
					send(ws, { type: "error", message: "bad frame" });
					ws.close(4400, "bad frame");
					return;
				}
				if (msg.type === "auth") return handleAuth(ws, msg, token);
				const actor = ws.data.participantId;
				if (!actor) {
					send(ws, { type: "error", message: "not authenticated" });
					ws.close(4401, "not authenticated");
					return;
				}
				handleFrame(server, store, ws, msg, actor);
			},
		},
	});
	return server;
}
