import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Who may talk to the daemon gateway, checked before any route runs.
 *
 * A loopback bind keeps other machines out, but not web pages: any page open
 * in any browser on this machine can open ws://127.0.0.1:18789, and a DNS
 * rebinding page can reach the HTTP routes. So every request is checked:
 *
 *   Origin  absent (native clients: Bun, Node, Swift, and the 8gent Browser,
 *           whose daemon client runs in the main process and sends none), a
 *           page the daemon serves itself (loopback origin on the daemon's own
 *           port, e.g. the huddle stage), or an exact entry in
 *           EIGHT_DAEMON_ALLOWED_ORIGINS. Anything else gets 403, including
 *           a local dev server on another port and any eight:// page.
 *   Host    a loopback name, the bound address, or one listed in
 *           EIGHT_DAEMON_ALLOWED_HOSTS. Anything else gets 403.
 *
 * And the gateway listens on 127.0.0.1 unless DAEMON_HOSTNAME says otherwise;
 * a non-loopback bind is refused unless the daemon has a token.
 */

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const DEFAULT_BIND_HOST = "127.0.0.1";

export function resolveBindHost(env: Record<string, string | undefined> = process.env): string {
	return env.DAEMON_HOSTNAME?.trim() || DEFAULT_BIND_HOST;
}

export function isLoopbackHost(host: string): boolean {
	return LOOPBACK_NAMES.has(host.toLowerCase());
}

export class UnsafeBindError extends Error {}

/** Refuse a non-loopback bind without a token: it would hand the daemon to the network. */
export function assertSafeBind(host: string, authToken: string | null): void {
	if (!isLoopbackHost(host) && !authToken) {
		throw new UnsafeBindError(
			`Refusing to listen on ${host} without a token. Set daemon.authToken in ~/.8gent/config.json, or unset DAEMON_HOSTNAME to stay on 127.0.0.1.`,
		);
	}
}

function list(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

/** Hostname of a Host header, without the port; IPv6 keeps its brackets. */
function hostOnly(hostHeader: string): string {
	const h = hostHeader.trim().toLowerCase();
	if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
	return h.split(":")[0] ?? "";
}

export function originAllowed(
	origin: string | null,
	daemonPort: number,
	env: Record<string, string | undefined> = process.env,
): boolean {
	if (origin === null) return true;
	const o = origin.trim().toLowerCase();
	if (list(env.EIGHT_DAEMON_ALLOWED_ORIGINS).includes(o)) return true;
	let url: URL;
	try {
		url = new URL(o);
	} catch {
		return false; // includes the opaque "null" origin of sandboxed and file:// pages
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	return isLoopbackHost(url.hostname) && port === String(daemonPort);
}

export function hostAllowed(
	hostHeader: string | null,
	bindHost: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	if (!hostHeader) return false;
	const h = hostOnly(hostHeader);
	if (isLoopbackHost(h)) return true;
	if (h === bindHost.toLowerCase() && bindHost !== "0.0.0.0" && bindHost !== "::") return true;
	return list(env.EIGHT_DAEMON_ALLOWED_HOSTS).includes(h);
}

/** A 403 for a request from a page or host the daemon does not serve, else null. */
export function guardRequest(
	req: Request,
	bindHost: string,
	daemonPort: number,
	env: Record<string, string | undefined> = process.env,
): Response | null {
	if (!originAllowed(req.headers.get("origin"), daemonPort, env)) {
		return new Response("forbidden: origin not allowed", { status: 403 });
	}
	if (!hostAllowed(req.headers.get("host"), bindHost, env)) {
		return new Response("forbidden: host not allowed", { status: 403 });
	}
	return null;
}

/**
 * The daemon token a request presents at connect time: `Authorization: Bearer`,
 * or, on a WebSocket upgrade only, a `token` query parameter (a browser-style
 * WebSocket cannot set headers). Plain HTTP requests never read the query,
 * because URLs end up in proxy logs and browser history.
 */
export function presentedToken(req: Request): string | null {
	const header = req.headers
		.get("authorization")
		?.replace(/^Bearer\s+/i, "")
		.trim();
	if (header) return header;
	if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;
	try {
		return new URL(req.url).searchParams.get("token");
	} catch {
		return null;
	}
}

/**
 * Compare two tokens without leaking where or how long they differ: hash both
 * to fixed-length SHA-256 digests, then compare the digests in constant time.
 */
/**
 * What a daemon answers to `identify` (#4829): HMAC-SHA256 over a fixed domain string, the
 * address the client dialled and the client's nonce, keyed by the daemon's secret. Binding
 * the target stops a relay: a squatter that forwards the challenge to the real daemon gets
 * a proof for another address, which the client rejects, or a refusal from the daemon.
 */
export function daemonProof(secret: string, nonce: string, target: string): string {
	return createHmac("sha256", secret).update(`8gent-daemon-v2:${target}:${nonce}`).digest("hex");
}

/** The `host:port` of a url a client dials, lower-cased, default ports filled in. */
export function dialTarget(url: string): string {
	const u = new URL(url);
	const port = u.port || (u.protocol === "wss:" || u.protocol === "https:" ? "443" : "80");
	return `${u.hostname.toLowerCase()}:${port}`;
}

const bare = (h: string) => h.toLowerCase().replace(/^\[|\]$/g, "");
const LOOPBACK_LITERALS = new Set(["127.0.0.1", "::1"]);

/**
 * The hosts a client may have dialled to reach a daemon bound to `bindHost`: the bound
 * address exactly, never "any loopback alias" (a squatter on [::1]:P must not pass for a
 * daemon on 127.0.0.1:P). `localhost` is a name, not an address, so a daemon bound to it is
 * reached at 127.0.0.1, which clients dial by literal IP. A wildcard bind is reached at
 * 127.0.0.1 (and ::1 only for the dual-stack `::`), and at no other host.
 */
function dialledHostsFor(bindHost: string): string[] {
	const b = bare(bindHost);
	if (b === "localhost" || b === "127.0.0.1") return ["127.0.0.1"];
	if (b === "0.0.0.0") return ["127.0.0.1"];
	if (b === "::") return ["127.0.0.1", "::1"];
	return [b];
}

/**
 * Is `target` this daemon? Its own listening port, and a host that is exactly the address it
 * is bound to (see dialledHostsFor). A loopback target is honoured only when the peer is
 * itself on loopback: a remote peer cannot be speaking to this daemon at 127.0.0.1 (#4829).
 */
export function identifyTargetOk(
	target: unknown,
	ownPort: number,
	bindHost: string,
	peerLoopback = false,
): boolean {
	if (typeof target !== "string" || target.length > 300) return false;
	const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/.exec(target);
	if (!m) return false;
	if (Number(m[2]) !== ownPort) return false;
	const host = bare(m[1]);
	if (LOOPBACK_LITERALS.has(host) && !peerLoopback) return false;
	return dialledHostsFor(bindHost).includes(host);
}

export function sameToken(a: unknown, b: string): boolean {
	if (typeof a !== "string") return false;
	const x = createHash("sha256").update(a).digest();
	const y = createHash("sha256").update(b).digest();
	return timingSafeEqual(x, y);
}

/**
 * 401 unless the request presents the daemon token, when one is configured.
 * No token configured means a loopback-only bind (assertSafeBind), so null.
 */
export function requireToken(req: Request, authToken: string | null): Response | null {
	if (!authToken) return null;
	const got = presentedToken(req);
	if (got && sameToken(got, authToken)) return null;
	return new Response("unauthorized: daemon token required", { status: 401 });
}
