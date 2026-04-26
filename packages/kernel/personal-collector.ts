/**
 * PersonalCollector — Collect training pairs from session traces.
 *
 * Filters for quality: user accepted response, no correction followed,
 * tool calls succeeded. Tags with userId for personal LoRA training.
 *
 * Collected pairs are stored in .8gent/kernel/training/ as JSONL.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export interface TrainingPair {
	/** User ID for personal LoRA scoping */
	userId: string;
	/** Session ID for traceability */
	sessionId: string;
	/** The prompt/instruction */
	prompt: string;
	/** The model response */
	response: string;
	/** PRM judge score (0.0-1.0) */
	score: number;
	/** Model that generated the response */
	model: string;
	/** Whether tool calls in this turn succeeded */
	toolCallsSucceeded: boolean;
	/** Whether the user's next message was a correction */
	userCorrected: boolean;
	/** Timestamp of collection */
	collectedAt: number;
}

export interface CollectorStats {
	totalCollected: number;
	totalFiltered: number;
	averageScore: number;
	lastCollectedAt: number | null;
}

export class PersonalCollector {
	private trainingDir: string;
	private pairsPath: string;
	private statsPath: string;
	private minScore: number;
	private stats: CollectorStats;

	constructor(projectRoot: string = process.cwd(), minScore = 0.7) {
		this.trainingDir = resolve(projectRoot, ".8gent", "kernel", "training");
		this.pairsPath = join(this.trainingDir, "pairs.jsonl");
		this.statsPath = join(this.trainingDir, "stats.json");
		this.minScore = minScore;
		this.stats = this.loadStats();
	}

	/**
	 * Collect a training pair if it meets quality thresholds.
	 * Returns true if the pair was collected, false if filtered.
	 */
	collect(pair: Omit<TrainingPair, "collectedAt">): boolean {
		// Quality filters
		if (pair.score < this.minScore) {
			this.stats.totalFiltered++;
			this.saveStats();
			return false;
		}

		if (pair.userCorrected) {
			this.stats.totalFiltered++;
			this.saveStats();
			return false;
		}

		if (!pair.toolCallsSucceeded) {
			this.stats.totalFiltered++;
			this.saveStats();
			return false;
		}

		// Skip very short responses (likely errors or refusals)
		if (pair.response.length < 50) {
			this.stats.totalFiltered++;
			this.saveStats();
			return false;
		}

		// Collect the pair
		const fullPair: TrainingPair = {
			...pair,
			collectedAt: Date.now(),
		};

		this.ensureDir();
		appendFileSync(this.pairsPath, JSON.stringify(fullPair) + "\n");

		this.stats.totalCollected++;
		this.stats.lastCollectedAt = Date.now();
		this.stats.averageScore =
			(this.stats.averageScore * (this.stats.totalCollected - 1) + pair.score) /
			this.stats.totalCollected;
		this.saveStats();

		return true;
	}

	/**
	 * Get all collected pairs for a specific user.
	 */
	getPairs(userId?: string): TrainingPair[] {
		if (!existsSync(this.pairsPath)) return [];

		const lines = readFileSync(this.pairsPath, "utf-8")
			.split("\n")
			.filter(Boolean);

		const pairs = lines
			.map((line) => {
				try {
					return JSON.parse(line) as TrainingPair;
				} catch {
					return null;
				}
			})
			.filter(Boolean) as TrainingPair[];

		if (userId) {
			return pairs.filter((p) => p.userId === userId);
		}
		return pairs;
	}

	/**
	 * Get collection statistics.
	 */
	getStats(): CollectorStats {
		return { ...this.stats };
	}

	/**
	 * Get the count of collected pairs.
	 */
	getPairCount(userId?: string): number {
		return this.getPairs(userId).length;
	}

	private ensureDir(): void {
		if (!existsSync(this.trainingDir)) {
			mkdirSync(this.trainingDir, { recursive: true });
		}
	}

	private loadStats(): CollectorStats {
		try {
			if (existsSync(this.statsPath)) {
				return JSON.parse(readFileSync(this.statsPath, "utf-8"));
			}
		} catch {}
		return {
			totalCollected: 0,
			totalFiltered: 0,
			averageScore: 0,
			lastCollectedAt: null,
		};
	}

	private saveStats(): void {
		this.ensureDir();
		writeFileSync(this.statsPath, JSON.stringify(this.stats, null, 2));
	}
}
