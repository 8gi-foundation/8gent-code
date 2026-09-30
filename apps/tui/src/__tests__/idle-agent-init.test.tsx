/**
 * #3087: while idle, the TUI must not keep re-running the agent-init effect.
 *
 * The effect's deps included `buildEventsForTab`, whose deps included the
 * whole object returned by useAutoKanban(), a fresh literal every render.
 * So every render re-ran the init effect, and every run called
 * TaskRouter.autoAssign, one GET /api/tags each: about 2.7 calls a second
 * against a real ollama, idle, for as long as the TUI was open.
 *
 * The real App runs in its own process against a fake ollama served here;
 * the test counts the /api/tags calls it receives during an idle window.
 * What legitimately remains is the provider-health tick (every 8 s) and a
 * probe or two, so the bound is loose on purpose; the old loop is an order
 * of magnitude above it.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MODEL = "idle-test:1b";
const WINDOW_MS = 8000;

test("idle TUI does not poll /api/tags from the agent-init effect", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-idle-init-"));
	const hits: number[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/api/tags") {
				hits.push(Date.now());
				return Response.json({ models: [{ name: MODEL, model: MODEL, size: 1 }] });
			}
			if (url.pathname === "/api/version") return Response.json({ version: "0.0.0" });
			return new Response("not found", { status: 404 });
		},
	});
	const base = `http://127.0.0.1:${server.port}`;
	try {
		const proc = Bun.spawn(
			[
				process.execPath,
				"--preload",
				path.join(import.meta.dir, "../../../../tests/preload-ink-interactive.ts"),
				path.join(import.meta.dir, "idle-agent-init.harness.tsx"),
			],
			{
				env: {
					...process.env,
					HOME: home,
					OLLAMA_BASE_URL: base,
					OLLAMA_HOST: base,
					IDLE_MODEL: MODEL,
					IDLE_WINDOW_MS: String(WINDOW_MS),
					"8GENT_NO_INTRO": "1",
					"8GENT_REDUCED_MOTION": "1",
				},
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		const events = out
			.trim()
			.split("\n")
			.filter((l) => l.startsWith("{"))
			.map((l) => JSON.parse(l));
		const err = events.find((e) => e.phase === "error");
		expect(err).toBeUndefined();
		const start = events.find((e) => e.phase === "idle-start")?.t;
		const end = events.find((e) => e.phase === "idle-end")?.t;
		expect(typeof start).toBe("number");
		expect(typeof end).toBe("number");
		const inWindow = hits.filter((t) => t >= start && t <= end).length;
		// 8 s idle: one or two provider-health ticks, nothing else. The old
		// effect loop produced ~2.7/s here (about 20+ in this window).
		expect(inWindow).toBeLessThanOrEqual(4);
	} finally {
		server.stop(true);
		fs.rmSync(home, { recursive: true, force: true });
	}
}, 90000);

/**
 * The idle loop above is also what used to pick up a provider started after
 * launch: each accidental re-run re-probed once the readiness cache expired.
 * With the loop gone, an init that ends not ready schedules its own retry.
 * Ollama answers 503 for the first seconds, then comes up; a prompt sent
 * after that must reach it instead of "[Agent not ready]".
 */
test("a provider that comes up after launch is still picked up", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-idle-recover-"));
	const upAt = Date.now() + 8000;
	const posts: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (Date.now() < upAt) return new Response("starting", { status: 503 });
			if (url.pathname === "/api/tags") {
				return Response.json({ models: [{ name: MODEL, model: MODEL, size: 1 }] });
			}
			if (req.method === "POST") posts.push(url.pathname);
			return new Response("not found", { status: 404 });
		},
	});
	const base = `http://127.0.0.1:${server.port}`;
	try {
		const proc = Bun.spawn(
			[
				process.execPath,
				"--preload",
				path.join(import.meta.dir, "../../../../tests/preload-ink-interactive.ts"),
				path.join(import.meta.dir, "idle-agent-init.harness.tsx"),
			],
			{
				env: {
					...process.env,
					HOME: home,
					OLLAMA_BASE_URL: base,
					OLLAMA_HOST: base,
					// The readiness fallback must find nothing else on this machine.
					LM_STUDIO_HOST: base,
					IDLE_MODEL: MODEL,
					HARNESS_MODE: "recovery",
					RECOVERY_WAIT_MS: "16000",
					"8GENT_NO_INTRO": "1",
					"8GENT_REDUCED_MOTION": "1",
				},
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		const events = out
			.trim()
			.split("\n")
			.filter((l) => l.startsWith("{"))
			.map((l) => JSON.parse(l));
		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		const submitted = events.find((e) => e.phase === "submitted");
		expect(submitted).toEqual({ phase: "submitted", notReady: false });
		expect(posts.length).toBeGreaterThan(0);
	} finally {
		server.stop(true);
		fs.rmSync(home, { recursive: true, force: true });
	}
}, 90000);
