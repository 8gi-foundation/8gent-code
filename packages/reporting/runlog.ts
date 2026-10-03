/**
 * Run log — one line per agent run, appended to ~/.8gent/runs.jsonl
 *
 * No ceremony. Just the facts you'd scan in a terminal.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RunLogEntry {
	/** ISO timestamp */
	ts: string;
	/** "ok" | "fail" | "timeout" | "error" (a local text-tool turn that ended in an error) */
	status: "ok" | "fail" | "timeout" | "error";
	/** Model identifier */
	model: string;
	/** Duration in seconds */
	dur: number;
	/** Total tokens consumed */
	tokens: number;
	/** Cost in USD (from OpenRouter), null if unknown */
	cost: number | null;
	/** Number of tool calls */
	tools: number;
	/** Files created */
	created: string[];
	/** Files modified */
	modified: string[];
	/** Session ID (for cross-ref with ~/.8gent/sessions/) */
	session: string;
	/** Working directory */
	cwd: string;
	/** First 120 chars of the prompt */
	prompt: string;
	/** Error message if failed */
	error?: string;
	/**
	 * Claims in the final answer that the turn's own tool log contradicts, one
	 * short line each (e.g. "'ls deck' was requested but never ran"). Present
	 * only when non-empty. See packages/ai/claim-check.ts.
	 */
	unverified?: string[];
	/**
	 * The quick-answer lane's outcome for this turn (#3411), present only when
	 * EIGHT_QUICK_ANSWER=1: the prompt's class, whether the lane ran and answered,
	 * why it fell through, its wall time and the read-only tool calls it used.
	 */
	quick?: {
		class: string;
		ran: boolean;
		ok: boolean;
		reason?: string;
		ms: number;
		tools: number;
		/** The model the lane ran on, and why it was picked (EIGHT_QUICK_MODEL, preferred small model, session). */
		model?: string;
		modelSource?: "env" | "preferred" | "session";
		/** Prompt tokens per lane round, as the endpoint reported them (absent when it reported none). */
		promptTokens?: number[];
		/** The flagged claims when the lane was rejected as unverified: at most 5, 120 chars each. */
		claims?: string[];
	};
}

const LOG_PATH = path.join(os.homedir(), ".8gent", "runs.jsonl");

function ensureDir() {
	const dir = path.dirname(LOG_PATH);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

/** The quick line's claims are model output: at most this many, each at most CLAIM_MAX_CHARS. */
export const CLAIMS_MAX = 5;
export const CLAIM_MAX_CHARS = 120;

/** Enforce the claims cap at the write, whatever the caller passed (#3411, 8SO L3). Pure. */
export function capRunEntry(entry: RunLogEntry): RunLogEntry {
	const claims = entry.quick?.claims;
	if (!claims || !entry.quick) return entry;
	return {
		...entry,
		quick: {
			...entry.quick,
			claims: claims.slice(0, CLAIMS_MAX).map((c) => String(c).slice(0, CLAIM_MAX_CHARS)),
		},
	};
}

export function appendRun(entry: RunLogEntry): void {
	ensureDir();
	fs.appendFileSync(LOG_PATH, `${JSON.stringify(capRunEntry(entry))}\n`);
}

export function readRuns(limit = 20): RunLogEntry[] {
	if (!fs.existsSync(LOG_PATH)) return [];

	const lines = fs.readFileSync(LOG_PATH, "utf-8").trim().split("\n").filter(Boolean);
	const entries: RunLogEntry[] = [];

	// Read from the end
	for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
		try {
			entries.push(JSON.parse(lines[i]));
		} catch {
			// skip malformed lines
		}
	}

	return entries;
}

export function getLogPath(): string {
	return LOG_PATH;
}
