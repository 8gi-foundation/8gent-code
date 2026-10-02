/**
 * Every footer button does what its key does, in the real App (James,
 * 2026-10-02: "only plan from the buttons in the footer actually works").
 *
 * The clicks always sent the right key (#3239). What failed was the footer
 * teaching keys that change nothing on screen: ^O expand, ^K kanban and
 * ^B processes set state no view has drawn since #2350, ^D does nothing
 * with no track loaded, and ^A and ^S changed nothing visible. The footer
 * now shows only keys that visibly act, ^A and ^S confirm in the hint slot,
 * and ^D shows only with a track loaded.
 *
 * The App runs in its own process (footer-clicks.harness.tsx) against a fake
 * ollama served here, and clicks each item where the screen draws it.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MODEL = "footer-test:1b";

test("every footer item, clicked where it is drawn, does what its key does", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-footer-clicks-"));
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
		const proc = Bun.spawn(
			[
				process.execPath,
				"--preload",
				path.join(import.meta.dir, "../../../../tests/preload-ink-interactive.ts"),
				path.join(import.meta.dir, "footer-clicks.harness.tsx"),
			],
			{
				env: {
					...process.env,
					HOME: home,
					OLLAMA_BASE_URL: base,
					OLLAMA_HOST: base,
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
			// With sound on, the App rings the terminal bell on this stdout.
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping BEL
			.map((l) => l.replace(/^[\x00-\x1f]+/, ""))
			.filter((l) => l.startsWith("{"))
			.map((l) => JSON.parse(l));
		expect(events.find((e) => e.phase === "error")).toBeUndefined();

		// The footer teaches only keys that act; ^D waits for a loaded track.
		const row: string = events.find((e) => e.phase === "footer")?.row ?? "";
		for (const cap of [
			"[^P] palette",
			"[^X] plan",
			"[⇧Tab] perm",
			"[^A] anim",
			"[^S] sound",
			"[^C] quit",
		]) {
			expect(row).toContain(cap);
		}
		for (const dead of ["expand", "kanban", "processes", "[^D] DJ"])
			expect(row).not.toContain(dead);

		const clicks = events
			.filter((e) => e.phase === "click")
			.map((e) => ({ item: e.item, ok: e.ok }));
		expect(clicks).toEqual(
			["mode", "palette opens", "palette closes", "plan", "anim", "sound", "perm", "quit"].map(
				(item) => ({ item, ok: true }),
			),
		);
	} finally {
		server.stop(true);
		fs.rmSync(home, { recursive: true, force: true });
	}
}, 90000);
