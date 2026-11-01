#!/usr/bin/env node
/**
 * Proves a running daemon answers a client the way the TUI reaches it (#4852):
 * GET /health says ok, then a WebSocket to the same port answers `sessions:list`
 * with a session list. Plain Node 22+, no Bun, no dependencies, so Termux runs
 * it as is. Exits 0 on success; on any failure prints one FAIL line and exits 1.
 *
 *   node scripts/daemon-attach-check.mjs <port> [host]
 */
const port = Number(process.argv[2]);
const host = process.argv[3] ?? "127.0.0.1";
const TIMEOUT_MS = Number(process.env.ATTACH_CHECK_TIMEOUT_MS ?? 10000);

const fail = (msg) => {
	console.error(`FAIL  ${msg}`);
	process.exit(1);
};

if (!Number.isInteger(port) || port < 1 || port > 65535)
	fail("usage: daemon-attach-check.mjs <port> [host]");
setTimeout(() => fail(`no answer within ${TIMEOUT_MS}ms`), TIMEOUT_MS).unref();

let health;
try {
	const res = await fetch(`http://${host}:${port}/health`);
	if (res.status !== 200) fail(`GET /health returned ${res.status}`);
	health = await res.json();
} catch (err) {
	fail(`GET /health on ${host}:${port}: ${err?.message ?? err}`);
}
if (health?.status !== "ok")
	fail(`/health body has no status "ok": ${JSON.stringify(health).slice(0, 200)}`);
console.log(`PASS  /health ok (uptime ${Math.round(health.uptime)}s, ${health.sessions} sessions)`);

const reply = await new Promise((resolve) => {
	const ws = new WebSocket(`ws://${host}:${port}/`);
	ws.onopen = () => ws.send(JSON.stringify({ type: "sessions:list" }));
	ws.onmessage = (e) => {
		let m;
		try {
			m = JSON.parse(String(e.data));
		} catch {
			return resolve({ error: `non-JSON frame: ${String(e.data).slice(0, 100)}` });
		}
		if (m.type === "auth:fail" || m.type === "error")
			return resolve({ error: `${m.type}: ${m.message ?? ""}` });
		if (m.type === "sessions:list") {
			ws.close();
			resolve({ list: m.sessions });
		}
	};
	ws.onerror = () =>
		resolve({ error: "WebSocket error (handshake refused or connection dropped)" });
	ws.onclose = (e) => resolve({ error: `socket closed (${e.code}) before a session list arrived` });
});
if (reply.error) fail(`WebSocket attach: ${reply.error}`);
if (!Array.isArray(reply.list)) fail("sessions:list reply carries no array");
console.log(`PASS  WebSocket attach: sessions:list answered (${reply.list.length} sessions)`);
process.exit(0);
