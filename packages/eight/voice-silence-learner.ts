/**
 * 8gent Code - Voice silence learner
 *
 * Observes how long the user actually pauses between voice utterances and
 * recommends a silence threshold tuned to their personal speaking rhythm.
 *
 * Algorithm:
 *  - Persist the last 50 samples to `~/.8gent/voice-silence-history.jsonl`
 *  - With <5 samples, fall back to 2000ms (the default in v0.11.x)
 *  - With >=5 samples, return mean + 1*stddev, clamped to [800, 5000]ms
 *
 * The actual voice loop lives in a sibling subagent's PR. This module only
 * exposes the learner so future PRs can call `observePause(ms)` from the
 * voice hook.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_THRESHOLD_MS = 2000;
const MIN_SAMPLES = 5;
const MAX_SAMPLES = 50;
const CLAMP_MIN_MS = 800;
const CLAMP_MAX_MS = 5000;

interface PauseSample {
	ts: number;
	ms: number;
}

export class VoiceSilenceLearner {
	private historyPath: string;
	private samples: number[];

	constructor(historyPath?: string) {
		this.historyPath =
			historyPath ?? path.join(os.homedir(), ".8gent", "voice-silence-history.jsonl");
		this.samples = this.loadHistory();
	}

	/**
	 * Record a pause the user made between voice utterances.
	 * Persists immediately so learning survives crashes/restarts.
	 */
	observePause(ms: number): void {
		if (!Number.isFinite(ms) || ms <= 0) return;
		this.samples.push(ms);
		// Keep only the last MAX_SAMPLES in memory.
		if (this.samples.length > MAX_SAMPLES) {
			this.samples = this.samples.slice(-MAX_SAMPLES);
		}
		this.appendSample({ ts: Date.now(), ms });
	}

	/**
	 * Return the recommended silence threshold given the current sample set.
	 * Pure read - no I/O.
	 */
	getRecommendedThreshold(): number {
		if (this.samples.length < MIN_SAMPLES) return DEFAULT_THRESHOLD_MS;

		const mean = average(this.samples);
		const stddev = standardDeviation(this.samples, mean);
		const recommended = mean + stddev;

		return clamp(Math.round(recommended), CLAMP_MIN_MS, CLAMP_MAX_MS);
	}

	// ─── Internals ──────────────────────────────────────────────────────────
	private loadHistory(): number[] {
		try {
			if (!fs.existsSync(this.historyPath)) return [];
			const raw = fs.readFileSync(this.historyPath, "utf8");
			const lines = raw.split("\n");
			const out: number[] = [];
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const parsed = JSON.parse(trimmed) as Partial<PauseSample>;
					if (typeof parsed.ms === "number" && Number.isFinite(parsed.ms) && parsed.ms > 0) {
						out.push(parsed.ms);
					}
				} catch {
					// Corrupt line - skip, don't fail.
				}
			}
			// Keep only the last MAX_SAMPLES.
			return out.length > MAX_SAMPLES ? out.slice(-MAX_SAMPLES) : out;
		} catch {
			// Any read failure - start fresh in memory.
			return [];
		}
	}

	private appendSample(sample: PauseSample): void {
		try {
			const dir = path.dirname(this.historyPath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.appendFileSync(this.historyPath, `${JSON.stringify(sample)}\n`, "utf8");
		} catch {
			// Persistence is best-effort. In-memory state still works for the
			// current session.
		}
	}
}

// ─── Math helpers ───────────────────────────────────────────────────────────
function average(xs: number[]): number {
	let sum = 0;
	for (const x of xs) sum += x;
	return sum / xs.length;
}

function standardDeviation(xs: number[], mean: number): number {
	let acc = 0;
	for (const x of xs) {
		const diff = x - mean;
		acc += diff * diff;
	}
	return Math.sqrt(acc / xs.length);
}

function clamp(n: number, lo: number, hi: number): number {
	if (n < lo) return lo;
	if (n > hi) return hi;
	return n;
}
