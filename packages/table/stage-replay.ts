/**
 * Stage replay harness.
 *
 *   bun run packages/table/stage-replay.ts <huddleId|manifest.json> [--hold]
 *
 * Serves the real stage page and replays a baked huddle's manifest over a real
 * WebSocket, emitting the exact `huddle:slide` / `huddle:speak` /
 * `huddle:floor_released` frames the daemon emits during a live huddle. The
 * stage cannot tell the difference, which is the point: it proves the stage
 * against real frames without needing the whole daemon, LM Studio and a
 * channel store booted first.
 *
 * It also ACKS: the harness waits for the stage's own `huddle:stage_ready`
 * before sending `huddle:speak`, so the sync gate of spec 5.1 is exercised for
 * real rather than assumed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { huddleDir } from "./bake";
import { stagePage } from "./stage";
import type { HuddleManifest } from "./bake";

const arg = process.argv[2];
const HOLD = process.argv.includes("--hold");
/**
 * --turn N sends exactly one turn, immediately on connect, and then idles.
 *
 * This exists for capture. Chrome's headless --virtual-time-budget fast-forwards
 * the PAGE's clock but not the server's, so a replay that paces turns with real
 * setTimeouts can be screenshotted before the iframe has painted - which looks
 * exactly like a broken stage and is not one. Pinning a single turn removes the
 * race entirely, so a frame grab shows what a viewer actually sees.
 */
const turnArg = process.argv.indexOf("--turn");
const ONLY_TURN = turnArg > -1 ? Number(process.argv[turnArg + 1]) : -1;
if (!arg) {
	console.error("usage: bun run packages/table/stage-replay.ts <huddleId|manifest.json> [--hold]");
	process.exit(1);
}

const manifestPath = arg.endsWith(".json") ? arg : join(huddleDir(arg), "manifest.json");
if (!existsSync(manifestPath)) {
	console.error(`no manifest at ${manifestPath}`);
	process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as HuddleManifest;
const dir = huddleDir(manifest.huddleId);

const ready = new Map<string, () => void>();

const server = Bun.serve({
	port: 0,
	fetch(req, srv) {
		const url = new URL(req.url);
		if (srv.upgrade(req)) return undefined;
		if (url.pathname === `/huddle/${manifest.huddleId}/stage`) {
			return new Response(stagePage({ huddleId: manifest.huddleId, wsUrl: `ws://127.0.0.1:${srv.port}`, topic: manifest.topic }), {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}
		const m = /^\/huddle\/[^/]+\/(slides|audio)\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
		if (m) {
			const path = join(dir, m[1], m[2]);
			if (existsSync(path)) {
				return new Response(readFileSync(path), {
					headers: { "content-type": m[1] === "audio" ? "audio/wav" : "text/html; charset=utf-8" },
				});
			}
		}
		return new Response("not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			void replay(ws as unknown as { send(data: string): void });
		},
		message(_ws, raw) {
			try {
				const msg = JSON.parse(String(raw)) as { type?: string; turnId?: string };
				if (msg.type === "huddle:stage_ready" && msg.turnId) {
					const resolve = ready.get(msg.turnId);
					if (resolve) {
						ready.delete(msg.turnId);
						resolve();
					}
				}
			} catch {
				// A malformed frame from a page we serve ourselves is not worth
				// tearing the replay down for.
			}
		},
	},
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function awaitReady(turnId: string, capMs = 3000): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			ready.delete(turnId);
			resolve();
		}, capMs);
		ready.set(turnId, () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

async function replay(ws: { send(data: string): void }): Promise<void> {
	const turns = ONLY_TURN >= 0 ? manifest.turns.filter((t) => t.index === ONLY_TURN) : manifest.turns;
	for (const turn of turns) {
		const htmlPath = join(dir, "slides", `slide-${turn.turnId}.html`);
		if (!existsSync(htmlPath)) continue;

		ws.send(
			JSON.stringify({
				type: "huddle:floor",
				huddleId: manifest.huddleId,
				turnId: turn.turnId,
				holder: turn.holder,
				name: turn.name,
				seat: "ring",
				phase: "preparing",
			}),
		);
		if (ONLY_TURN < 0) await wait(250);

		ws.send(
			JSON.stringify({
				type: "huddle:slide",
				huddleId: manifest.huddleId,
				turnId: turn.turnId,
				holder: turn.holder,
				name: turn.name,
				code: turn.code,
				html: readFileSync(htmlPath, "utf8"),
				sha256: turn.sha256,
				layout: turn.spec.layout,
				asserted: turn.assertedFields,
			}),
		);

		// THE GATE: voice only after the stage says the slide is composited.
		await awaitReady(turn.turnId);
		console.log(`  stage acked ${turn.name} (${turn.code}) - ${turn.spec.layout}`);

		ws.send(
			JSON.stringify({
				type: "huddle:speak",
				huddleId: manifest.huddleId,
				turnId: turn.turnId,
				voice: turn.voice,
				audioUrl: turn.audioPath ? `/huddle/${manifest.huddleId}/audio/${turn.audioPath.split("/").pop()}` : null,
				durationMs: turn.durationMs,
			}),
		);
		if (ONLY_TURN >= 0) return; // pinned for capture - leave it on screen
		await wait(HOLD ? turn.durationMs : 900);
		ws.send(JSON.stringify({ type: "huddle:floor_released", huddleId: manifest.huddleId, turnId: turn.turnId, reason: "yielded" }));
	}
	if (!HOLD) ws.send(JSON.stringify({ type: "huddle:closed", huddleId: manifest.huddleId, turns: [] }));
}

console.log(`stage: http://127.0.0.1:${server.port}/huddle/${manifest.huddleId}/stage`);
console.log(`replaying ${manifest.turns.length} turns from ${manifestPath}`);
