#!/usr/bin/env bun
/**
 * canary-measure.ts — the CANARY-MEASUREMENT SEAM (read-only).
 *
 * Promotion in the kernel needs hold-out PASS + canary PASS + human confirm
 * (Level 0). validate-holdout.ts produces the hold-out measurement; this file
 * produces the canary measurement. The promotion gate (promotion-gate.ts)
 * owns the DECISION; this is the honest signal it consumes.
 *
 * What it does:
 *   Replays a slice of RECENT REAL traffic (prompts the live model already
 *   answered) against BOTH the candidate and the baseline, scores them with the
 *   same objective grader used by the hold-out, and emits a CanarySignal in the
 *   exact shape promotion-gate.ts expects:
 *
 *       interface CanarySignal {
 *         turns: number;
 *         errors: number;            // candidate calls that failed outright
 *         candidateAvgScore: number; // 0..1
 *         activeAvgScore: number;    // 0..1
 *       }
 *
 *   (promotion-gate.ts canaryHealthy() compares candidateAvgScore vs
 *   activeAvgScore and errors/turns, so the scores here are normalized to 0..1.)
 *
 * READ-ONLY / NO SIDE EFFECTS:
 *   - It reads recent traffic from a trace file and re-asks both models.
 *   - It does NOT route live users to the candidate, mutate state, write policy,
 *     or promote anything. It only returns a measurement.
 *
 * FAIL-CLOSED:
 *   If real traffic is unavailable (no trace file / empty), it returns an
 *   INCONCLUSIVE signal (turns=0). promotion-gate.ts canaryHealthy() then
 *   rejects (`canary incomplete`). It NEVER returns a passing canary it could
 *   not measure.
 *
 * This module is INERT until the daemon/kernel calls measureCanary(). Importing
 * it enables nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type HoldOutItem, type ModelTarget, callModel, scoreItem } from "./validate-holdout";

/** Matches promotion-gate.ts CanarySignal exactly (scores in 0..1). */
export interface CanarySignal {
	turns: number;
	errors: number;
	candidateAvgScore: number;
	activeAvgScore: number;
}

export interface CanaryMeasurement extends CanarySignal {
	/** True only when we measured at least one real-traffic turn. */
	measured: boolean;
	status: string;
}

/**
 * One real-traffic turn: a prompt the live model already served, plus an
 * optional objective expectation. When `expected` is present we can grade
 * correctness exactly; otherwise we fall back to agreement-with-baseline so an
 * ungraded turn still yields a comparable (never fabricated) signal.
 */
export interface TrafficTurn {
	prompt: string;
	/** Optional gold answer for objective grading. */
	expected?: string;
	/** Match kind when `expected` is set (default "contains_normalized"). */
	match?: HoldOutItem["match"];
}

/** Default location the daemon writes recent (read-only) traffic samples to. */
export const DEFAULT_TRAFFIC_PATH = join(homedir(), ".8gent", "kernel", "recent-traffic.jsonl");

/**
 * Load a slice of recent real traffic. JSONL of TrafficTurn. Returns [] when
 * the file is absent/empty -> the caller fails closed (inconclusive canary).
 */
export function loadRecentTraffic(path: string, slice: number): TrafficTurn[] {
	if (!existsSync(path)) return [];
	const turns: TrafficTurn[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const obj = JSON.parse(t) as Record<string, unknown>;
			if (typeof obj.prompt === "string" && obj.prompt.length > 0) {
				turns.push({
					prompt: obj.prompt,
					expected: typeof obj.expected === "string" ? obj.expected : undefined,
					match: (obj.match as HoldOutItem["match"]) ?? "contains_normalized",
				});
			}
		} catch {
			// skip malformed lines
		}
	}
	// Take the most recent `slice` turns.
	return slice > 0 ? turns.slice(-slice) : turns;
}

export interface CanaryOptions {
	candidate: ModelTarget;
	baseline: ModelTarget;
	trafficPath?: string;
	/** How many recent turns to replay (default 50, matching canaryMinTurns). */
	slice?: number;
	/** Injectable for tests. */
	caller?: (target: ModelTarget, prompt: string) => Promise<string | null>;
	/** Injectable for tests. */
	traffic?: TrafficTurn[];
}

