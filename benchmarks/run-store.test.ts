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
