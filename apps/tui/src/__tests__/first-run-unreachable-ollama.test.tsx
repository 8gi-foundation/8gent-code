/**
 * #3115, end to end through the real App: with OLLAMA_HOST pointed at a host
 * that accepts TCP and never answers, the first-run setup still shows at once
 * (the welcome is on screen while the Ollama check is still pending), and the
 * welcome then says plainly that the host could not be reached.
 *
 * Before the fix the setup waited on `ollama list`, unbounded and run twice:
 * the welcome never showed inside the harness's 20 s wait against this host,
 * and 60 s late against OLLAMA_HOST=10.255.255.1:11434. When the check failed
 * the welcome said nothing about Ollama at all.
 *
 * The assertions are on what the screen says, in order, not on wall-clock
 * numbers, so load cannot flake them. Measured timings are in the PR.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("an unreachable OLLAMA_HOST does not hold the setup back, and the welcome names it", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-first-run-down-ollama-"));
	// Accepts the connection, never writes a byte.
	const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
	const host = `127.0.0.1:${silent.port}`;
	try {
		const proc = Bun.spawn(
			[
				process.execPath,
				"--preload",
				path.join(import.meta.dir, "../../../../tests/preload-ink-interactive.ts"),
				path.join(import.meta.dir, "first-run-unreachable-ollama.harness.tsx"),
			],
			{
				env: {
					...process.env,
					HOME: home,
					OLLAMA_HOST: host,
					OLLAMA_BASE_URL: `http://${host}`,
					"8GENT_NO_INTRO": "1",
					"8GENT_REDUCED_MOTION": "1",
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
		const r = JSON.parse(last);
		expect(r).toMatchObject({ ok: true });
		// Shown while the check was still out: the setup did not wait for it.
		expect(r.welcomeText).toContain("Checking this machine for local models");
		// Then the check landed in the same welcome, naming the host.
		expect(r.settledText).toContain(`Ollama at ${host} could not be reached`);
		expect(r.settledMs).toBeGreaterThanOrEqual(r.welcomeMs);
	} finally {
		silent.stop(true);
		fs.rmSync(home, { recursive: true, force: true });
	}
}, 90000);