/**
 * Measure candidate vs baseline on a slice of recent real traffic. Read-only.
 * Returns a CanarySignal-shaped measurement; turns=0 means inconclusive
 * (fail-closed) and the promotion gate will reject it.
 */
export async function measureCanary(opts: CanaryOptions): Promise<CanaryMeasurement> {
	const slice = opts.slice ?? 50;
	const call = opts.caller ?? callModel;
	const traffic =
		opts.traffic ?? loadRecentTraffic(opts.trafficPath ?? DEFAULT_TRAFFIC_PATH, slice);

	if (traffic.length === 0) {
		return {
			turns: 0,
			errors: 0,
			candidateAvgScore: 0,
			activeAvgScore: 0,
			measured: false,
			status: "INCONCLUSIVE: no recent real traffic available (fail-closed)",
		};
	}

	let candTotal = 0;
	let baseTotal = 0;
	let errors = 0;
	let turns = 0;

	for (const turn of traffic) {
		const [candOut, baseOut] = await Promise.all([
			call(opts.candidate, turn.prompt),
			call(opts.baseline, turn.prompt),
		]);

		turns += 1;

		if (candOut === null) {
			// A candidate call that failed outright is a canary error.
			errors += 1;
			// baseline (if it answered) still contributes to the active average.
			if (baseOut !== null) baseTotal += scoreTurn(turn, baseOut);
			continue;
		}

		candTotal += scoreTurn(turn, candOut, baseOut);
		baseTotal += baseOut === null ? 0 : scoreTurn(turn, baseOut);
	}

	// Normalize 0..100 grader output to 0..1 for promotion-gate.ts.
	const candidateAvgScore = turns > 0 ? candTotal / turns / 100 : 0;
	const activeAvgScore = turns > 0 ? baseTotal / turns / 100 : 0;

	return {
		turns,
		errors,
		candidateAvgScore: Math.round(candidateAvgScore * 1000) / 1000,
		activeAvgScore: Math.round(activeAvgScore * 1000) / 1000,
		measured: true,
		status: `measured ${turns} real-traffic turns (${errors} candidate errors)`,
	};
}

/**
 * Score a single traffic turn objectively when a gold `expected` is present;
 * otherwise fall back to agreement-with-baseline (candidate output matches the
 * baseline output normalized). Agreement is a conservative proxy: it never
 * INVENTS a quality signal, it just measures "did the candidate at least match
 * what the trusted baseline produced".
 */
function scoreTurn(turn: TrafficTurn, candidateOut: string, baselineOut?: string | null): number {
	if (turn.expected !== undefined) {
		return scoreItem(
			{ id: "canary", prompt: turn.prompt, expected: turn.expected, match: turn.match ?? "contains_normalized" },
			candidateOut,
		);
	}
	// No gold: agreement with baseline (only meaningful for the candidate; for
	// the baseline itself this returns 100 by construction, which is correct —
	// the baseline trivially agrees with itself, so activeAvgScore is the bar).
	if (baselineOut === undefined) return 100; // scoring the baseline turn
	if (baselineOut === null) return 0;
	return scoreItem(
		{ id: "canary", prompt: turn.prompt, expected: baselineOut, match: "contains_normalized" },
		candidateOut,
	);
}

// ── CLI (optional manual run) ───────────────────────────────────────

if (import.meta.main) {
	const proxyUrl = process.env.TRAINING_PROXY_URL || "http://localhost:30000";
	const baselineUrl = process.env.BASELINE_MODEL_URL || "http://localhost:11434";
	const candidate: ModelTarget = {
		url: proxyUrl,
		model: process.env.HOLDOUT_CANDIDATE_MODEL || "qwen3:14b",
		label: "candidate",
	};
	const baseline: ModelTarget = {
		url: baselineUrl,
		model: process.env.HOLDOUT_BASELINE_MODEL || "qwen3:14b",
		label: "baseline",
	};
	measureCanary({ candidate, baseline })
		.then((m) => {
			console.log(JSON.stringify(m, null, 2));
			if (!m.measured) process.exit(1);
		})
		.catch((err) => {
			console.error(`Canary measurement error: ${err}`);
			process.exit(1);
		});
}
