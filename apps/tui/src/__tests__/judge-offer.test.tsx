/**
 * The in-TUI safety judge offer must wait for first-run setup (#4980 second read). The App runs in
 * its own bun process (judge-offer.harness.tsx) on a fake TTY with a fresh HOME and the llama
 * runtime selected, so the offer applies. Same fake-ollama and preload arrangement as
 * first-run-skip-all.test.tsx.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

async function runHarness() {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-judge-offer-"));
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
				"--preload",
				path.join(import.meta.dir, "../../../../tests/preload-ink-interactive.ts"),
				path.join(import.meta.dir, "judge-offer.harness.tsx"),
			],
			{
				env: {
					...process.env,
					// The harness plays a person at a terminal. The one-yes resolver refuses every prompt
					// when CI, EIGHT_UNATTENDED or EIGHT_HEADLESS is set, and Validate runs with CI=1.
					CI: "",
					EIGHT_UNATTENDED: "",
					EIGHT_HEADLESS: "",
					HOME: home,
					OLLAMA_HOST: base,
					OLLAMA_BASE_URL: base,
					// bun test preloads EIGHT_SYSTEM_ONE=0, which switches the judge offer off.
					EIGHT_SYSTEM_ONE: "1",
					EIGHT_JUDGE_RUNTIME: "llama-server",
					// No judge may answer: a developer machine that runs one would end the offer as "present".
					EIGHT_DECIDE_OLLAMA_HOST: "http://127.0.0.1:9",
					"8GENT_NO_INTRO": "1",
					"8GENT_REDUCED_MOTION": "1",
				},
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		// The App writes terminal escapes to the real stdout (isTTY is faked), so the JSON can follow
		// them on one line: take it from the last {"ok" on.
		const at = out.lastIndexOf('{"ok"');
		const last = at >= 0 ? out.slice(at).split("\n")[0] : "{}";
		return JSON.parse(last);
	} finally {
		ollama.stop(true);
		fs.rmSync(home, { recursive: true, force: true });
	}
}

let result: Promise<Record<string, unknown>> | null = null;
const run = () => {
	result ??= runHarness();
	return result;
};

test("no intro, setup needed: no judge line while setup is up, and the first submit reaches setup", async () => {
	const r = await run();
	expect(r).toMatchObject({ ok: true });
	expect(r.judgeDuringSetup).toBe(0);
	expect(r.setupEnded).toBe(true);
}, 120000);

test("once setup finishes the judge line appears exactly once", async () => {
	const r = await run();
	expect(r.appeared).toBe(true);
	expect(r.judgeAfterSetup).toBe(1);
}, 120000);
