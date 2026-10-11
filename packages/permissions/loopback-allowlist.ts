/**
 * The run's own loopback servers: the only 127.0.0.1 / localhost / [::1] ports a session may
 * open in the browser or follow redirects on with curl (everyday-tasks lane: #3785, #3967).
 *
 * Never "all of 127.0.0.1". This machine runs services on loopback (the 8gent Browser control
 * channel, the daemon, Ollama, LM Studio), so loopback is refused unless a port is listed here.
 *
 * Two sources, both explicit, both read ONCE per process and workspace, then frozen:
 *   - run config:  EIGHT_BROWSER_ALLOW_LOOPBACK="127.0.0.1:5173,localhost:3000"
 *   - workspace:   <workspace>/.8gent/allow-loopback.json  {"allow": ["127.0.0.1:5173"]}
 * Frozen means a session cannot widen its own list: a file written by a tool after the first
 * read changes nothing until the next process.
 *
 * An entry is a loopback host with an explicit port. Bare hosts, wildcards, ranges, other hosts
 * and the reserved service ports below are dropped. 127.0.0.1, localhost and [::1] reach the same
 * server, so the list is a set of ports on loopback.
 *
 * Synchronous, never throws.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** Loopback ports that are never a run's test server, whatever the list says. */
export const RESERVED_LOOPBACK_PORTS: ReadonlySet<number> = new Set([
	7980, // 8gent Browser control channel (default profile)
	18789, // 8gent daemon
	18790, // Telegram bridge health
	11434, // Ollama
	1234, // LM Studio
	21434, // M5 tunnel
]);

const ENTRY = /^(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/;

/** The port of one allowlist entry, or null when the entry is not an allowed loopback host:port. */
export function parseLoopbackEntry(raw: unknown): number | null {
	if (typeof raw !== "string") return null;
	const m = ENTRY.exec(raw.trim().toLowerCase());
	if (!m) return null;
	const port = Number(m[1]);
	if (port < 1 || port > 65535 || RESERVED_LOOPBACK_PORTS.has(port)) return null;
	return port;
}

function fromEnv(env: Env): number[] {
	return (env.EIGHT_BROWSER_ALLOW_LOOPBACK ?? "")
		.split(",")
		.map(parseLoopbackEntry)
		.filter((p): p is number => p !== null);
}

function fromWorkspace(workspace: string): number[] {
	try {
		const data = JSON.parse(readFileSync(join(workspace, ".8gent", "allow-loopback.json"), "utf8"));
		if (!data || !Array.isArray(data.allow)) return [];
		return data.allow.map(parseLoopbackEntry).filter((p: number | null): p is number => p !== null);
	} catch {
		return [];
	}
}

const frozen = new Map<string, ReadonlySet<number>>();

/** Allowed loopback ports for this workspace: env plus workspace file, read once, then frozen. */
export function allowedLoopbackPorts(
	workspace: string,
	env: Env = process.env,
): ReadonlySet<number> {
	const key = `${workspace}\u0000${env.EIGHT_BROWSER_ALLOW_LOOPBACK ?? ""}`;
	let ports = frozen.get(key);
	if (!ports) {
		ports = new Set([...fromEnv(env), ...fromWorkspace(workspace)]);
		frozen.set(key, ports);
	}
	return ports;
}

/** True when `url` is http(s) to a loopback host on an allowed port. No userinfo, explicit port only. */
export function isAllowedLoopbackUrl(
	url: string,
	workspace: string,
	env: Env = process.env,
): boolean {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return false;
	if (u.username || u.password || !u.port) return false;
	const port = parseLoopbackEntry(`${u.hostname}:${u.port}`);
	return port !== null && allowedLoopbackPorts(workspace, env).has(port);
}

/** Test seam: forget frozen lists. */
export function _resetLoopbackAllowlistForTest(): void {
	frozen.clear();
}
