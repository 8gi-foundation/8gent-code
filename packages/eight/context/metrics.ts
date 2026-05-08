/**
 * Compression Metrics — track how the incremental compressor is performing.
 *
 * Issue #2420 acceptance criterion: "Compression quality measured against
 * golden test set." This module owns the in-memory + JSONL emission of
 * per-cycle metrics. The golden-set evaluation runs offline against the
 * JSONL log.
 *
 * Two retention proxies are computed without any model call:
 *   - artifactRetention: fraction of pre-compression artifacts still present
 *   - referenceRetention: fraction of file paths cited in the pre-compression
 *     window that are still cited (in artifacts or summary) after.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type CompressionTrigger = "milestone" | "token_pressure" | "manual";

export interface CompressionMetric {
	at: number;
	sessionId: string;
	trigger: CompressionTrigger;
	stage: string;
	tokensBefore: number;
	tokensAfter: number;
	compressionRatio: number;
	messagesRemoved: number;
	artifactsBefore: number;
	artifactsAfter: number;
	artifactRetention: number;
	referenceRetention: number;
	durationMs: number;
}

export interface MetricsSnapshot {
	totalCompressions: number;
	totalMessagesRemoved: number;
	totalTokensSaved: number;
	avgCompressionRatio: number;
	avgArtifactRetention: number;
	avgReferenceRetention: number;
	byTrigger: Record<CompressionTrigger, number>;
}

export class CompressionMetrics {
	private records: CompressionMetric[] = [];
	private logFile: string | null;

	constructor(logFile?: string | null) {
		this.logFile = logFile ?? null;
	}

	record(metric: CompressionMetric): void {
		this.records.push(metric);
		if (this.logFile) {
			try {
				fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
				fs.appendFileSync(this.logFile, `${JSON.stringify(metric)}\n`);
			} catch {
				// Logging is best-effort. Never block the agent on disk errors.
			}
		}
	}

	snapshot(): MetricsSnapshot {
		const n = this.records.length;
		const byTrigger: Record<CompressionTrigger, number> = {
			milestone: 0,
			token_pressure: 0,
			manual: 0,
		};
		if (n === 0) {
			return {
				totalCompressions: 0,
				totalMessagesRemoved: 0,
				totalTokensSaved: 0,
				avgCompressionRatio: 1,
				avgArtifactRetention: 1,
				avgReferenceRetention: 1,
				byTrigger,
			};
		}
		let totalRemoved = 0;
		let totalSaved = 0;
		let ratioSum = 0;
		let artSum = 0;
		let refSum = 0;
		for (const r of this.records) {
			totalRemoved += r.messagesRemoved;
			totalSaved += r.tokensBefore - r.tokensAfter;
			ratioSum += r.compressionRatio;
			artSum += r.artifactRetention;
			refSum += r.referenceRetention;
			byTrigger[r.trigger] += 1;
		}
		return {
			totalCompressions: n,
			totalMessagesRemoved: totalRemoved,
			totalTokensSaved: totalSaved,
			avgCompressionRatio: ratioSum / n,
			avgArtifactRetention: artSum / n,
			avgReferenceRetention: refSum / n,
			byTrigger,
		};
	}

	/** All records — for tests and ad-hoc inspection. */
	all(): readonly CompressionMetric[] {
		return this.records;
	}

	reset(): void {
		this.records = [];
	}
}

/**
 * Extract file-path-like tokens from message text. Used to compute
 * referenceRetention without an LLM call.
 *
 * Matches: relative paths with `/`, `.ts`/`.tsx`/`.js` etc., and absolute
 * paths starting with `/`. Conservative — false negatives are fine; the
 * metric only needs a stable signal, not perfection.
 */
const PATH_RE = /(?:[a-zA-Z0-9_\-./]+\/)?[a-zA-Z0-9_\-]+\.[a-zA-Z0-9]{1,5}/g;

export function extractPaths(text: string): Set<string> {
	const out = new Set<string>();
	const matches = text.match(PATH_RE);
	if (!matches) return out;
	for (const m of matches) {
		// Filter obvious non-paths: must contain a dot and either a slash or
		// a recognised code extension.
		if (m.includes("/") || /\.(ts|tsx|js|jsx|py|go|rs|md|json|yaml|yml|toml|css|html)$/.test(m)) {
			out.add(m);
		}
	}
	return out;
}

export function intersectionRatio(a: Set<string>, b: Set<string>): number {
	if (a.size === 0) return 1;
	let hits = 0;
	for (const x of a) if (b.has(x)) hits++;
	return hits / a.size;
}
