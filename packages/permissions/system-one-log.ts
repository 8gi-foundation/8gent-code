/**
 * System One judge verdict log (#3885).
 *
 * One JSON line per judge call in <data dir>/audit/system-one.jsonl, next to
 * toolg8.jsonl, so a pilot's run dir captures why a command was allowed,
 * escalated or blocked. Observability only: nothing here reads the log back
 * and a write failure never changes a verdict.
 *
 * The command is never stored raw. `hash` is the first 16 hex of its sha256
 * (stable, so two runs of the same command line up) and `preview` is the
 * command after the repo's secret scrub, cut to PREVIEW_MAX characters.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHome } from "../core/home.js";
import { scrub } from "../eight/secret-scanner";

export const PREVIEW_MAX = 80;

export interface SystemOneVerdictRecord {
	timestamp: string;
	hash: string;
	preview: string;
	/** Raw judge pYes (before calibration); null when no model answered. */
	pYes: number | null;
	verdict: "allow" | "block" | "escalate";
	/** Threshold set the verdict was made under, e.g. calibrated(ollama, model). */
	thresholds: string;
	backend: string;
	model: string;
	/** True when every judge question was answered from the in-process memo. */
	memoHit: boolean;
	rule?: string;
}

export function commandHash(command: string): string {
	return createHash("sha256").update(command).digest("hex").slice(0, 16);
}

export function commandPreview(command: string): string {
	const clean = scrub(command).scrubbed.replace(/\s+/g, " ").trim();
	return clean.length > PREVIEW_MAX ? `${clean.slice(0, PREVIEW_MAX - 3)}...` : clean;
}

/** Null under `bun test` unless EIGHT_DATA_DIR points somewhere, so test runs never write the real home. */
export function systemOneLogPath(env: NodeJS.ProcessEnv = process.env): string | null {
	if (!env.EIGHT_DATA_DIR && env.NODE_ENV === "test") return null;
	return path.join(env.EIGHT_DATA_DIR || path.join(resolveHome(), ".8gent"), "audit", "system-one.jsonl");
}

export function buildRecord(
	command: string,
	guard: { verdict: SystemOneVerdictRecord["verdict"]; pYes: number; backend: string; model: string; rule?: string },
	thresholds: string,
	memoHit: boolean,
	now: Date = new Date(),
): SystemOneVerdictRecord {
	const rec: SystemOneVerdictRecord = {
		timestamp: now.toISOString(),
		hash: commandHash(command),
		preview: commandPreview(command),
		pYes: Number.isFinite(guard.pYes) ? guard.pYes : null,
		verdict: guard.verdict,
		thresholds,
		backend: guard.backend,
		model: guard.model,
		memoHit,
	};
	if (guard.rule) rec.rule = guard.rule;
	return rec;
}

/** Append one record. Never throws. */
export function logSystemOneVerdict(rec: SystemOneVerdictRecord): void {
	try {
		const file = systemOneLogPath();
		if (!file) return;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
	} catch {
		// Observability must not change behaviour.
	}
}
