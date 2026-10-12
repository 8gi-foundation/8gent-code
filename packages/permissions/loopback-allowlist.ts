/**
 * The run's own loopback servers: the only 127.0.0.1 / localhost / [::1] ports an isolated
 * browser profile may open (everyday-tasks lane, #3785).
 *
 * Never "all of 127.0.0.1". This machine runs services on loopback (the 8gent Browser control
 * channel, the daemon, Ollama, apfel, LM Studio, the decider, Chrome's debug port, Convex dev),
 * so loopback is refused unless a port is listed, and the reserved ports below never are.
 *
 * Trusted sources only (8SO review of #4067), read ONCE per process, then frozen:
 *   - run config:  EIGHT_BROWSER_ALLOW_LOOPBACK="127.0.0.1:5173,localhost:3000" (the launcher's env;
 *                  the pilot sets it from its own setup)
 *   - user file:   ~/.8gent/allow-loopback.json  {"allow": ["127.0.0.1:5173"]}
 * A workspace file (<workspace>/.8gent/allow-loopback.json) is NOT a source: anyone who can put
 * a file in a repo could otherwise point the browser at this machine's services. It is ignored,
 * and ignoredWorkspaceAllowlist() says so. Frozen means a session cannot widen its own list: a
 * file written by a tool after the first read changes nothing until the next process.
 *
 * An entry is a loopback host with an explicit port. Bare hosts, wildcards, ranges, other hosts
 * and reserved ports are dropped. 127.0.0.1, localhost and [::1] reach the same server, so the
 * list is a set of ports on loopback.
 *
 * Synchronous, never throws.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** Loopback ports that are never a run's test server, whatever a list says. */
export const RESERVED_LOOPBACK_PORTS: ReadonlySet<number> = new Set([
	7980, // 8gent Browser control channel (default profile)
	18789, // 8gent daemon
	18790, // Telegram bridge health
	11434, // Ollama
	11435, // apfel
	1234, // LM Studio
	21434, // M5 tunnel
	8000, // decider
	9222, // Chrome remote debugging
	3210, // Convex local backend
	3211, // Convex local site / HTTP actions
	6790, // Convex local dashboard
	6791, // Convex local dashboard
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

function fromFile(file: string): number[] {
	try {
		const data = JSON.parse(readFileSync(file, "utf8"));
		if (!data || !Array.isArray(data.allow)) return [];
		return data.allow.map(parseLoopbackEntry).filter((p: number | null): p is number => p !== null);
	} catch {
		return [];
	}
}

const frozen = new Map<string, ReadonlySet<number>>();

/** Allowed loopback ports: the env list plus ~/.8gent/allow-loopback.json, read once, then frozen. */
export function allowedLoopbackPorts(
	env: Env = process.env,
	home: string = homedir(),
): ReadonlySet<number> {
	const key = `${home}\u0000${env.EIGHT_BROWSER_ALLOW_LOOPBACK ?? ""}`;
	let ports = frozen.get(key);
	if (!ports) {
		ports = new Set([...fromEnv(env), ...fromFile(join(home, ".8gent", "allow-loopback.json"))]);
		frozen.set(key, ports);
	}
	return ports;
}

/** True when `url` is http(s) to a loopback host on an allowed port. No userinfo, explicit port only. */
export function isAllowedLoopbackUrl(
	url: string,
	env: Env = process.env,
	home: string = homedir(),
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
	return port !== null && allowedLoopbackPorts(env, home).has(port);
}

/** A one-line note when the workspace carries an allow-loopback.json that was ignored, else null. */
export function ignoredWorkspaceAllowlist(workspace: string | undefined): string | null {
	if (!workspace || !existsSync(join(workspace, ".8gent", "allow-loopback.json"))) return null;
	return "Ignored .8gent/allow-loopback.json in this workspace: a repo file cannot open local ports. Use EIGHT_BROWSER_ALLOW_LOOPBACK or ~/.8gent/allow-loopback.json.";
}

/** Test seam: forget frozen lists. */
export function _resetLoopbackAllowlistForTest(): void {
	frozen.clear();
}
