/**
 * Run log — one line per agent run, appended to ~/.8gent/runs.jsonl
 *
 * No ceremony. Just the facts you'd scan in a terminal.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redact } from "../memory/redact";

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
	/** The prompt, redacted, then cut to PROMPT_MAX_CHARS by capRunEntry (pass it whole) */
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
		/** True when the turn asked the one fixed question instead of answering (#3416). */
		asked?: boolean;
		/** True when the prompt went to the full loop because it needs the earlier conversation (#3416). */
		context?: boolean;
		/** Submit to the moment the quick answer was shown, in ms (#3416). */
		shownMs?: number;
		/** How the full answer compared with the shown quick answer (#3416). */
		verdict?: "confirmed" | "corrected" | "unknown" | "unchecked" | "stopped" | "none";
		/** The shown quick answer's facts: at most 8, 40 chars each (#3416). */
		facts?: string[];
		/** The shown quick answer, at most 300 chars, so the judge can grade it (#3416). */
		text?: string;
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

/** The quick line's facts and answer text: at most FACTS_MAX facts of FACT_MAX_CHARS, and QUICK_TEXT_MAX_CHARS (#3416). */
export const FACTS_MAX = 8;
/** The prompt is redacted whole, then cut to this many chars, so a cut never splits a secret (#3416). */
export const PROMPT_MAX_CHARS = 120;
export const FACT_MAX_CHARS = 40;
export const QUICK_TEXT_MAX_CHARS = 300;

/**
 * Enforce the redaction and the caps at the write, whatever the caller passed (#3411, #3416):
 * the prompt, the quick claims and text are redacted; a fact the redactor would change is
 * dropped; then claims, facts and text are capped. Pure; returns the entry itself when
 * nothing changes.
 */
export function capRunEntry(entry: RunLogEntry): RunLogEntry {
	// Redact before cutting: a secret split by the cut would no longer match a pattern.
	const prompt = redact(entry.prompt).slice(0, PROMPT_MAX_CHARS);
	const q = entry.quick;
	const quickTouched =
		q !== undefined && (q.claims !== undefined || q.facts !== undefined || q.text !== undefined);
	if (prompt === entry.prompt && !quickTouched) return entry;
	return {
		...entry,
		prompt,
		...(q && quickTouched
			? {
					quick: {
						...q,
						...(q.claims
							? {
									claims: q.claims
										.slice(0, CLAIMS_MAX)
										.map((c) => redact(String(c)).slice(0, CLAIM_MAX_CHARS)),
								}
							: {}),
						...(q.facts
							? {
									facts: q.facts
										.map(String)
										.filter((f) => redact(f) === f)
										.slice(0, FACTS_MAX)
										.map((f) => f.slice(0, FACT_MAX_CHARS)),
								}
							: {}),
						...(q.text !== undefined
							? { text: redact(String(q.text)).slice(0, QUICK_TEXT_MAX_CHARS) }
							: {}),
					},
				}
			: {}),
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
