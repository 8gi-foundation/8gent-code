/**
 * Errors drawn as errors (#4955): the pure half.
 *
 * An error used to arrive as a grey system line, the same as "mode changed". This turns an error
 * text, or a retry that is happening, into a small row: its kind (timeout, network, rate limit,
 * provider, policy, tool, stopped), the cause in one line, how many retries, and the next step.
 * Nothing is invented: the kind comes from the text, the cause is the text's own first line, and
 * a next step is a fixed sentence per kind that names a real command. A guard that fired (a loop
 * warning, a nudge, the circuit breaker) is one `!` line in the agent's own words.
 */

export type ErrorKind =
	| "timeout"
	| "network"
	| "limit"
	| "provider"
	| "policy"
	| "tool"
	| "stopped"
	| "error";

export interface ErrorRow {
	kind: ErrorKind;
	/** One line, at most 70 characters. */
	cause: string;
	retry?: { n: number; of: number };
	next?: string;
}

const LABEL: Record<ErrorKind, string> = {
	timeout: "timeout",
	network: "network",
	limit: "rate limit",
	provider: "provider",
	policy: "policy",
	tool: "tool",
	stopped: "stopped",
	error: "error",
};

const NEXT: Partial<Record<ErrorKind, string>> = {
	timeout: "send again, or /provider to switch",
	network: "check the connection and that the model server is running",
	limit: "wait a minute, or /provider to switch",
	provider: "send again, or /provider to check it",
	policy: "adjust the request",
	tool: "see the tool row above",
	stopped: "send again",
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes is the point
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

function clean(s: string): string {
	return s.replace(ANSI, "").replace(CONTROL, "");
}

function clip(s: string, width: number): string {
	return s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`;
}

const CAUSE_MAX = 70;

function firstLine(text: string): string {
	for (const raw of clean(text).split("\n")) {
		const line = raw
			.replace(/^\s*\[Error\]\s*/, "")
			.replace(/^\s*\[BLOCKED\]\s*/, "")
			.replace(/^\s*Error(?: running tool "[^"]*")?:\s*/, "")
			.trim();
		if (line) return clip(line, CAUSE_MAX);
	}
	return "unknown error";
}

export function classifyError(text: string): ErrorRow {
	const t = clean(text);
	const exhausted = /^\s*(?:\[Error\]\s*)?All providers exhausted \((\d+) attempted\)/.exec(t);
	if (exhausted) {
		return {
			kind: "provider",
			cause: `all providers failed (${exhausted[1]} tried)`,
			next: NEXT.provider,
		};
	}
	let kind: ErrorKind = "error";
	if (/\[BLOCKED\]|refused by policy|\[PERMISSION DENIED\]|blocked by policy/i.test(t))
		kind = "policy";
	else if (/Stopped by user|\bAbortError\b|\baborted\b/i.test(t)) kind = "stopped";
	else if (/timed? ?out|timeout|ETIMEDOUT|stalled/i.test(t)) kind = "timeout";
	else if (
		/ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|fetch failed|socket hang up|unreachable|network/i.test(
			t,
		)
	)
		kind = "network";
	else if (/\b429\b|rate[ -]?limit|quota|too many requests/i.test(t)) kind = "limit";
	else if (
		/\b40[13]\b|invalid api key|unauthori[sz]ed|forbidden|authentication|\b5\d\d\b|server error|overloaded|bad request|\b400\b/i.test(
			t,
		)
	)
		kind = "provider";
	else if (/^\s*Error running tool|Unknown tool:/i.test(t)) kind = "tool";
	const row: ErrorRow = { kind, cause: firstLine(t) };
	const next = NEXT[kind];
	if (next) row.next = next;
	return row;
}

/** A retry or failover the agent reports (packages/eight/types.ts AgentRetryEvent). */
export interface RetryInfo {
	kind: "rate_limit" | "transient" | "failover";
	provider: string;
	model: string;
	attempt: number;
	max: number;
	cause: string;
	delayMs?: number;
	next?: string;
}

export function retryRow(e: RetryInfo): ErrorRow {
	const base = classifyError(e.cause);
	const row: ErrorRow = {
		kind: e.kind === "rate_limit" ? "limit" : base.kind === "error" ? "provider" : base.kind,
		cause: base.cause,
	};
	// A hop down the failover chain is not a counted retry; the same backend again is.
	if (e.kind !== "failover") row.retry = { n: e.attempt, of: e.max };
	if (e.kind === "rate_limit" && e.delayMs) row.next = `waiting ${Math.round(e.delayMs / 1000)}s`;
	else if (e.kind === "failover" && e.next) row.next = `fallback ${e.next}`;
	return row;
}

const WIDE = 60;

/** The row as lines that fit `width`: nothing wraps. */
export function errorLines(row: ErrorRow, width: number): string[] {
	const cause = clean(row.cause).replace(/\s+/g, " ").trim();
	const out: string[] = [];
	if (width >= WIDE) {
		const retry = row.retry ? `  retry ${row.retry.n} of ${row.retry.of}` : "";
		out.push(clip(`✗ ${LABEL[row.kind]}  ${cause}${retry}`, width));
	} else {
		out.push(clip(`✗ ${LABEL[row.kind]}: ${cause}`, width));
		if (row.retry) out.push(clip(`  retry ${row.retry.n}/${row.retry.of}`, width));
	}
	if (row.next) out.push(clip(`  next: ${clean(row.next)}`, width));
	return out;
}

export interface GuardInfo {
	kind: "loop_warning" | "loop_nudge" | "circuit_breaker";
	tool?: string;
	count?: number;
	reason?: string;
}

function plain(s: string | undefined): string {
	return clean(s ?? "")
		.replace(/\s+/g, " ")
		.replace(/[.\s]+$/, "")
		.trim();
}

/** One `!` line when a loop guard fires. */
export function guardNotice(e: GuardInfo, width: number): string {
	let line: string;
	if (e.kind === "loop_warning") {
		line =
			e.tool && e.count
				? `! loop: ${plain(e.tool)} failed ${e.count} times, trying another way`
				: "! loop: same call keeps failing, trying another way";
	} else if (e.kind === "loop_nudge") {
		line = `! loop: ${plain(e.reason) || "same call again, moving on"}`;
	} else {
		line = `! stopped: ${plain(e.reason) || "loop guard"}`;
	}
	return clip(line, width);
}

/** One `!` line for a retry that is happening. */
export function retryNotice(e: RetryInfo, width: number): string {
	const cause = plain(e.cause) || "provider error";
	let line: string;
	if (e.kind === "failover") {
		line = `! ${plain(e.model)} failed (${cause})${e.next ? `, trying ${plain(e.next)}` : ""}`;
	} else {
		// The wait comes first: a narrow screen cuts the cause, not the part that says how long.
		const wait = e.delayMs ? ` in ${Math.round(e.delayMs / 1000)}s` : "";
		line = `! retry ${e.attempt}/${e.max}${wait}: ${cause}`;
	}
	return clip(line, width);
}

/** What a chat message carries when it is an error or a guard, drawn by the message list at its width. */
export type Notice =
	| { tone: "error"; row: ErrorRow }
	| { tone: "warn"; guard: GuardInfo }
	| { tone: "warn"; retry: RetryInfo };

/** `retries`: how many retries this turn made before it failed; 0 shows no count. */
export function errorNotice(text: string, retries = 0): Notice {
	const row = classifyError(text);
	if (retries > 0) row.retry = { n: retries, of: retries };
	return { tone: "error", row };
}

export const guardNoticeOf = (guard: GuardInfo): Notice => ({ tone: "warn", guard });
export const retryNoticeOf = (retry: RetryInfo): Notice => ({ tone: "warn", retry });

export function noticeLines(n: Notice, width: number): string[] {
	if (n.tone === "error") return errorLines(n.row, width);
	return ["guard" in n ? guardNotice(n.guard, width) : retryNotice(n.retry, width)];
}

/** The plain text of a notice, for the saved transcript and for readers that draw no colour. */
export function noticeText(n: Notice): string {
	return noticeLines(n, 80).join("\n");
}
