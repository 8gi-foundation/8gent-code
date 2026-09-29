/**
 * 8gent Code - reporting a failed local text-tool turn.
 *
 * Two jobs the agent's catch used to get wrong:
 *  1. Say what actually happened. A slow model and a stopped server are
 *     different faults with different fixes. "timed out" used to be matched as
 *     a reachability failure, so a model that was simply slow was reported as
 *     "is not reachable. Is LM Studio or Ollama running?".
 *  2. Leave a runs.jsonl record. The catch returned before appendRun, so a
 *     failed turn left no trace.
 */

import type { RunLogEntry } from "../reporting/runlog";
import { TurnTimeoutError } from "./turn-timeout";

export type LocalTurnFailureKind = "timeout" | "unreachable" | "other";

const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ConnectionRefused"]);
const UNREACHABLE_RE =
	/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|unable to connect|connection refused|failed to connect|able to access the url/i;
const TIMEOUT_RE = /timed out|timeout|ETIMEDOUT/i;

function errName(err: unknown): string {
	return (err as { name?: unknown } | null)?.name === undefined
		? ""
		: String((err as { name?: unknown }).name);
}

function errCode(err: unknown): string {
	const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
	const code = e?.code ?? e?.cause?.code;
	return typeof code === "string" ? code : "";
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Sort a failed-turn error into timeout, unreachable, or other. */
export function classifyLocalTurnError(err: unknown): LocalTurnFailureKind {
	// A typed timeout wins over any message text.
	if (err instanceof TurnTimeoutError) return "timeout";
	const name = errName(err);
	if (name === "TurnTimeoutError" || name === "TimeoutError") return "timeout";

	const code = errCode(err);
	if (UNREACHABLE_CODES.has(code)) return "unreachable";
	if (code === "ETIMEDOUT") return "timeout";

	const msg = errMessage(err);
	if (UNREACHABLE_RE.test(msg)) return "unreachable";
	if (TIMEOUT_RE.test(msg)) return "timeout";
	return "other";
}

/**
 * The user-facing message plus a short machine-readable reason for runs.jsonl.
 * `timeoutMs` is the configured per-step limit, used when the error itself
 * does not carry one.
 */
export function describeLocalTurnFailure(
	err: unknown,
	ctx: { endpoint: string; timeoutMs: number },
): { kind: LocalTurnFailureKind; message: string; reason: string } {
	const raw = errMessage(err);
	const kind = classifyLocalTurnError(err);

	if (kind === "timeout") {
		const ms = err instanceof TurnTimeoutError ? err.timeoutMs : ctx.timeoutMs;
		const seconds = Math.round(ms / 1000);
		return {
			kind,
			message:
				`The local model (${ctx.endpoint}) took longer than ${seconds} seconds to answer, so the turn was stopped. ` +
				`It is running, just slow. Raise the limit with EIGHT_TURN_TIMEOUT_MS (milliseconds), ` +
				`for example EIGHT_TURN_TIMEOUT_MS=900000 for 15 minutes.`,
			reason: `timeout: took longer than ${seconds} seconds (${raw})`,
		};
	}

	if (kind === "unreachable") {
		return {
			kind,
			message: `The local model endpoint (${ctx.endpoint}) is not reachable. Is LM Studio or Ollama running? (${raw})`,
			reason: `unreachable: ${raw}`,
		};
	}

	return {
		kind,
		message: `The local model turn could not complete: ${raw}`,
		reason: raw,
	};
}

/** The runs.jsonl record for a turn that ended in an error. */
export function failedTurnRunEntry(opts: {
	model: string;
	startedAt: number;
	now?: number;
	tokens: number;
	cost: number | null;
	tools: number;
	created: string[];
	modified: string[];
	session: string;
	cwd: string;
	prompt: string;
	reason: string;
}): RunLogEntry {
	const now = opts.now ?? Date.now();
	return {
		ts: new Date(now).toISOString(),
		status: "error",
		model: opts.model,
		dur: Math.round((now - opts.startedAt) / 1000),
		tokens: opts.tokens,
		cost: opts.cost,
		tools: opts.tools,
		created: opts.created,
		modified: opts.modified,
		session: opts.session,
		cwd: opts.cwd,
		prompt: opts.prompt.slice(0, 120),
		error: opts.reason.slice(0, 300),
	};
}
