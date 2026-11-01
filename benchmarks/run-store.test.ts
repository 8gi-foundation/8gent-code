import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadDone, openRun, saveResult } from "./run-store";

const made: string[] = [];
function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-run-"));
	made.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const stored = {
	benchmarkId: "BF001",
	code: null,
	grade: {
		score: 88,
		method: "keyword",
		keyword: { score: 88, matchedKeywords: ["a"], missedKeywords: [] },
	},
	tokensUsed: 10,
	duration: 5,
};

describe("run-store", () => {
	test("saveResult writes one file per item and loadDone reads it back", () => {
		const dir = tmpDir();
		saveResult(dir, stored);
		expect(fs.readdirSync(dir)).toEqual(["BF001.json"]);
		const done = loadDone(dir);
		expect([...done.keys()]).toEqual(["BF001"]);
		expect(done.get("BF001")).toEqual(stored);
	});

	test("openRun records model, provider and seed, and refuses a mismatched resume", () => {
		const dir = tmpDir();
		openRun(dir, { model: "m1", provider: "ollama", seed: 300 });
		const header = JSON.parse(fs.readFileSync(path.join(dir, "_run.json"), "utf-8"));
		expect(header).toMatchObject({ model: "m1", provider: "ollama", seed: 300 });
		expect(() => openRun(dir, { model: "m1", provider: "ollama", seed: 300 })).not.toThrow();
		expect(() => openRun(dir, { model: "m2", provider: "ollama", seed: 300 })).toThrow(/model/);
		expect(() => openRun(dir, { model: "m1", provider: "ollama" })).toThrow(/seed/);
		// The header is never mistaken for a finished item.
		expect(loadDone(dir).size).toBe(0);
	});
});

describe("runner --resume", () => {
	test("skips items already finished, without calling the model", () => {
		const dir = tmpDir();
		openRun(dir, { model: "llama3.2:3b", provider: "ollama" });
		saveResult(dir, stored);

		// Unreachable model host: on a run that did not skip BF001 this exits non-zero.
		const proc = Bun.spawnSync(
			[
				process.execPath,
				path.join(import.meta.dir, "runner.ts"),
				"--bench",
				"BF001",
				"--model",
				"llama3.2:3b",
				"--resume",
				dir,
				"--output",
				"json",
			],
			{ env: { ...process.env, OLLAMA_HOST: "http://127.0.0.1:9" } },
		);
		const out = proc.stdout.toString();
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(out.slice(out.indexOf("\n{") + 1));
		expect(report.overallScore).toBe(88);
		expect(report.results.map((r: { benchmarkId: string }) => r.benchmarkId)).toEqual(["BF001"]);
		expect(report.resumed).toEqual({ dir, skipped: ["BF001"] });
	});
});

describe("runner --resume against a local model stub", () => {
	// A stand-in for Ollama on an ephemeral 127.0.0.1 port: no network, no model.
	const chats: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "stub:1" }] });
			if (url.pathname === "/api/chat") {
				const body = (await req.json()) as { messages: { content: string }[] };
				chats.push(body.messages[1].content);
				return Response.json({
					message: { content: "```ts\nexport const answer = 1;\n```" },
					prompt_eval_count: 1,
					eval_count: 1,
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	afterAll(() => server.stop(true));

	async function run(dir: string, output: string, extra: string[] = []) {
		const proc = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "runner.ts"),
				"--category",
				"bug-fixing",
				"--model",
				"stub:1",
				"--resume",
				dir,
				"--output",
				output,
				...extra,
			],
			{
				env: { ...process.env, OLLAMA_HOST: `http://127.0.0.1:${server.port}` },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		return { out, err, exitCode };
	}

	test("writes one file per finished item, and a rerun runs only the missing one", async () => {
		const dir = tmpDir();
		const first = await run(dir, "json");
		expect(first.exitCode).toBe(0);
		const ids = ["BF001", "BF002", "BF003"];
		expect(chats.length).toBe(ids.length);
		expect(fs.readdirSync(dir).sort()).toEqual([...ids.map((id) => `${id}.json`), "_run.json"]);

		// Simulate a run interrupted before BF002 finished.
		fs.rmSync(path.join(dir, "BF002.json"));
		chats.length = 0;
		const second = await run(dir, "markdown", ["--seed", "7"]);
		// A seed change is refused rather than mixing configs, and nothing is called.
		expect(second.exitCode).not.toBe(0);
		expect(chats.length).toBe(0);

		const third = await run(dir, "markdown");
		expect(third.exitCode).toBe(0);
		expect(chats.length).toBe(1);
		expect(fs.existsSync(path.join(dir, "BF002.json"))).toBe(true);
		// The shareable report says the score is partly from an earlier session.
		expect(third.out).toContain(`**Resumed:** 2 of 3 items loaded from ${dir}`);
		expect(third.out).toContain("**Seed:** unset");
	}, 60_000);
});
