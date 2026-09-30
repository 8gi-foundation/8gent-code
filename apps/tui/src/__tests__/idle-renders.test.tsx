/**
 * #3099: an idle TUI redraws the screen only when something on it changes.
 *
 * Every React commit makes Ink lay out and rewrite the whole screen (about
 * 20-30 ms of CPU on a 160x48 terminal). Measured on main at c590a482, an
 * idle TUI committed about 8 times a second, holding ~22% CPU:
 *   - the prompt chevron's 300 ms colour cycle, plus an 800 ms pulse toggle
 *     that changed nothing visible (4.6/s together),
 *   - a 1 s App tick for the session clock, and another in useLilEightState,
 *   - the DJ deck status poll (1 s), the process-panel poll (1.5 s) and the
 *     provider-health probe (8 s), each setting a fresh object with the
 *     same data.
 *
 * The real App runs in its own process (the idle-agent-init harness) with
 * motion ON, the default, and counts Ink frames over an idle window that
 * sits past the session clock's first minute, where nothing on screen
 * changes. On main at c590a482 this window drew 51 frames.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MODEL = "idle-test:1b";
const WINDOW_MS = 8000;

test("idle TUI with motion on does not redraw the screen", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-idle-renders-"));
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/api/tags") {
				return Response.json({ models: [{ name: MODEL, model: MODEL, size: 1 }] });
			}
			if (url.pathname === "/api/version") return Response.json({ version: "0.0.0" });
			return new Response("not found", { status: 404 });
		},
	});
	const base = `http://127.0.0.1:${server.port}`;
	try {
		const env = {
			...process.env,
			HOME: home,
			OLLAMA_BASE_URL: base,
			OLLAMA_HOST: base,
			LM_STUDIO_HOST: base,
			IDLE_MODEL: MODEL,
			IDLE_WINDOW_MS: String(WINDOW_MS),
			IDLE_CLOCK_JUMP_MS: "61000",
			"8GENT_NO_INTRO": "1",
			// Motion stays on: the default is what has to be quiet.
			"8GENT_REDUCED_MOTION": "0",
		};
		const proc = Bun.spawn(
			[
				process.execPath,
				"--preload",
				path.join(import.meta.dir, "../../../../tests/preload-ink-interactive.ts"),
				path.join(import.meta.dir, "idle-agent-init.harness.tsx"),
			],
			{ env, stdout: "pipe", stderr: "ignore" },
		);
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		const events = out
			.trim()
			.split("\n")
			.filter((l) => l.startsWith("{"))
			.map((l) => JSON.parse(l));
		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		const end = events.find((e) => e.phase === "idle-end");
		expect(typeof end?.frames).toBe("number");
		// 8 s idle past the first minute: the clock text does not change and
		// nothing animates. Allow two frames of slack for a poll that finds
		// genuinely new data (git status, provider count); main drew 51
		// here.
		expect(end.frames).toBeLessThanOrEqual(2);
	} finally {
		server.stop(true);
		fs.rmSync(home, { recursive: true, force: true });
	}
}, 90000);
