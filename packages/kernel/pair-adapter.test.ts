import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptPairsFile, hedgeRowsToGrpoPairs, toGrpoPairs } from "./pair-adapter";
import type { TrainingPair } from "./personal-collector";

function tp(p: Partial<TrainingPair>): TrainingPair {
	return {
		userId: "u",
		sessionId: "s",
		prompt: "p",
		response: "r",
		score: 0.8,
		model: "m",
		toolCallsSucceeded: true,
		userCorrected: false,
		collectedAt: 1_700_000_000_000,
		...p,
	};
}

describe("pair adapter", () => {
	test("forms a chosen/rejected pair from two scored responses to one prompt", () => {
		const out = toGrpoPairs([
			tp({ prompt: "fix the bug", response: "good fix", score: 0.9 }),
			tp({ prompt: "fix the bug", response: "bad fix", score: 0.4 }),
		]);
		expect(out.length).toBe(1);
		expect(out[0].chosen).toBe("good fix");
		expect(out[0].rejected).toBe("bad fix");
		expect(out[0].chosen_score).toBeGreaterThan(out[0].rejected_score);
	});

	test("skips a prompt with only one response (no fabricated preference)", () => {
		expect(toGrpoPairs([tp({ prompt: "solo" })]).length).toBe(0);
	});

	test("skips when the score gap is below the threshold (a tie)", () => {
		const out = toGrpoPairs([
			tp({ prompt: "x", response: "a", score: 0.81 }),
			tp({ prompt: "x", response: "b", score: 0.8 }),
		]);
		expect(out.length).toBe(0);
	});

	test("adaptPairsFile reads pairs.jsonl and writes grpo.jsonl in the trainer shape", () => {
		const dir = mkdtempSync(join(tmpdir(), "grpo-"));
		const pairsPath = join(dir, "pairs.jsonl");
		const outPath = join(dir, "grpo.jsonl");
		writeFileSync(
			pairsPath,
			[
				JSON.stringify(tp({ prompt: "q", response: "win", score: 0.95 })),
				JSON.stringify(tp({ prompt: "q", response: "lose", score: 0.3 })),
				"   ", // blank line tolerated
				"{not json", // malformed line skipped
			].join("\n"),
		);
		const n = adaptPairsFile(pairsPath, outPath);
		expect(n).toBe(1);
		const written = JSON.parse(readFileSync(outPath, "utf-8").trim());
		expect(written.prompt).toBe("q");
		expect(written.chosen).toBe("win");
		expect(written.rejected).toBe("lose");
		expect(typeof written.chosen_score).toBe("number");
		expect(typeof written.collected_at).toBe("string");
	});

	test("missing input file yields zero, writes nothing fatal", () => {
		const dir = mkdtempSync(join(tmpdir(), "grpo-"));
		expect(adaptPairsFile(join(dir, "nope.jsonl"), join(dir, "out.jsonl"))).toBe(0);
	});

	test("hedgeRowsToGrpoPairs forms a chosen/rejected pair from a winner+loser row", () => {
		const out = hedgeRowsToGrpoPairs([
			{
				prompt: "fix it",
				winner: { text: "good", provider: "8gent", model: "eight" },
				losers: [{ text: "bad", provider: "ollama", model: "qwen" }],
			},
		]);
		expect(out.length).toBe(1);
		expect(out[0].chosen).toBe("good");
		expect(out[0].rejected).toBe("bad");
	});

	test("hedge row with identical winner/loser text yields no fabricated preference", () => {
		const out = hedgeRowsToGrpoPairs([
			{ prompt: "p", winner: { text: "same" }, losers: [{ text: "same" }] },
		]);
		expect(out.length).toBe(0);
	});

	test("adaptPairsFile folds in hedge-signal contrast pairs when a signal file is present", () => {
		const dir = mkdtempSync(join(tmpdir(), "grpo-"));
		const pairsPath = join(dir, "pairs.jsonl");
		const hedgePath = join(dir, "hedge-signal.jsonl");
		const outPath = join(dir, "grpo.jsonl");
		// One single-response pair (no contrast on its own).
		writeFileSync(pairsPath, JSON.stringify(tp({ prompt: "solo" })) + "\n");
		// One hedge row that DOES carry a contrast.
		writeFileSync(
			hedgePath,
			JSON.stringify({
				prompt: "hedged",
				winner: { text: "winner" },
				losers: [{ text: "loser" }],
			}) + "\n",
		);
		const n = adaptPairsFile(pairsPath, outPath, { hedgeSignalPath: hedgePath });
		// solo pair contributes nothing; the hedge row contributes one.
		expect(n).toBe(1);
		const written = JSON.parse(readFileSync(outPath, "utf-8").trim());
		expect(written.prompt).toBe("hedged");
		expect(written.chosen).toBe("winner");
	});
});
