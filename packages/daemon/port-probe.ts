/**
 * `8gent daemon run` when the port is already taken.
 *
 * The common cause is that a daemon is already running (a login service, or
 * another terminal). Bun's own "Failed to start server. Is port N in use?"
 * reads like a failure, so we ask the port first: if an 8gent daemon answers
 * /health there is nothing to do, and that is a success.
 */

import { createConnection } from "node:net";

export type PortProbe =
	| { kind: "daemon"; uptimeSeconds: number; sessions: number | null }
	| { kind: "other"; holder: string | null }
	| { kind: "free" };

/** The daemon's /health body: { status: "ok", sessions, uptime } (gateway.ts). */
function parseDaemonHealth(
	body: unknown,
): { uptimeSeconds: number; sessions: number | null } | null {
	if (!body || typeof body !== "object") return null;
	const b = body as Record<string, unknown>;
	if (b.status !== "ok" || typeof b.uptime !== "number") return null;
	return { uptimeSeconds: b.uptime, sessions: typeof b.sessions === "number" ? b.sessions : null };
}

function tcpAccepts(port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = createConnection({ host: "127.0.0.1", port });
		const done = (ok: boolean) => {
			sock.destroy();
			resolve(ok);
		};
		sock.setTimeout(timeoutMs, () => done(true)); // listening but silent still counts as held
		sock.once("connect", () => done(true));
		sock.once("error", () => done(false));
	});
}

/** Best effort: "bun (pid 1234)" for whatever listens on the port, or null. */
export function describePortHolder(port: number): string | null {
	try {
		const out = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
			stdout: "pipe",
			stderr: "ignore",
		}).stdout.toString();
		const pid = /^p(\d+)/m.exec(out)?.[1];
		const cmd = /^c(.+)$/m.exec(out)?.[1];
		return pid ? `${cmd ?? "a process"} (pid ${pid})` : null;
	} catch {
		return null;
	}
}

export async function probePort(
	port: number,
	opts: {
		fetchImpl?: typeof fetch;
		timeoutMs?: number;
		holder?: (port: number) => string | null;
	} = {},
): Promise<PortProbe> {
	const { fetchImpl = fetch, timeoutMs = 1500, holder = describePortHolder } = opts;
	try {
		const res = await fetchImpl(`http://127.0.0.1:${port}/health`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		const health = res.ok ? parseDaemonHealth(await res.json().catch(() => null)) : null;
		if (health) return { kind: "daemon", ...health };
		return { kind: "other", holder: holder(port) };
	} catch {
		return (await tcpAccepts(port, timeoutMs))
			? { kind: "other", holder: holder(port) }
			: { kind: "free" };
	}
}

export function formatUptime(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m`;
	return `${s}s`;
}

/** What `daemon run` prints and exits with for a taken port. null means go ahead and start. */
export function portVerdict(
	port: number,
	probe: PortProbe,
): { message: string; code: number } | null {
	if (probe.kind === "free") return null;
	if (probe.kind === "daemon") {
		return {
			message: `8gent is already running on 127.0.0.1:${port} (uptime ${formatUptime(probe.uptimeSeconds)}). Nothing to do.`,
			code: 0,
		};
	}
	const who = probe.holder ? `${probe.holder} is using` : "Something else is using";
	return {
		message: `Cannot start: ${who} port ${port}, and it is not an 8gent daemon. Stop it, or set a different daemon.port in ~/.8gent/config.json.`,
		code: 1,
	};
}
