import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportDailyCorpus } from "./bdh-export";
import type { TrainingPair } from "./personal-collector";

function tp(p: Partial<TrainingPair>): TrainingPair {
	return {
		userId: "u",
		sessionId: "s",
		prompt: "p",
		response: "this is a sufficiently long response for the corpus",
		score: 0.8,
		model: "eight-1.0",
		toolCallsSucceeded: true,
		userCorrected: false,
		collectedAt: Date.parse("2026-06-21T12:00:00.000Z"),
		...p,
	};
}

describe("bdh daily corpus export (dormant scaffold)", () => {
	test("DISABLED (default flag off): no-op, writes nothing", () => {
		const dir = mkdtempSync(join(tmpdir(), "bdh-"));
		const pairsPath = join(dir, "pairs.jsonl");
		writeFileSync(pairsPath, JSON.stringify(tp({})) + "\n");
		const out = exportDailyCorpus({ enabled: false, pairsPath, corpusDir: dir });
		expect(out.ran).toBe(false);
		expect(out.written).toBe(0);
		expect(out.corpusPath).toBe(null);
	});

	test("ENABLED: writes today's above-threshold pairs to a dated corpus file", () => {
		const dir = mkdtempSync(join(tmpdir(), "bdh-"));
		const pairsPath = join(dir, "pairs.jsonl");
		const corpusDir = join(dir, "corpus");
		writeFileSync(
			pairsPath,
			[
				JSON.stringify(tp({ prompt: "a", score: 0.9 })),
				JSON.stringify(tp({ prompt: "b", score: 0.2 })), // below minScore, filtered
			].join("\n") + "\n",
		);
		const out = exportDailyCorpus({
			enabled: true,
			pairsPath,
			corpusDir,
			dateStr: "2026-06-21",
		});
		expect(out.ran).toBe(true);
		expect(out.written).toBe(1);
		expect(out.corpusPath).toBe(join(corpusDir, "2026-06-21.jsonl"));
		expect(existsSync(out.corpusPath!)).toBe(true);
		const row = JSON.parse(readFileSync(out.corpusPath!, "utf-8").trim());
		expect(row.prompt).toBe("a");
		expect(row.completion).toContain("sufficiently long");
	});

	test("ENABLED: pairs from a different day are excluded", () => {
		const dir = mkdtempSync(join(tmpdir(), "bdh-"));
		const pairsPath = join(dir, "pairs.jsonl");
		writeFileSync(
			pairsPath,
			JSON.stringify(tp({ collectedAt: Date.parse("2026-06-20T12:00:00.000Z") })) + "\n",
		);
		const out = exportDailyCorpus({
			enabled: true,
			pairsPath,
			corpusDir: join(dir, "corpus"),
			dateStr: "2026-06-21",
		});
		expect(out.ran).toBe(true);
		expect(out.written).toBe(0);
	});

	test("ENABLED with missing pairs file: ran but zero written, no crash", () => {
		const dir = mkdtempSync(join(tmpdir(), "bdh-"));
		const out = exportDailyCorpus({
			enabled: true,
			pairsPath: join(dir, "nope.jsonl"),
			corpusDir: join(dir, "corpus"),
		});
		expect(out.ran).toBe(true);
		expect(out.written).toBe(0);
	});
});
