/**
 * 8gent Code - Outbound network guard for model-driven fetches (#3233)
 *
 * web_fetch takes a URL from the model. Without a guard that URL can point at
 * loopback (the local daemon), the LAN (a router admin page), or on a hosted
 * vessel the cloud metadata endpoint, and whatever comes back lands in the
 * model's context. This module refuses those destinations.
 *
 * Three rules:
 *   1. Every address a host resolves to must be public. One private answer
 *      refuses the whole host: a mixed DNS answer is what a rebinding attack
 *      looks like.
 *   2. The connection goes to the address that was checked, never to a second
 *      lookup of the name. The request is sent to the IP literal with the
 *      original Host header and TLS server name, so a rebinding DNS server gets
 *      one answer and that answer is the one that was validated.
 *   3. Redirects are followed by hand, at most MAX_REDIRECTS hops, and every
 *      hop goes through rules 1 and 2 again.
 *
 * There is no localhost opt-in: no existing config or caller needs web_fetch to
 * reach a local service. Local services are reached with the tools built for
 * them, not through a fetch the model steers.
 */

import dns from "node:dns/promises";
import net from "node:net";

export const MAX_REDIRECTS = 5;

export class BlockedDestinationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BlockedDestinationError";
	}
}

export interface ResolvedAddress {
	address: string;
	family: 4 | 6;
}

/** Resolves a hostname to every address it has. Injectable for tests. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export interface NetDeps {
	resolve?: Resolver;
	fetchImpl?: FetchImpl;
}

const defaultResolve: Resolver = async (hostname) => {
	const answers = await dns.lookup(hostname, { all: true, verbatim: true });
	return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

// ============================================
// Address classification
// ============================================

/** [network, prefix length, label] for IPv4 ranges that are never fetched. */
const BLOCKED_V4: Array<[string, number, string]> = [
	["0.0.0.0", 8, "unspecified"],
	["10.0.0.0", 8, "private network"],
	["100.64.0.0", 10, "carrier-grade NAT"],
	["127.0.0.0", 8, "loopback"],
	["169.254.0.0", 16, "link-local / cloud metadata"],
	["172.16.0.0", 12, "private network"],
	["192.0.0.0", 24, "IETF protocol assignments"],
	["192.0.2.0", 24, "documentation"],
	["192.88.99.0", 24, "6to4 relay"],
	["192.168.0.0", 16, "private network"],
	["198.18.0.0", 15, "benchmarking"],
	["198.51.100.0", 24, "documentation"],
	["203.0.113.0", 24, "documentation"],
	["224.0.0.0", 4, "multicast"],
	["240.0.0.0", 4, "reserved"],
];

