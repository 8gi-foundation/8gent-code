#!/usr/bin/env bun
// Mock /computer route for CI smoke tests of the Swift headless mode.
// Implements only the surface the Swift client needs: it accepts an
// `intent` message, emits one `token` with `final: true`, then a `done`
// event with reason `turn-complete`.
//
// This is NOT a real daemon and NOT used outside CI.

const PROTOCOL_VERSION = 1;
const port = Number.parseInt(process.env.MOCK_PORT ?? "18789", 10);

const server = Bun.serve({
	port,
	hostname: "127.0.0.1",
	fetch(req, srv) {
		const url = new URL(req.url);
		if (url.pathname === "/computer") {
			if (srv.upgrade(req)) return undefined;
			return new Response("upgrade required", { status: 426 });
		}
		if (url.pathname === "/health") {
			return Response.json({ status: "ok", mock: true });
		}
		return new Response("not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			const sessionId = `s_mock_${Date.now().toString(36)}`;
			(ws as unknown as { data: { sessionId: string } }).data = { sessionId };
			ws.send(
				JSON.stringify({
					protocol_version: PROTOCOL_VERSION,
					type: "ack",
					payload: { type: "session:created", sessionId, channel: "computer" },
				}),
			);
		},
		message(ws, raw) {
			let msg: { type?: string; text?: string };
			try {
				msg = JSON.parse(
					typeof raw === "string" ? raw : new TextDecoder().decode(raw),
				);
			} catch {
				ws.send(
					JSON.stringify({
						protocol_version: PROTOCOL_VERSION,
						type: "error",
						payload: { message: "invalid JSON" },
					}),
				);
				return;
			}
			const sid = (ws as unknown as { data: { sessionId: string } }).data
				.sessionId;
			if (msg.type === "ping") {
				ws.send(
					JSON.stringify({
						protocol_version: PROTOCOL_VERSION,
						type: "ack",
						payload: { type: "pong" },
					}),
				);
				return;
			}
			if (msg.type === "intent") {
				const reply = `pong: ${msg.text ?? ""}`;
				ws.send(
					JSON.stringify({
						protocol_version: PROTOCOL_VERSION,
						type: "event",
						event: { kind: "token", sessionId: sid, chunk: reply, final: true },
					}),
				);
				ws.send(
					JSON.stringify({
						protocol_version: PROTOCOL_VERSION,
						type: "event",
						event: { kind: "done", sessionId: sid, reason: "turn-complete" },
					}),
				);
				return;
			}
		},
		close() {
			// Nothing to clean up.
		},
	},
});

console.error(
	`mock daemon listening on ws://127.0.0.1:${server.port}/computer`,
);
