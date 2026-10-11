/**
 * Fail closed on any endpoint that is not this machine.
 *
 * Screenshots carry whatever is on screen: mail, messages, credentials in a
 * password field. The grounder sends the whole frame to a model, so the model
 * must be on-device. This is checked on every call, not once at startup, so a
 * changed env var or a redirecting config cannot move frames off the machine
 * mid-session.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class NonLoopbackEndpointError extends Error {
	constructor(endpoint: string) {
		super(
			`grounding endpoint ${endpoint} is not loopback; screenshots never leave this machine. Use http://127.0.0.1:<port>.`,
		);
		this.name = "NonLoopbackEndpointError";
	}
}

/** Throws NonLoopbackEndpointError unless `endpoint` is http(s) on 127.0.0.1, ::1 or localhost. */
export function assertLoopback(endpoint: string): URL {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new NonLoopbackEndpointError(endpoint);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new NonLoopbackEndpointError(endpoint);
	}
	// Credentials in the URL are a sign of a proxy or a remote; refuse.
	if (url.username || url.password) throw new NonLoopbackEndpointError(endpoint);
	const host = url.hostname.toLowerCase();
	if (!LOOPBACK_HOSTS.has(host)) throw new NonLoopbackEndpointError(endpoint);
	return url;
}

/** fetch() that refuses redirects, so a loopback proxy cannot bounce frames elsewhere. */
export async function loopbackFetch(endpoint: string, path: string, init: RequestInit): Promise<Response> {
	const base = assertLoopback(endpoint);
	const target = new URL(path, base);
	assertLoopback(target.toString());
	return fetch(target, { ...init, redirect: "error" });
}
