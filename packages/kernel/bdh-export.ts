/**
 * BDH daily-usage corpus export (DORMANT scaffold).
 *
 * James wants nightly BDH (Baby Dragon Hatchling, arXiv:2509.26507) training on
 * HIS OWN usage data. The actual overnight retrain does NOT run here - it runs
 * in the SEPARATE `8gent-bdh` repo as a batch-offline MPS job on his Mac (see
 * the BDHTraining skill). This file is ONLY the collection -> corpus export
 * seam: it reads the pairs the kernel's PersonalCollector already gathers and
 * writes a dated, line-delimited corpus file the bdh job can pick up.
 *
 * OFF by default: nothing here runs unless `exportDailyCorpus` is explicitly
 * called with `enabled: true`. No scheduler, no daemon hook, no network. It is
 * a pure read-collected-pairs -> write-corpus function, and a no-op when off.
 *
 * Where the actual retrain runs: `8gent-bdh` repo, batch-offline MPS on the M2
 * Max, scheduled outside this kernel (e.g. a nightly launchd job that reads
 * `~/.8gent/bdh-corpus/<date>.jsonl`). This kernel never trains BDH.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TrainingPair } from "./personal-collector";

export const DEFAULT_BDH_CORPUS_DIR = join(homedir(), ".8gent", "bdh-corpus");

/** One corpus line: the minimal supervised shape the BDH job consumes. */
export interface BdhCorpusRow {
	prompt: string;
	completion: string;
	score: number;
	model: string;
	collectedAt: number;
}

export interface BdhExportOptions {
	/** Master flag. DEFAULT FALSE. When false, this is a no-op. */
	enabled: boolean;
	/** Source pairs file (the PersonalCollector output). */
	pairsPath: string;
	/** Directory for dated corpus files. */
	corpusDir?: string;
	/** Override "today" (tests). Defaults to current UTC date. */
	dateStr?: string;
	/** Min score to include in the corpus. Defaults to 0.7 (matches collector). */
	minScore?: number;
}

export interface BdhExportResult {
	/** True if the export ran (flag on). */
	ran: boolean;
	/** Rows written this call. */
	written: number;
	/** Corpus file path, or null when disabled. */
	corpusPath: string | null;
}

function utcDate(): string {
	return new Date().toISOString().slice(0, 10);
}

/**
 * Export today's collected pairs into a dated BDH corpus file. Dormant unless
 * `enabled` is true. Appends (idempotent-ish: re-running appends again, so the
 * overnight job should consume-then-archive). Returns counts.
 */
export function exportDailyCorpus(opts: BdhExportOptions): BdhExportResult {
	if (!opts.enabled) {
		return { ran: false, written: 0, corpusPath: null };
	}

	const corpusDir = opts.corpusDir ?? DEFAULT_BDH_CORPUS_DIR;
	const date = opts.dateStr ?? utcDate();
	const minScore = opts.minScore ?? 0.7;
	const corpusPath = join(corpusDir, `${date}.jsonl`);

	const pairs = readPairs(opts.pairsPath);
	// Only today's pairs, above the quality bar. Pairs carry a ms timestamp.
	const dayStart = Date.parse(`${date}T00:00:00.000Z`);
	const dayEnd = dayStart + 24 * 60 * 60 * 1000;

	const rows: BdhCorpusRow[] = pairs
		.filter((p) => p.score >= minScore)
		.filter((p) => p.collectedAt >= dayStart && p.collectedAt < dayEnd)
		.map((p) => ({
			prompt: p.prompt,
			completion: p.response,
			score: p.score,
			model: p.model,
			collectedAt: p.collectedAt,
		}));

	if (rows.length === 0) {
		return { ran: true, written: 0, corpusPath };
	}

	const dir = dirname(corpusPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	appendFileSync(corpusPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

	return { ran: true, written: rows.length, corpusPath };
}

function readPairs(pairsPath: string): TrainingPair[] {
	if (!existsSync(pairsPath)) return [];
	const out: TrainingPair[] = [];
	for (const line of readFileSync(pairsPath, "utf-8").split("\n")) {
		const s = line.trim();
		if (!s) continue;
		try {
			out.push(JSON.parse(s) as TrainingPair);
		} catch {
			// Skip malformed lines rather than abort the whole export.
		}
	}
	return out;
}
