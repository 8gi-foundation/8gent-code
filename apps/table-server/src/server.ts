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
 * Trust: a tokens file maps sha256(token) to exactly one human identity. The
 * identity comes from the token; a participantId the client claims must match
 * it or the connection is refused, so a token holder can never act as anyone
 * else. A wrong token, any frame before auth, or no auth within 5 s closes the
 * socket. Connections are capped server-wide, posts are capped at 16 KB and
 * rate-limited per connection, and frames over 32 KB close the socket. Signed or
 * narrated posts (sig, audioUrl) are refused: this server holds no ed25519
 * registry and serves no audio, so it will not store a field it cannot check.
 */

import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import type { TableStore } from "../../../packages/table/store";
import { TableError } from "../../../packages/table/types";

/** Largest post body, in UTF-8 bytes. Enforced here, before the store. */
export const MAX_CONTENT_BYTES = 16 * 1024;
/** Largest WS frame: one maximal post plus its JSON envelope. Bigger frames close the socket (1009). */
export const MAX_FRAME_BYTES = 32 * 1024;
/** Per-connection post budget: a token bucket refilled at RATE per second, holding at most BURST. */
export const POST_RATE_PER_S = 10;
export const POST_BURST = 20;
/** A socket that has not authenticated by then is closed. */
export const DEFAULT_AUTH_TIMEOUT_MS = 5000;
/** Open WebSocket connections across the whole server. */
export const DEFAULT_MAX_CONNECTIONS = 64;
/** Most messages one message:subscribe may seed. */
export const MAX_SEED = 500;

const PARTICIPANT_RE = /^human:[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

export interface ConnState {
	participantId?: string;
	authTimer?: ReturnType<typeof setTimeout>;
	tokens: number;
	refilledAt: number;
}

/** One line of the tokens file: sha256(token) and the only identity that token may act as. */
export interface TokenEntry {
	digest: Buffer;
	participantId: string;
}

export interface TableServerOptions {
	store: TableStore;
	/** Accepted tokens, each bound to one identity. Must be non-empty. */
	tokens: TokenEntry[];
	hostname: string;
	port: number;
	authTimeoutMs?: number;
	maxConnections?: number;
}

/**
 * Parse a tokens file: one `<sha256 hex of the token> human:<handle>` per line,
 * `#` comments and blank lines ignored. Any malformed line or duplicate digest
 * throws: a half-read identity table is worse than none.
 */
export function parseTokens(text: string): TokenEntry[] {
	const out: TokenEntry[] = [];
	const seen = new Set<string>();
	for (const [i, raw] of text.split("\n").entries()) {
		const line = (raw.split("#", 1)[0] as string).trim();
		if (!line) continue;
		const [hex, pid, extra] = line.split(/\s+/);
		if (
			extra !== undefined ||
			!hex ||
			!/^[0-9a-f]{64}$/.test(hex) ||
			!pid ||
			!PARTICIPANT_RE.test(pid)
		)
			throw new Error(`tokens file line ${i + 1}: expected "<sha256 hex> human:<handle>"`);
		if (seen.has(hex)) throw new Error(`tokens file line ${i + 1}: duplicate token digest`);
		seen.add(hex);
		out.push({ digest: Buffer.from(hex, "hex"), participantId: pid });
	}
	return out;
}

/**
 * The identity a presented token is bound to, or undefined. Every entry is
 * compared with timingSafeEqual and the loop never exits early, so the time
 * taken does not say which entry (if any) matched.
 */
export function identityFor(given: unknown, tokens: TokenEntry[]): string | undefined {
	if (typeof given !== "string" || given.length === 0) return undefined;
	const d = createHash("sha256").update(given).digest();
	let found: string | undefined;
	for (const t of tokens) {
		const hit = timingSafeEqual(d, t.digest);
		found = hit && found === undefined ? t.participantId : found;
	}
	return found;
}

/** Take one post from the connection's bucket; false when it is empty. */
export function takePost(state: ConnState, now = Date.now()): boolean {
	const elapsed = Math.max(0, now - state.refilledAt) / 1000;
	state.tokens = Math.min(POST_BURST, state.tokens + elapsed * POST_RATE_PER_S);
	state.refilledAt = now;
	if (state.tokens < 1) return false;
	state.tokens -= 1;
	return true;
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

/**
 * The identity comes from the matched token, never from the client. A client
 * may still send participantId (table-gate always does); if it names anyone
 * but the token's identity, the connection is refused. A second auth on a
 * bound connection is refused too.
 */
function handleAuth(
	ws: ServerWebSocket<ConnState>,
	msg: Record<string, unknown>,
	tokens: TokenEntry[],
): void {
	const identity = identityFor(msg.token, tokens);
	const claimed = msg.participantId;
	const claimOk = claimed === undefined || claimed === identity;
	if (!identity || !claimOk || ws.data.participantId) {
		send(ws, { type: "auth:fail" });
		ws.close(4401, "auth failed");
		return;
	}
	clearTimeout(ws.data.authTimer);
	ws.data.participantId = identity;
	send(ws, { type: "auth:ok", participantId: identity });
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
				const content = String(msg.content ?? "");
				if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES)
					throw new TableError("TABLE_VALIDATION", `content is over ${MAX_CONTENT_BYTES} bytes`);
				if (!takePost(ws.data)) {
					send(ws, {
						type: "table:error",
						id,
						code: "TABLE_RATE_LIMITED",
						message: "post rate limit",
					});
					return;
				}
				const channelId = String(msg.channelId ?? "");
				const message = store.postMessage({
					channelId,
					authorId: actor,
					content,
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
	if (opts.tokens.length === 0) throw new Error("table-server: refusing to start without tokens");
	const { store, tokens } = opts;
	const authTimeoutMs = opts.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
	const maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
	let open = 0;
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
				if (open >= maxConnections) return new Response("too many connections", { status: 503 });
				const data: ConnState = { tokens: POST_BURST, refilledAt: Date.now() };
				// Counted at upgrade, not at open, so a burst of handshakes cannot overshoot the cap.
				if (srv.upgrade(req, { data })) {
					open++;
					return undefined;
				}
				return new Response("upgrade failed", { status: 400 });
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			maxPayloadLength: MAX_FRAME_BYTES,
			idleTimeout: 120,
			open(ws) {
				ws.data.authTimer = setTimeout(() => {
					if (!ws.data.participantId) ws.close(4408, "auth timeout");
				}, authTimeoutMs);
			},
			close(ws) {
				open--;
				clearTimeout(ws.data.authTimer);
			},
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
				if (msg.type === "auth") return handleAuth(ws, msg, tokens);
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
