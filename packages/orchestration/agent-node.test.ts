/**
 * agent-node.test.ts - proves the agent node trusts DISK, not model prose.
 * Every test injects a fake runAgent; no live model is ever contacted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentNode, type RunAgentFn } from "./agent-node.js";
import type { ExecRequest } from "./pipeline-contracts.js";

describe("createAgentNode", () => {
	let workdir: string;

	beforeEach(() => {
		workdir = mkdtempSync(join(tmpdir(), "agent-node-"));
	});

	afterEach(() => {
		if (existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });
	});

	const req = (extra?: Partial<ExecRequest>): ExecRequest => ({
		goal: "Create index.ts",
		workingDirectory: workdir,
		budgetTokens: 8000,
		...extra,
	});

	test("exposes the ExecutorNode shape", () => {
		const node = createAgentNode({ provider: "lmstudio", model: "ornith-1.0-9b", runAgent: async () => "" });
		expect(node.key).toBe("lmstudio:ornith-1.0-9b");
		expect(node.kind).toBe("agent");
		expect(typeof node.run).toBe("function");
	});

	test("ok=true and filesWritten includes a file the agent actually wrote", async () => {
		const target = join(workdir, "index.ts");
		const fake: RunAgentFn = async () => {
			writeFileSync(target, "export const x = 1;\n");
			return "Wrote index.ts as requested.";
		};
		const node = createAgentNode({ provider: "lmstudio", model: "ornith-1.0-9b", runAgent: fake });

		const result = await node.run(req());

		expect(result.ok).toBe(true);
		expect(result.filesWritten).toContain(target);
		expect(result.transcript).toContain("index.ts");
		expect(result.error).toBeUndefined();
	});

	test("ok=false when the agent claims success but writes nothing (trust disk, not prose)", async () => {
		const fake: RunAgentFn = async () => "Done! I created all the files perfectly.";
		const node = createAgentNode({ provider: "lmstudio", model: "ornith-1.0-9b", runAgent: fake });

		const result = await node.run(req());

		expect(result.ok).toBe(false);
		expect(result.filesWritten).toEqual([]);
		expect(result.error).toBeUndefined();
	});

	test("empty files do not count as written", async () => {
		const fake: RunAgentFn = async () => {
			writeFileSync(join(workdir, "empty.ts"), "");
			return "made an empty file";
		};
		const node = createAgentNode({ provider: "lmstudio", model: "ornith-1.0-9b", runAgent: fake });

		const result = await node.run(req());

		expect(result.ok).toBe(false);
		expect(result.filesWritten).toEqual([]);
	});

	test("ok=false and error is set when the agent loop throws", async () => {
		const fake: RunAgentFn = async () => {
			throw new Error("model exploded");
		};
		const node = createAgentNode({ provider: "lmstudio", model: "ornith-1.0-9b", runAgent: fake });

		const result = await node.run(req());

		expect(result.ok).toBe(false);
		expect(result.filesWritten).toEqual([]);
		expect(result.error).toBe("model exploded");
		expect(result.transcript).toBe("");
	});

	test("passes goal + context into the agent message and bounds maxTurns", async () => {
		let seen: { message: string; maxTurns: number } | undefined;
		const fake: RunAgentFn = async (args) => {
			seen = { message: args.message, maxTurns: args.maxTurns };
			writeFileSync(join(workdir, "out.ts"), "ok\n");
			return "ok";
		};
		const node = createAgentNode({ provider: "lmstudio", model: "ornith-1.0-9b", runAgent: fake });

		await node.run(req({ budgetTokens: 100_000, context: "uses Next.js app router" }));

		expect(seen?.message).toContain("Create index.ts");
		expect(seen?.message).toContain("Project structure / context:");
		expect(seen?.message).toContain("uses Next.js app router");
		// 100k/2000 = 50, clamped to the 12 ceiling.
		expect(seen?.maxTurns).toBe(12);
	});
});
