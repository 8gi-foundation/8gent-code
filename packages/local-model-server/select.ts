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

/** True for localhost, 127.0.0.0/8 and ::1: the only hosts prompts may reach without opting in. */
export function isLoopbackUrl(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
	} catch {
		return false;
	}
	return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

const warnedRemote = new Set<string>();

/**
 * llama-server root: LLAMA_SERVER_URL, else 127.0.0.1:8080. Scheme added to a bare host:port.
 * A non-loopback URL is refused (the loopback default is used, with one warning) unless
 * EIGHT_ALLOW_REMOTE_LLAMA=1, so prompts never leave the machine by a typo or a stale env.
 */
export function resolveLlamaServerUrl(
	env: Env = process.env,
	warn: (line: string) => void = console.warn,
): string {
	let v = (env.LLAMA_SERVER_URL ?? "").trim().replace(/\/+$/, "");
	if (!v) return DEFAULT_LLAMA_SERVER_URL;
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `http://${v}`;
	v = v.replace(/\/v1$/, "").replace(/\/+$/, "");
	if (isLoopbackUrl(v) || env.EIGHT_ALLOW_REMOTE_LLAMA === "1") return v;
	if (!warnedRemote.has(v)) {
		warnedRemote.add(v);
		warn(
			`LLAMA_SERVER_URL ${v} is not loopback; using ${DEFAULT_LLAMA_SERVER_URL}. Set EIGHT_ALLOW_REMOTE_LLAMA=1 to allow it.`,
		);
	}
	return DEFAULT_LLAMA_SERVER_URL;
}
