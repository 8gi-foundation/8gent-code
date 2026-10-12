import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { harnessEnv, runAppHarness } from "./app-driver.js";

test("harness env drops every *_API_KEY and points the decider at the fake", () => {
	const env = harnessEnv(
		"http://127.0.0.1:9",
		"/tmp/h",
		{},
		{
			PATH: "/bin",
			OPENROUTER_API_KEY: "x",
			ANTHROPIC_API_KEY: "y",
		},
	);
	expect(env.PATH).toBe("/bin");
	expect(Object.keys(env).some((k) => k.endsWith("_API_KEY"))).toBeFalse();
	expect(env.EIGHT_DECIDE_OLLAMA_HOST).toBe("http://127.0.0.1:9");
	const over = harnessEnv(
		"http://127.0.0.1:9",
		"/tmp/h",
		{ OLLAMA_HOST: "http://127.0.0.1:8" },
		{},
	);
	expect(over.EIGHT_DECIDE_OLLAMA_HOST).toBe("http://127.0.0.1:8");
});

test("harness env gives each harness its own home and data dir, whatever the parent pinned", () => {
	const env = harnessEnv(
		"http://127.0.0.1:9",
		"/tmp/h",
		{},
		{ HOME: "/shared", EIGHT_HOME: "/shared", EIGHT_DATA_DIR: "/shared/.8gent" },
	);
	expect(env.HOME).toBe("/tmp/h");
	expect(env.EIGHT_HOME).toBe("/tmp/h");
	expect(env.EIGHT_DATA_DIR).toBe(path.join("/tmp/h", ".8gent"));
});

test("a harness that hangs is killed at the deadline and reported", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-hang-"));
	const hang = path.join(dir, "hang.ts");
	fs.writeFileSync(hang, "console.error('stuck here'); setInterval(() => {}, 1000);\n");
	try {
		const start = Date.now();
		const events = await runAppHarness(hang, {}, 500);
		expect(Date.now() - start).toBeLessThan(10_000);
		expect(events.at(-1)).toEqual({ phase: "error", message: "harness killed after 500 ms" });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}, 20000);
