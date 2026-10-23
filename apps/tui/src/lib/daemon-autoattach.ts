/**
 * Auto-attach to a running local daemon (#4829, epic #4792 slice 1).
 *
 * The decision and the probe live here, pure and injectable, so app.tsx only
 * wires them. Design: docs/specs/TUI-DAEMON-CLIENT.md section 6.
 *
 *   EIGHT_TUI_DAEMON=off   never auto-attach (anything else means auto)
 *   EIGHT_DAEMON_URL       which daemon to look for, default ws://127.0.0.1:18789
 */

import { DEFAULT_DAEMON_URL } from "./daemon-sessions";

/** The first screen never waits on the probe; this bounds how long it keeps trying. */
export const PROBE_BUDGET_MS = 600;

export type AutoAttachMode = "auto" | "off";

export function autoAttachMode(
	env: Record<string, string | undefined> = process.env,
): AutoAttachMode {
	const v = (env.EIGHT_TUI_DAEMON ?? "").trim().toLowerCase();
	return v === "off" || v === "0" || v === "false" || v === "no" ? "off" : "auto";
}

/** The daemon's /health url, from its socket url. The token (query or fragment) is dropped. */
export function daemonHealthUrl(env: Record<string, string | undefined> = process.env): string {
	const u = new URL(env.EIGHT_DAEMON_URL ?? DEFAULT_DAEMON_URL);
	u.protocol = u.protocol === "wss:" ? "https:" : "http:";
	u.pathname = "/health";
	u.search = "";
	u.hash = "";
	return u.toString();
}

/** True once the person has sent a turn this run: attaching then would replace what they see. */
export function hasTypedTurn(messages: ReadonlyArray<{ id: string; role: string }>): boolean {
	return messages.some((m) => m.role === "user" && /^(voice-)?user-/.test(m.id));
}

/**
 * Is an 8gent daemon answering at `healthUrl`? Needs the daemon's own /health
 * shape ({status:"ok", sessions, uptime}) so another service on the port is not
 * mistaken for it. Never throws, never outlives `timeoutMs`.
 */
export async function probeDaemon(
	healthUrl: string,
	opts: { fetch?: (url: string, init?: RequestInit) => Promise<Response>; timeoutMs?: number } = {},
): Promise<boolean> {
	const doFetch = opts.fetch ?? fetch;
	const ms = opts.timeoutMs ?? PROBE_BUDGET_MS;
	const ctl = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const budget = new Promise<false>((resolve) => {
		timer = setTimeout(() => {
			ctl.abort();
			resolve(false);
		}, ms);
	});
	const ask = (async () => {
		try {
			const r = await doFetch(healthUrl, { signal: ctl.signal });
			if (!r.ok) return false;
			const b = (await r.json()) as { status?: unknown; sessions?: unknown; uptime?: unknown };
			return b?.status === "ok" && typeof b.sessions === "number" && typeof b.uptime === "number";
		} catch {
			return false;
		}
	})();
	try {
		return await Promise.race([ask, budget]);
	} finally {
		clearTimeout(timer);
	}
}
