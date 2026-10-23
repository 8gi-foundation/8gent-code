/**
 * Shared sessions from the TUI (#3929): a small client for the 8gent daemon's
 * session:list / session:attach / session:detach / session:abort frames
 * (docs/specs/DAEMON-PROTOCOL.md, v1.4), so the TUI and the 8gent Browser panel
 * can sit on one session and both see it live.
 *
 * Loopback only: the daemon refuses these frames from any other peer. The token
 * comes from EIGHT_DAEMON_TOKEN or ~/.8gent/config.json daemon.authToken and is
 * only ever sent in the auth frame.
 */

import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { dataDirPath } from "../../../../packages/daemon/data-dir";
import { readTokenFile } from "../../../../packages/daemon/local-link";
import { daemonProof } from "../../../../packages/daemon/origin-guard";

export const DEFAULT_DAEMON_URL = "ws://127.0.0.1:18789";

export interface LiveSession {
	sessionId: string;
	channel: string;
	title?: string;
	busy: boolean;
	messageCount: number;
	clients: number;
	createdAt: number;
	lastActiveAt: number;
}

export interface PastSession {
	sessionId: string;
	channel: string;
	title: string;
	messageCount: number;
	model: string;
	cwd: string;
	lastActiveAt: number;
}

export interface AttachedSession {
	sessionId: string;
	channel: string;
	busy: boolean;
	restored: boolean;
	transcript: Array<{ role: string; content: string }>;
	truncated: boolean;
}

/** What the chat shows for a daemon frame. */
export type DaemonChatEvent =
	| { kind: "user"; text: string; channel: string }
	| { kind: "reply"; text: string }
	| { kind: "tool"; tool: string }
	| { kind: "error"; text: string }
	| { kind: "ended"; reason: string };

/**
 * Map one daemon frame to a chat event, or null when the chat shows nothing
 * for it. Only the final reply is shown: it carries the whole response.
 */
export function toChatEvent(frame: unknown): DaemonChatEvent | null {
	if (!frame || typeof frame !== "object") return null;
	const f = frame as { type?: unknown; event?: unknown; payload?: Record<string, unknown> };
	if (f.type !== "event" || typeof f.event !== "string") return null;
	const p = f.payload ?? {};
	switch (f.event) {
		case "user:message":
			return typeof p.text === "string"
				? {
						kind: "user",
						text: p.text,
						channel: typeof p.channel === "string" ? p.channel : "8gent",
					}
				: null;
		case "agent:stream":
			return p.final === true && typeof p.chunk === "string" && p.chunk
				? { kind: "reply", text: p.chunk }
				: null;
		case "tool:start":
			return typeof p.tool === "string" ? { kind: "tool", tool: p.tool } : null;
		case "agent:error":
			return { kind: "error", text: String(p.error ?? "unknown error") };
		case "session:end":
			return p.reason === "turn-complete"
				? null
				: { kind: "ended", reason: String(p.reason ?? "") };
		default:
			return null;
	}
}

/** Where the surface label for an echoed message reads well in the chat. */
export function surfaceLabel(channel: string): string {
	switch (channel) {
		case "tui":
			return "TUI";
		case "browser":
			return "8gent Browser";
		case "os":
			return "8gent OS";
		case "app":
			return "8gent app";
		default:
			return channel;
	}
}

/** The daemon token, if one is configured. Never logged. */
export function readDaemonToken(home = process.env.HOME || ""): string | null {
	if (process.env.EIGHT_DAEMON_TOKEN) return process.env.EIGHT_DAEMON_TOKEN;
	try {
		const raw = fs.readFileSync(path.join(home, ".8gent", "config.json"), "utf8");
		const token = JSON.parse(raw)?.daemon?.authToken;
		return typeof token === "string" && token ? token : null;
	} catch {
		return null;
	}
}

/**
 * The secret a daemon proves its identity with, and that this TUI then sends as its token
 * (#4829): EIGHT_DAEMON_TOKEN, the config token, or the daemon's own 0600 token file in
 * this machine's data directory. Null when there is none, and then nothing connects:
 * a daemon that cannot be verified is never sent a token or a session.
 */
export function resolveDaemonSecret(home = process.env.HOME || ""): string | null {
	return (
		readDaemonToken(home) ??
		readTokenFile(process.env.EIGHT_DATA_DIR ? dataDirPath() : path.join(home, ".8gent"))
	);
}

/** The live anatomy page (#4190) on the daemon this TUI talks to. Never carries the token. */
export function liveViewUrl(env: Record<string, string | undefined> = process.env): string {
	const u = new URL(env.EIGHT_DAEMON_URL ?? DEFAULT_DAEMON_URL);
	u.protocol = u.protocol === "wss:" ? "https:" : "http:";
	u.pathname = "/live";
	u.search = "";
	u.hash = "";
	return u.toString();
}

/**
 * Open the live page in 8gent Browser over its control channel, the path
 * browser_open uses. The daemon token, when set, rides in the fragment, which
 * no server log sees. Resolves null on success, else why it did not open.
 */
