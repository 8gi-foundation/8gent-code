/**
 * First run, end to end through the real App: the chat-based setup shows,
 * "/skip all" typed at its very first step ("Enter to begin") ends it, and
 * the normal input comes back. Rishi's overnight pilot does exactly this at
 * the start of every run, so a setup that cannot be skipped blocks the loop.
 *
 * The App runs in its own bun process (first-run-skip-all.harness.tsx) with
 * an empty HOME, so OnboardingManager sees a fresh first run and no module
 * state leaks into other test files.
 *
 * The setup only opens after OnboardingManager.autoDetect() returns, and that
 * runs `ollama list`, which follows OLLAMA_HOST. The child used to inherit the
 * parent's OLLAMA_HOST, so an unreachable host (a leak from another test file,
 * or a developer's remote box that is down) held the setup back ~30 s and the
 * harness timed out waiting for it (#3108). The child now points at a fake
 * ollama served here with no models, which is what CI sees and answers at once.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

async function runHarness(skipMode: "all" | "each") {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-first-run-"));
	const ollama = Bun.serve({
		port: 0,
		fetch(req) {
			if (new URL(req.url).pathname === "/api/tags") return Response.json({ models: [] });
			return new Response("not found", { status: 404 });
		},
	});
	const base = `http://127.0.0.1:${ollama.port}`;
	try {
		const proc = Bun.spawn(
			[
				process.execPath,
				// Same Ink preload as bun test (bunfig.toml): with CI set, Ink would
				// otherwise write only its final frame and the harness sees nothing.
				"--preload",
				path.join(import.meta.dir, "../../../../tests/preload-ink-interactive.ts"),
				path.join(import.meta.dir, "first-run-skip-all.harness.tsx"),
			],
			{
				env: {
					...process.env,
					HOME: home,
					OLLAMA_HOST: base,
					OLLAMA_BASE_URL: base,
					"8GENT_NO_INTRO": "1",
					"8GENT_REDUCED_MOTION": "1",
					SKIP_MODE: skipMode,
				},
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		const last =
			out
				.trim()
				.split("\n")
				.filter((l) => l.startsWith("{"))
				.at(-1) ?? "{}";
		return JSON.parse(last);
	} finally {
		ollama.stop(true);
		fs.rmSync(home, { recursive: true, force: true });
	}
}

test("/skip all at the first setup step lands on the normal input, no setup prompt left", async () => {
	expect(await runHarness("all")).toEqual({ ok: true, onboardingComplete: true, name: null });
}, 90000);

test("/skip at every question ends setup the same way: no line, no setup prompt left", async () => {
	// Complete, too: the next launch must not reopen a setup with nothing left to ask.
	expect(await runHarness("each")).toMatchObject({ ok: true, onboardingComplete: true });
}, 120000);
