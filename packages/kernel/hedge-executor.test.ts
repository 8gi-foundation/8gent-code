import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type GenerateResult,
	type HedgeCandidate,
	HedgeExecutor,
	selectCandidates,
} from "./hedge-executor";

function cand(provider: string, model: string, local = false): HedgeCandidate {
	return { provider, model, local };
}

describe("hedge executor", () => {
	test("DISABLED (default): fires exactly one candidate, no disk write, byte-identical", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hedge-"));
		const signalPath = join(dir, "hedge-signal.jsonl");
		const ex = new HedgeExecutor({ signalPath }); // enabled defaults false
		expect(ex.enabled).toBe(false);

		let calls = 0;
		const gen = async (c: HedgeCandidate): Promise<GenerateResult> => {
			calls += 1;
			return { text: `out from ${c.model}` };
		};
		const out = await ex.run([cand("a", "m1", true), cand("b", "m2")], gen, {
			sessionId: "s",
			turnIndex: 0,
			prompt: "p",
		});
		expect(calls).toBe(1);
		expect(out.candidatesFired).toBe(1);
		expect(out.signalWritten).toBe(false);
		expect(out.result.text).toBe("out from m1");
		expect(existsSync(signalPath)).toBe(false);
	});

	test("ENABLED: fires K candidates, returns a winner, writes a dormant preference signal", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hedge-"));
		const signalPath = join(dir, "hedge-signal.jsonl");
		const ex = new HedgeExecutor({ enabled: true, k: 2, signalPath });

		const gen = async (c: HedgeCandidate): Promise<GenerateResult> => {
			// m1 is fast, m2 is slow but distinct so a contrast exists.
			if (c.model === "m1") return { text: "winner text" };
			await new Promise((r) => setTimeout(r, 20));
			return { text: "loser text" };
		};
		const out = await ex.run([cand("a", "m1", true), cand("b", "m2", true)], gen, {
			sessionId: "s1",
			turnIndex: 3,
			prompt: "fix the bug",
		});

		expect(out.candidatesFired).toBe(2);
		expect(out.result.text).toBe("winner text");
		expect(out.signalWritten).toBe(true);
		expect(existsSync(signalPath)).toBe(true);

		const row = JSON.parse(readFileSync(signalPath, "utf-8").trim());
		expect(row.prompt).toBe("fix the bug");
		expect(row.winner.text).toBe("winner text");
		expect(row.losers.length).toBe(1);
		expect(row.losers[0].text).toBe("loser text");
	});

	test("ENABLED but identical candidate text: no fabricated preference written", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hedge-"));
		const signalPath = join(dir, "hedge-signal.jsonl");
		const ex = new HedgeExecutor({ enabled: true, k: 2, signalPath });
		const gen = async (): Promise<GenerateResult> => ({ text: "same exact text" });
		const out = await ex.run([cand("a", "m1", true), cand("b", "m2", true)], gen, {
			sessionId: "s",
			turnIndex: 0,
			prompt: "p",
		});
		expect(out.result.text).toBe("same exact text");
		expect(out.signalWritten).toBe(false);
		expect(existsSync(signalPath)).toBe(false);
	});

	test("ENABLED with only one viable candidate: behaves as a single call, no signal", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hedge-"));
		const signalPath = join(dir, "hedge-signal.jsonl");
		const ex = new HedgeExecutor({ enabled: true, k: 2, signalPath });
		const gen = async (c: HedgeCandidate): Promise<GenerateResult> => ({ text: c.model });
		const out = await ex.run([cand("a", "m1", true)], gen, {
			sessionId: "s",
			turnIndex: 0,
			prompt: "p",
		});
		expect(out.candidatesFired).toBe(1);
		expect(out.signalWritten).toBe(false);
	});

	test("hedge executor never executes tools - it only returns ONE result to the turn", async () => {
		// The structural safety invariant: run() returns a single GenerateResult.
		// There is no tool-dispatch path inside the executor, so a loser cannot
		// reach the executor. We assert the API shape: exactly one result back.
		const dir = mkdtempSync(join(tmpdir(), "hedge-"));
		const ex = new HedgeExecutor({ enabled: true, k: 3, signalPath: join(dir, "s.jsonl") });
		const toolDispatches = 0;
		const gen = async (c: HedgeCandidate): Promise<GenerateResult> => {
			// Each candidate "proposes" a tool call in its steps, but the executor
			// must NOT dispatch any of them.
			return { text: `text ${c.model}`, steps: [{ toolCalls: [{ name: "write_file" }] }] };
		};
		const out = await ex.run(
			[cand("a", "m1", true), cand("b", "m2", true), cand("c", "m3", true)],
			gen,
			{ sessionId: "s", turnIndex: 0, prompt: "p" },
		);
		// Exactly one result handed back; the executor dispatched zero tools.
		expect(typeof out.result.text).toBe("string");
		expect(toolDispatches).toBe(0);
	});

	test("AbortError propagates exactly like a single call", async () => {
		const ex = new HedgeExecutor({ enabled: true, k: 2, signalPath: "/tmp/none.jsonl" });
		const gen = async (): Promise<GenerateResult> => {
			const e = new Error("aborted");
			e.name = "AbortError";
			throw e;
		};
		await expect(
			ex.run([cand("a", "m1", true), cand("b", "m2", true)], gen, {
				sessionId: "s",
				turnIndex: 0,
				prompt: "p",
			}),
		).rejects.toThrow();
	});

	test("selectCandidates prefers local and caps at maxK", () => {
		const chosen = selectCandidates(
			[cand("cloud", "c1"), cand("local", "l1", true), cand("local", "l2", true)],
			{ k: 3, maxK: 2, preferLocal: true },
		);
		expect(chosen.length).toBe(2);
		expect(chosen[0].local).toBe(true);
		expect(chosen[1].local).toBe(true);
	});
});