export async function openLiveView(url: string): Promise<string | null> {
	const token = readDaemonToken();
	try {
		const { wsCall } = await import("../../../../packages/tools/eight-browser.js");
		await wsCall("tab.open", { url: token ? `${url}#token=${encodeURIComponent(token)}` : url });
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

export interface ConnectOptions {
	url?: string;
	token?: string | null;
	timeoutMs?: number;
}

type Frame = Record<string, unknown> & { type?: string };

export class DaemonSessionClient {
	private listeners = new Set<(e: DaemonChatEvent) => void>();
	private waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
	private closedReason: string | null = null;
	sessionId: string | null = null;

	private constructor(
		private ws: WebSocket,
		private timeoutMs: number,
	) {
		ws.onmessage = (ev) => {
			let frame: Frame;
			try {
				frame = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			const waiter = this.waiters.find((w) => w.match(frame));
			if (waiter) {
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				waiter.resolve(frame);
			}
			const e = toChatEvent(frame);
			if (!e) return;
			const sid = (frame.payload as { sessionId?: unknown } | undefined)?.sessionId;
			if (sid !== undefined && sid !== this.sessionId) return;
			if (e.kind === "ended") this.sessionId = null;
			for (const cb of this.listeners) cb(e);
		};
		ws.onclose = () => {
			this.closedReason = "the 8gent daemon closed the connection";
			if (this.sessionId) {
				this.sessionId = null;
				for (const cb of this.listeners) cb({ kind: "ended", reason: "daemon-disconnect" });
			}
		};
	}

	/** Connect (and authenticate when a token is set). Rejects when the daemon is not reachable. */
	static async connect(opts: ConnectOptions = {}): Promise<DaemonSessionClient> {
		const url = opts.url ?? process.env.EIGHT_DAEMON_URL ?? DEFAULT_DAEMON_URL;
		const timeoutMs = opts.timeoutMs ?? 3000;
		const ws = new WebSocket(url);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				try {
					ws.close();
				} catch {}
				reject(new Error(`no 8gent daemon at ${url}`));
			}, timeoutMs);
			ws.onopen = () => {
				clearTimeout(timer);
				resolve();
			};
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error(`no 8gent daemon at ${url}`));
			};
		});
		const client = new DaemonSessionClient(ws, timeoutMs);
		const secret = opts.token === undefined ? resolveDaemonSecret() : opts.token;
		try {
			if (!secret) {
				throw new Error(
					"no token to verify this daemon with. Start it once with `8gent daemon`, or set EIGHT_DAEMON_TOKEN",
				);
			}
			// The daemon proves it holds the secret BEFORE this client sends the token or a
			// session: whatever else answers on the port learns nothing.
			await client.verifyDaemon(secret);
			const r = await client.request({ type: "auth", token: secret }, ["auth:ok", "auth:fail"]);
			if (r.type !== "auth:ok") throw new Error("the 8gent daemon refused the token");
		} catch (err) {
			client.close();
			throw err;
		}
		return client;
	}

	/** Challenge the daemon: it must answer HMAC(secret, nonce). Throws unless it does. */
	private async verifyDaemon(secret: string): Promise<void> {
		const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
		let proof: unknown;
		try {
			proof = (await this.request({ type: "identify", nonce }, ["identify:ok"])).proof;
		} catch {
			throw new Error(
				"this daemon could not prove who it is. Restart it with the current 8gent, or check the port",
			);
		}
		const want = Buffer.from(daemonProof(secret, nonce));
		const got = Buffer.from(typeof proof === "string" ? proof : "");
		if (got.length !== want.length || !timingSafeEqual(got, want)) {
			throw new Error(
				"this is not your 8gent daemon (its identity check failed); nothing was sent",
			);
		}
	}

	/** Send a frame and wait for the first reply of one of `types`, or an error frame. */
	private request(frame: Frame, types: string[]): Promise<Frame> {
		if (this.closedReason) return Promise.reject(new Error(this.closedReason));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w !== waiter);
				reject(new Error(`the 8gent daemon did not answer ${String(frame.type)}`));
			}, this.timeoutMs);
			const waiter = {
				match: (f: Frame) => types.includes(String(f.type)) || f.type === "error",
				resolve: (f: Frame) => {
					clearTimeout(timer);
					if (f.type === "error") reject(new Error(String(f.message ?? "daemon error")));
					else resolve(f);
				},
			};
			this.waiters.push(waiter);
			this.ws.send(JSON.stringify(frame));
		});
	}

	async list(limit = 20): Promise<{ live: LiveSession[]; past: PastSession[] }> {
		const r = await this.request({ type: "session:list", past: true, limit }, ["session:list"]);
		return {
			live: Array.isArray(r.live) ? (r.live as LiveSession[]) : [],
			past: Array.isArray(r.past) ? (r.past as PastSession[]) : [],
		};
	}

	/** Join a live session, or bring a past one back into the daemon and join it. */
	async attach(sessionId: string, channel = "tui"): Promise<AttachedSession> {
		const r = await this.request({ type: "session:attach", sessionId, channel }, [
			"session:attached",
		]);
		this.sessionId = String(r.sessionId);
		return r as unknown as AttachedSession;
	}

	/** Leave the session; it keeps running for everyone else. */
	async detach(): Promise<void> {
		if (!this.sessionId) return;
		this.sessionId = null;
		await this.request({ type: "session:detach" }, ["session:detached"]);
	}

	/** Stop the turn in flight. The session and its history stay. */
	async abort(): Promise<boolean> {
		if (!this.sessionId) return false;
		const r = await this.request({ type: "session:abort", sessionId: this.sessionId }, [
			"session:aborted",
		]);
		return r.aborted === true;
	}

	prompt(text: string): void {
		if (!this.sessionId) throw new Error("not attached to a session");
		this.ws.send(JSON.stringify({ type: "prompt", text }));
	}

	onEvent(cb: (e: DaemonChatEvent) => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	close(): void {
		this.closedReason = "closed";
		this.sessionId = null;
		this.listeners.clear();
		try {
			this.ws.close();
		} catch {}
	}
}
