import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "./adaptive-pipeline.js";
import type { BuildPlan, ExecutorNode, PipelineEvent } from "./pipeline-contracts.js";
import { ProjectPipeline, rankExecutors } from "./project-pipeline.js";

const tmpDirs: string[] = [];
function workdir(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "proj-pipe-"));
	tmpDirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const PLAN: BuildPlan = {
	projectType: "static-site",
	summary: "two pages",
	units: [{ id: "about.html", path: "about.html", kind: "page", spec: "An about page.", dependsOn: [] }],
};

// A thinker that always returns our canned plan (no live model).
const fakeThinker = {
	key: "fake:thinker",
	call: async () => JSON.stringify(PLAN),
} as unknown as Model;

// Executor that never writes anything (simulates a model that fails the unit).
const deadExecutor: ExecutorNode = {
	key: "lmstudio:ornith-1.0-9b",
	kind: "agent",
	run: async () => ({ ok: false, filesWritten: [], transcript: "(wrote nothing)" }),
};

// Executor that actually writes the unit file (the stronger one we escalate to).
const goodExecutor: ExecutorNode = {
	key: "lmstudio:gemma",
	kind: "agent",
	run: async (req) => {
		const abs = path.join(req.workingDirectory, PLAN.units[0].path);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, "<!doctype html><h1>About</h1>");
		return { ok: true, filesWritten: [PLAN.units[0].path], transcript: "wrote about.html" };
	},
};

describe("rankExecutors", () => {
	it("ranks ornith above a larger non-agentic model (agency beats size)", () => {
		const models = [
			{ provider: "lmstudio", model: "gemma-4-12b", score: 12 },
			{ provider: "lmstudio", model: "ornith-1.0-9b", score: 9 },
			{ provider: "ollama", model: "qwen3.6:27b", score: 27 },
		] as Model[];
		const ranked = rankExecutors(models);
		expect(ranked[0].model).toBe("ornith-1.0-9b");
		expect(ranked.some((m) => m.provider === "ollama")).toBe(false); // completions excluded
	});
});

describe("ProjectPipeline", () => {
	it("scaffolds, decomposes, executes, and escalates to a stronger executor on failure", async () => {
		const dir = workdir();
		const opts = {
			task: "Build a small site",
			workingDirectory: dir,
			projectType: "static-site",
			maxAttempts: 4,
		};
		const pipe = new ProjectPipeline("Build a small site", fakeThinker, [deadExecutor, goodExecutor], opts);

		const events: PipelineEvent[] = [];
		pipe.subscribe((e) => events.push(e));

		const result = await pipe.run();

		// scaffold was written to disk
		expect(fs.existsSync(path.join(dir, "index.html"))).toBe(true);
		// planned one unit, and it landed on disk via the good executor
		expect(result.unitsPlanned).toBe(1);
		expect(result.ok).toBe(true);
		expect(fs.existsSync(path.join(dir, "about.html"))).toBe(true);
		expect(result.units[0].model).toBe("lmstudio:gemma"); // escalated off the dead executor
		// the escalation actually fired as a structured event
		expect(events.some((e) => e.kind === "escalate")).toBe(true);
		expect(events.some((e) => e.kind === "unit" && e.status === "done")).toBe(true);
		expect(events.some((e) => e.kind === "done")).toBe(true);
	});

	it("reports a unit as failed when no executor can produce it", async () => {
		const dir = workdir();
		const pipe = new ProjectPipeline("x", fakeThinker, [deadExecutor], {
			task: "x",
			workingDirectory: dir,
			projectType: "static-site",
			maxAttempts: 2,
		});
		const result = await pipe.run();
		expect(result.ok).toBe(false);
		expect(result.units[0].ok).toBe(false);
	});
});
