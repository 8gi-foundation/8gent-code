/**
 * System One judge log (#3885).
 *
 * One JSON line per judge call (and per judge timeout or error) in
 * <data dir>/audit/system-one.jsonl, next to toolg8.jsonl, so a pilot's run
 * dir captures why a command was allowed, escalated or blocked. Observability
 * only: nothing reads the log back, and building plus writing a record sits
 * inside one try so nothing here can change a verdict.
 *
 * No command text is stored, not even scrubbed (a scrubber cannot know every
 * secret shape, #3886 review). A record carries the command's sha256 prefix,
 * the program name, the NAMES of leading env assignments (never values) and an
 * argument count. The hash lines the same command up across runs.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHome } from "../core/home.js";
import { scrub } from "../eight/secret-scanner";

export type JudgeOutcome = "verdict" | "timeout" | "error";

export interface SystemOneJudgeRecord {
	timestamp: string;
	outcome: JudgeOutcome;
	hash: string;
	/** First word after env assignments, basename only; "?" when it is not a plain program name. */
	program: string;
	/** Names (never values) of the leading NAME=value assignments. */
	envNames: string[];
	/** Words after the program, quote-aware. */
	argc: number;
	/** Raw judge pYes (before calibration); null when no model answered. */
	pYes: number | null;
	verdict: "allow" | "block" | "escalate" | null;
	/** Threshold set in force, e.g. calibrated(ollama, model). */
	thresholds: string;
	/** Raw pYes edges the verdict was cut with: escalate when low <= pYes <= high, block when pYes > blockAbove. */
	escalateLow: number;
	escalateHigh: number;
	blockAbove: number;
	backend: string | null;
	model: string | null;
	/** True when every judge question was answered from the in-process memo. */
	memoHit: boolean;
	rule?: string;
	/** For timeout / error: the error class name only, never its message. */
	errorKind?: string;
}

export function commandHash(command: string): string {
	return createHash("sha256").update(command).digest("hex").slice(0, 16);
}

/** Split on whitespace outside quotes. Values never leave this function's callers. */
function words(command: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | null = null;
	let has = false;
	for (const ch of command) {
		if (quote) {
			cur += ch;
			if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
			has = true;
		} else if (/\s/.test(ch)) {
			if (has) out.push(cur);
			cur = "";
			has = false;
		} else {
			cur += ch;
			has = true;
		}
	}
	if (has) out.push(cur);
	return out;
}

const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=/;
// Lowercase word, at most two trailing digits (bun, git, python3): a secret pasted as the command word has mixed case or digits through it.
const PLAIN_PROGRAM = /^[a-z][a-z._+-]{0,31}[0-9]{0,2}$/;

const SAFE_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,31}$/;

/** An env NAME is logged only if it looks like a name and no secret pattern matches it (a key can be used as a name). */
function safeEnvName(name: string): string {
	if (!SAFE_ENV_NAME.test(name)) return "?";
	try {
		return scrub(name).redactedCount > 0 ? "?" : name;
	} catch {
		return "?";
	}
}

export function describeCommand(command: string): { program: string; envNames: string[]; argc: number } {
	const w = words(String(command ?? ""));
	const envNames: string[] = [];
	let i = 0;
	while (i < w.length) {
		const m = ENV_ASSIGN.exec(w[i]);
		if (!m) break;
		if (envNames.length < 10) envNames.push(safeEnvName(m[1]));
		i++;
	}
	const first = w[i] ?? "";
	const base = first.includes("/") ? first.slice(first.lastIndexOf("/") + 1) : first;
	const program = PLAIN_PROGRAM.test(base) ? base : "?";
	return { program, envNames, argc: Math.max(0, w.length - i - 1) };
}

/** Null under `bun test` unless EIGHT_DATA_DIR points somewhere, so test runs never write the real home. */
export function systemOneLogPath(env: NodeJS.ProcessEnv = process.env): string | null {
	if (!env.EIGHT_DATA_DIR && env.NODE_ENV === "test") return null;
	return path.join(env.EIGHT_DATA_DIR || path.join(resolveHome(), ".8gent"), "audit", "system-one.jsonl");
}

export interface JudgeLogInput {
	command: string;
	thresholds: string;
	/** BashGuardOptions in force (raw edges); absent fields mean the guard's defaults. */
	opts?: { blockAbove?: number; escalateBand?: [number, number] };
	memoHit?: boolean;
	guard?: { verdict: "allow" | "block" | "escalate"; pYes: number; backend: string; model: string; rule?: string };
	outcome?: JudgeOutcome;
	error?: unknown;
}

/** Build and append one record. Never throws. */
export function logSystemOneJudge(input: JudgeLogInput): void {
	try {
		const file = systemOneLogPath();
		if (!file) return;
		const g = input.guard;
		const band = input.opts?.escalateBand ?? [0.35, 0.65];
		const rec: SystemOneJudgeRecord = {
			timestamp: new Date().toISOString(),
			outcome: input.outcome ?? "verdict",
			hash: commandHash(String(input.command ?? "")),
			...describeCommand(input.command),
			pYes: g && Number.isFinite(g.pYes) ? g.pYes : null,
			verdict: g ? g.verdict : null,
			thresholds: input.thresholds,
			escalateLow: band[0],
			escalateHigh: band[1],
			blockAbove: input.opts?.blockAbove ?? 0.5,
			backend: g ? g.backend : null,
			model: g ? g.model : null,
			memoHit: !!input.memoHit,
		};
		if (g?.rule) rec.rule = g.rule;
		if (input.error !== undefined) {
			rec.errorKind = (input.error as { name?: string })?.name || typeof input.error;
		}
		const dir = path.dirname(file);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const fresh = !fs.existsSync(file);
		fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
		if (fresh) fs.chmodSync(file, 0o600);
	} catch {
		// Observability must not change behaviour.
	}
}