function v4ToInt(ip: string): number {
	return ip.split(".").reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

function v4FromBytes(b: number[]): string {
	return b.join(".");
}

/** Returns why an IPv4 address is refused, or null when it is public. */
function classifyV4(ip: string): string | null {
	const n = v4ToInt(ip);
	for (const [base, prefix, label] of BLOCKED_V4) {
		const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
		if ((n & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0) return label;
	}
	return null;
}

/** Parses an IPv6 literal (no brackets) into 16 bytes, or null if malformed. */
function parseV6(input: string): number[] | null {
	let ip = input;
	const zone = ip.indexOf("%");
	if (zone !== -1) ip = ip.slice(0, zone);

	// A dotted-quad tail (::ffff:1.2.3.4) becomes two hextets.
	const lastColon = ip.lastIndexOf(":");
	const tail = ip.slice(lastColon + 1);
	if (tail.includes(".")) {
		if (net.isIPv4(tail) === false) return null;
		const [a, b, c, d] = tail.split(".").map(Number);
		ip = `${ip.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}

	const halves = ip.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];

	const bytes: number[] = [];
	for (const g of groups) {
		if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
		const v = Number.parseInt(g, 16);
		bytes.push(v >> 8, v & 0xff);
	}
	return bytes;
}

/** Returns why an IPv6 address is refused, or null when it is public. */
function classifyV6(ip: string): string | null {
	const b = parseV6(ip);
	if (!b) return "unparseable IPv6 address";

	const zeroPrefix = (len: number) => b.slice(0, len).every((x) => x === 0);
	const embedded = (from: number) => v4FromBytes(b.slice(from, from + 4));
	const viaV4 = (label: string, v4: string) => {
		const why = classifyV4(v4);
		return why ? `${label} of ${v4} (${why})` : null;
	};

	if (b.every((x) => x === 0)) return "unspecified";
	if (zeroPrefix(15) && b[15] === 1) return "loopback";
	// ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible) reach the IPv4 host.
	if (zeroPrefix(10) && b[10] === 0xff && b[11] === 0xff) {
		return viaV4("IPv4-mapped form", embedded(12));
	}
	if (zeroPrefix(12)) return viaV4("IPv4-compatible form", embedded(12));
	// 64:ff9b::/96 is NAT64: the gateway connects to the embedded IPv4 host.
	if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
		if (b.slice(4, 12).every((x) => x === 0)) return viaV4("NAT64 form", embedded(12));
		return "local-use NAT64";
	}
	// 2002::/16 is 6to4: bytes 2-5 are the IPv4 host.
	if (b[0] === 0x20 && b[1] === 0x02) return viaV4("6to4 form", embedded(2));
	// 2001:0::/32 Teredo hides the client address; refuse the whole range.
	if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return "Teredo tunnel";
	if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "documentation";
	if ((b[0] & 0xfe) === 0xfc) return "unique local (private) / cloud metadata";
	if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return "link-local";
	if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return "site-local";
	if (b[0] === 0xff) return "multicast";
	// Everything public lives in 2000::/3. Anything else is reserved or special.
	if ((b[0] & 0xe0) !== 0x20) return "not global unicast";
	return null;
}

/**
 * Returns why an IP address must not be fetched, or null when it is a public
 * internet address. Anything that is not a valid IP is refused.
 */
export function classifyAddress(ip: string): string | null {
	const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
	const kind = net.isIP(bare.split("%")[0]);
	if (kind === 4) return classifyV4(bare);
	if (kind === 6) return classifyV6(bare);
	return "not an IP address";
}

/** Names that only ever mean "this machine" or "this network". */
function classifyHostname(host: string): string | null {
	const h = host.toLowerCase().replace(/\.+$/, "");
	if (h === "") return "empty host";
	if (h === "localhost" || h.endsWith(".localhost")) return "loopback name";
	if (h.endsWith(".local")) return "mDNS local-network name";
	if (h === "internal" || h.endsWith(".internal"))
		return "internal name (cloud metadata / private DNS)";
	if (h.endsWith(".home.arpa")) return "home-network name";
	return null;
}

// ============================================
// Destination check
// ============================================

export interface CheckedDestination {
	url: URL;
	/** The validated address the request must connect to. */
	address: string;
	family: 4 | 6;
	/** True when the URL host was already an IP literal. */
	literal: boolean;
}

function refuse(url: URL, detail: string): never {
	throw new BlockedDestinationError(
		`Refused ${url.protocol}//${url.host}: ${detail}. web_fetch only reaches public internet addresses.`,
	);
}

/**
 * Parses a URL and proves every address behind it is public. Throws
 * BlockedDestinationError otherwise. Returns the address to pin the
 * connection to.
 */
export async function checkDestination(
	rawUrl: string,
	deps: NetDeps = {},
): Promise<CheckedDestination> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new BlockedDestinationError(`Refused: "${rawUrl}" is not a valid URL.`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		refuse(url, `scheme ${url.protocol} is not allowed`);
	}

	// WHATWG URL parsing already turned 2130706433, 0x7f.1 and 127.1 into
	// 127.0.0.1, so a numeric host arrives here in canonical form.
	const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;

	if (net.isIP(host)) {
		const why = classifyAddress(host);
		if (why) refuse(url, `${host} is blocked (${why})`);
		return { url, address: host, family: net.isIP(host) === 6 ? 6 : 4, literal: true };
	}

	const nameWhy = classifyHostname(host);
	if (nameWhy) refuse(url, `${host} is blocked (${nameWhy})`);

	let answers: ResolvedAddress[];
	try {
		answers = await (deps.resolve ?? defaultResolve)(host);
	} catch (err) {
		throw new BlockedDestinationError(
			`Refused ${url.host}: DNS lookup failed (${(err as Error).message}).`,
		);
	}
	if (answers.length === 0) refuse(url, `${host} did not resolve`);

	for (const a of answers) {
		const why = classifyAddress(a.address);
		if (why) refuse(url, `${host} resolves to ${a.address} (${why})`);
	}
	return { url, address: answers[0].address, family: answers[0].family, literal: false };
}

// ============================================
// Guarded fetch
// ============================================

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface GuardedResponse {
	response: Response;
	/** The logical URL of the final hop (hostname, not the pinned IP). */
	finalUrl: string;
}

/**
 * GET a URL that must be public, pinning each connection to the checked
 * address and re-checking every redirect hop.
 */
export async function guardedFetch(
	rawUrl: string,
	init: { headers?: Record<string, string> } = {},
	deps: NetDeps = {},
): Promise<GuardedResponse> {
	const doFetch: FetchImpl = deps.fetchImpl ?? ((input, reqInit) => fetch(input, reqInit));
	let current = rawUrl;

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const dest = await checkDestination(current, deps);
		const headers: Record<string, string> = { ...(init.headers ?? {}) };
		const reqInit: RequestInit & { tls?: { serverName: string } } = { redirect: "manual", headers };

		let target = dest.url.href;
		if (!dest.literal) {
			// Connect to the address we checked; keep the name for Host and TLS.
			const pinned = new URL(dest.url.href);
			pinned.hostname = dest.family === 6 ? `[${dest.address}]` : dest.address;
			target = pinned.href;
			headers.Host = dest.url.host;
			if (dest.url.protocol === "https:") reqInit.tls = { serverName: dest.url.hostname };
		}

		const response = await doFetch(target, reqInit);

		if (!REDIRECT_STATUSES.has(response.status)) {
			return { response, finalUrl: dest.url.href };
		}
		const location = response.headers.get("location");
		if (!location) return { response, finalUrl: dest.url.href };
		await response.body?.cancel().catch(() => {});

		if (hop === MAX_REDIRECTS) {
			throw new BlockedDestinationError(
				`Refused: more than ${MAX_REDIRECTS} redirects starting from ${rawUrl}.`,
			);
		}
		current = new URL(location, dest.url).href;
	}
	// Unreachable: the loop either returns or throws.
	throw new BlockedDestinationError(`Refused: redirect limit reached for ${rawUrl}.`);
}
