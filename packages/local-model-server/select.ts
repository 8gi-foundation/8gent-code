/**
 * Which local model server this process uses (#3149, phase 2).
 *
 * EIGHT_LOCAL_SERVER picks it: "ollama" (the default, today's behaviour) or
 * "llama-server". With llama-server selected, Ollama is off for the process:
 * nothing probes, lists or calls it, so a machine with no Ollama runs end to
 * end on llama.cpp alone. Behind the flag until the no-Ollama run is proven.
 *
 * LLAMA_SERVER_URL names the llama-server root (default http://127.0.0.1:8080,
 * llama-server's own default). A trailing "/v1" or slash is tolerated.
 */

import type { LocalServerKind } from "./server";

type Env = Record<string, string | undefined>;

export const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080";

/** The provider id the registry and the TUI use for llama-server. */
export const LLAMA_SERVER_PROVIDER = "llama-server";

const KINDS: readonly LocalServerKind[] = ["ollama", "llama-server"];

/** The selected local server kind. Unset, blank or unknown means "ollama". */
export function resolveLocalServerKind(env: Env = process.env): LocalServerKind {
	const kind = (env.EIGHT_LOCAL_SERVER ?? "").trim().toLowerCase().replace(/_/g, "-");
	return (KINDS as readonly string[]).includes(kind) ? (kind as LocalServerKind) : "ollama";
}

/** False when another local server is selected: the process must not contact Ollama at all. */
export function isOllamaEnabled(env: Env = process.env): boolean {
	return resolveLocalServerKind(env) === "ollama";
}

/** True when llama-server is the selected local server. */
export function isLlamaServerSelected(env: Env = process.env): boolean {
	return resolveLocalServerKind(env) === "llama-server";
}

/** True for an http(s) URL on localhost, 127.0.0.0/8 or ::1: the only hosts prompts may reach without opting in. */
export function isLoopbackUrl(url: string): boolean {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return false;
	const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** The URL with any user:password removed, for log and screen lines. */
export function redactUrl(url: string): string {
	try {
		const u = new URL(url);
		if (!u.username && !u.password) return url;
		u.username = "";
		u.password = "";
		return u.toString().replace(/\/+$/, "");
	} catch {
		return url.replace(/\/\/[^/@]*@/, "//");
	}
}

function isHttpUrl(url: string): boolean {
	try {
		const p = new URL(url).protocol;
		return p === "http:" || p === "https:";
	} catch {
		return false;
	}
}

const warnedRemote = new Set<string>();

/**
 * llama-server root: LLAMA_SERVER_URL, else 127.0.0.1:8080. Scheme added to a bare host:port.
 * A non-loopback URL is refused (the loopback default is used, with one warning) unless
 * EIGHT_ALLOW_REMOTE_LLAMA=1, so prompts never leave the machine by a typo or a stale env.
 * A scheme other than http(s) (file:, data:) is always refused: fetch would read it locally.
 */
export function resolveLlamaServerUrl(
	env: Env = process.env,
	warn: (line: string) => void = console.warn,
): string {
	let v = (env.LLAMA_SERVER_URL ?? "").trim().replace(/\/+$/, "");
	if (!v) return DEFAULT_LLAMA_SERVER_URL;
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `http://${v}`;
	v = v.replace(/\/v1$/, "").replace(/\/+$/, "");
	if (isLoopbackUrl(v) || (env.EIGHT_ALLOW_REMOTE_LLAMA === "1" && isHttpUrl(v))) return v;
	if (!warnedRemote.has(v)) {
		warnedRemote.add(v);
		warn(
			`LLAMA_SERVER_URL ${redactUrl(v)} is not a loopback http(s) URL; using ${DEFAULT_LLAMA_SERVER_URL}. Set EIGHT_ALLOW_REMOTE_LLAMA=1 to allow it.`,
		);
	}
	return DEFAULT_LLAMA_SERVER_URL;
}
