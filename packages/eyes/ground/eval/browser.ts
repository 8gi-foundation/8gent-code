/**
 * Minimal client for 8gent Browser's loopback, token-gated control server
 * (ws://127.0.0.1:7980). The eval opens its own tabs, reads element rects with
 * page.query and screenshots with page.screenshot, and closes what it opened.
 * The token is read from ~/.8gent/browser-control.token and never printed.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.EIGHT_BROWSER_CONTROL_PORT) || 7980;

export function call<T = unknown>(
	cmd: string,
	args: Record<string, unknown> = {},
	timeoutMs = 60_000,
): Promise<T> {
	const token = readFileSync(join(homedir(), ".8gent", "browser-control.token"), "utf8").trim();
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
		const timer = setTimeout(() => {
			ws.close();
			reject(new Error(`timeout on ${cmd}`));
		}, timeoutMs);
		ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
		ws.onerror = () => {
			clearTimeout(timer);
			reject(new Error(`8gent Browser not reachable on ${PORT}`));
		};
		ws.onmessage = (ev) => {
			const m = JSON.parse(String(ev.data));
			if (m.type === "auth_ok") return ws.send(JSON.stringify({ id: 1, cmd, args }));
			if (m.type === "error") {
				clearTimeout(timer);
				ws.close();
				return reject(new Error(m.error));
			}
			if (m.id === 1) {
				clearTimeout(timer);
				ws.close();
				return m.ok ? resolve(m.result) : reject(new Error(m.error));
			}
		};
	});
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
