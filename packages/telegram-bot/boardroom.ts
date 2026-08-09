/**
 * @8gent/telegram-bot - /boardroom
 *
 * Fans a question out to the eight 8GI officers and returns one verdict.
 *
 * The interaction constraint is the whole design: a run takes minutes and he
 * is on a phone, so the run produces EXACTLY ONE message in the chat, edited
 * in place as officers report. Never a message per officer. He can lock the
 * screen, come back, and the same message has moved on.
 *
 * Telegram rate-limits edits per chat, and eight officers times three state
 * changes each would blow that budget, so edits are throttled to one every
 * five seconds with a hard ceiling per run. A run that hits the ceiling still
 * finalises correctly; it just shows fewer intermediate states.
 *
 * Officers run read-only. Deliberation is analysis, not code, and nothing in
 * an unattended fan-out from a chat window should be able to write to a repo.
 */

import { spawn } from "node:child_process";

export interface Officer {
	/** Officer code, e.g. 8TO. */
	code: string;
	/** First name, used for the voice map and the row label. */
	name: string;
	/** Agent definition id under ~/.claude/agents/. */
	agent: string;
	/** One-line remit, injected so a cold agent knows what it is being asked for. */
	remit: string;
}

/** The full board. Order is the order the rows appear in the message. */
export const BOARD_ROSTER: Officer[] = [
	{ code: "8EO", name: "James", agent: "ai-james", remit: "executive call and trade-offs" },
	{ code: "8TO", name: "Rishi", agent: "8to-rishi", remit: "feasibility and blast radius" },
	{ code: "8PO", name: "Samantha", agent: "8po-samantha", remit: "user value and JTBD" },
	{ code: "8DO", name: "Moira", agent: "8do-moira", remit: "experience quality and accessibility" },
	{ code: "8SO", name: "Karen", agent: "8so-karen", remit: "security, compliance, data" },
	{ code: "8CO", name: "Luis", agent: "8co-luis", remit: "ecosystem and adoption" },
	{ code: "8MO", name: "Zara", agent: "8mo-zara", remit: "narrative and positioning" },
	{ code: "8GO", name: "Solomon", agent: "8go-solomon", remit: "policy and audit trail" },
];

/** Officer name to KittenTTS voice. Mirrors the Voice Experience Contract map. */
export const VOICE_BY_OFFICER: Record<string, string> = {
	James: "Jasper",
	Rishi: "Hugo",
	Samantha: "Bella",
	Moira: "Luna",
	Karen: "Kiki",
	Luis: "Leo",
	Zara: "Rosie",
	Solomon: "Bruno",
};

export type OfficerStatus = "pending" | "thinking" | "done" | "failed" | "timeout";

export interface OfficerRow {
	officer: Officer;
	status: OfficerStatus;
	brief?: string;
	error?: string;
}

const STATUS_MARK: Record<OfficerStatus, string> = {
	pending: "-",
	thinking: "~",
	done: "+",
	failed: "x",
	timeout: "!",
};

/** Default ceilings. Every one of these is a Telegram or attention limit. */
export const DEFAULT_RUN_TIMEOUT_MS = 8 * 60 * 1000;
export const MIN_EDIT_INTERVAL_MS = 5000;
export const MAX_EDITS_PER_RUN = 20;
/** A verdict longer than this is not a verdict, it is a memo. */
export const MAX_VERDICT_WORDS = 40;

/**
 * Render the single message. Pure, so the message shape is testable without
 * Telegram, a network, or a live board.
 */
export function renderBoard(
	topic: string,
	rows: OfficerRow[],
	opts: { verdict?: string; elapsedMs?: number; timedOut?: boolean } = {},
): string {
	const done = rows.filter((r) => r.status === "done").length;
	const lines: string[] = [];
	lines.push("*Boardroom*");
	lines.push(topic.length > 200 ? `${topic.slice(0, 197)}...` : topic);
	lines.push("");
	for (const r of rows) {
		const summary =
			r.status === "done"
				? firstLine(r.brief ?? "", 60)
				: r.status === "failed"
					? (r.error ?? "failed").slice(0, 60)
					: r.status === "timeout"
						? "no brief in time"
						: r.status === "thinking"
							? "thinking"
							: "waiting";
		lines.push(`\`${STATUS_MARK[r.status]}\` *${r.officer.code}* ${r.officer.name} - ${summary}`);
	}
	lines.push("");
	if (opts.verdict) {
		lines.push(`*Verdict:* ${opts.verdict}`);
		lines.push(`${done}/${rows.length} officers reported${elapsed(opts.elapsedMs)}`);
	} else if (opts.timedOut) {
		lines.push(`Timed out at 8 minutes. ${done} of ${rows.length} officers reported.`);
	} else {
		lines.push(`${done}/${rows.length} reported${elapsed(opts.elapsedMs)}`);
	}
	return lines.join("\n");
}

function elapsed(ms?: number): string {
	if (ms === undefined) return "";
	return ` in ${Math.round(ms / 1000)}s`;
}

function firstLine(text: string, max: number): string {
	const line = text.trim().split("\n").find((l) => l.trim().length > 0) ?? "";
	const clean = line.replace(/[*_`]/g, "").trim();
	return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean || "reported";
}

/** Trim a verdict to the word ceiling rather than trusting the model to obey it. */
export function clampVerdict(text: string, maxWords = MAX_VERDICT_WORDS): string {
	const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	if (words.length <= maxWords) return words.join(" ");
	return `${words.slice(0, maxWords).join(" ")}...`;
}

/**
 * Throttled single-message editor. Coalesces bursts of state changes into at
 * most one edit per interval and stops editing once the budget is spent, so a
 * run can never rate-limit the chat.
 */
export class EditThrottle {
	/** Negative infinity so the very first request edits immediately. */
	private lastEditAt = Number.NEGATIVE_INFINITY;
	private edits = 0;
	private pending: ReturnType<typeof setTimeout> | null = null;
	private latest: string | null = null;

	constructor(
		private readonly apply: (text: string) => Promise<void>,
		private readonly intervalMs = MIN_EDIT_INTERVAL_MS,
		private readonly maxEdits = MAX_EDITS_PER_RUN,
		private readonly clock: () => number = Date.now,
	) {}

	get editCount(): number {
		return this.edits;
	}

	/** Request that the message eventually show `text`. Never throws. */
	request(text: string): void {
		this.latest = text;
		if (this.edits >= this.maxEdits) return;
		const since = this.clock() - this.lastEditAt;
		if (since >= this.intervalMs) {
			this.flush();
			return;
		}
		if (this.pending) return;
		this.pending = setTimeout(() => {
			this.pending = null;
			this.flush();
		}, this.intervalMs - since);
	}

	/** Force the latest text out now, ignoring the interval but not the budget. */
	async finalise(text: string): Promise<void> {
		if (this.pending) {
			clearTimeout(this.pending);
			this.pending = null;
		}
		this.latest = text;
		this.lastEditAt = this.clock();
		this.edits++;
		await this.apply(text).catch(() => {});
	}

	private flush(): void {
		if (this.latest === null || this.edits >= this.maxEdits) return;
		const text = this.latest;
		this.lastEditAt = this.clock();
		this.edits++;
		this.apply(text).catch(() => {});
	}
}

export interface BoardroomDeps {
	/** Ask one officer for a brief. Returns their text. */
	askOfficer: (officer: Officer, topic: string, signal: AbortSignal) => Promise<string>;
	/** Ask the chair to compress the briefs into a verdict. */
	askVerdict: (topic: string, rows: OfficerRow[], signal: AbortSignal) => Promise<string>;
	/** Post the one message. Returns nothing; edits go through `editMessage`. */
	sendMessage: (text: string) => Promise<void>;
	/** Edit the one message in place. */
	editMessage: (text: string) => Promise<void>;
}

export interface BoardroomResult {
	rows: OfficerRow[];
	verdict: string;
	elapsedMs: number;
	timedOut: boolean;
	edits: number;
}

/**
 * Run a boardroom session. One message, edited; one verdict; no per-officer
 * spam. Officers that fail or run long are reported as failed rather than
 * silently dropped, because a partial board is a result and a spinner is not.
 */
export async function runBoardroom(
	topic: string,
	deps: BoardroomDeps,
	opts: {
		roster?: Officer[];
		timeoutMs?: number;
		intervalMs?: number;
		maxEdits?: number;
	} = {},
): Promise<BoardroomResult> {
	const roster = opts.roster ?? BOARD_ROSTER;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
	const started = Date.now();
	const rows: OfficerRow[] = roster.map((officer) => ({ officer, status: "pending" }));

	await deps.sendMessage(renderBoard(topic, rows));

	const throttle = new EditThrottle(deps.editMessage, opts.intervalMs, opts.maxEdits);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	for (const row of rows) row.status = "thinking";
	throttle.request(renderBoard(topic, rows, { elapsedMs: Date.now() - started }));

	await Promise.allSettled(
		rows.map(async (row) => {
			try {
				const brief = await deps.askOfficer(row.officer, topic, controller.signal);
				row.status = brief.trim() ? "done" : "failed";
				row.brief = brief.trim();
				if (row.status === "failed") row.error = "empty brief";
			} catch (err) {
				row.status = controller.signal.aborted ? "timeout" : "failed";
				row.error = err instanceof Error ? err.message : String(err);
			}
			throttle.request(renderBoard(topic, rows, { elapsedMs: Date.now() - started }));
		}),
	);
	clearTimeout(timer);

	const timedOut = controller.signal.aborted;
	let verdict = "";
	if (rows.some((r) => r.status === "done")) {
		try {
			verdict = clampVerdict(await deps.askVerdict(topic, rows, new AbortController().signal));
		} catch (err) {
			verdict = `No verdict: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
		}
	}

	const elapsedMs = Date.now() - started;
	await throttle.finalise(
		renderBoard(topic, rows, { verdict: verdict || undefined, elapsedMs, timedOut }),
	);

	return { rows, verdict, elapsedMs, timedOut, edits: throttle.editCount };
}

/**
 * Real officer invocation: the `claude` CLI with the officer's own agent
 * definition from ~/.claude/agents/.
 *
 * Write tools are disallowed explicitly. The officer definitions carry
 * `permissionMode: bypassPermissions`, which is correct for an interactive
 * session James is watching and wrong for eight agents spawned from a phone,
 * so the deny list is applied here rather than trusted to the definition.
 */
const OFFICER_DENIED_TOOLS = ["Edit", "Write", "NotebookEdit", "Bash", "Agent", "Artifact"];

export function askOfficerViaClaude(cwd: string) {
	return (officer: Officer, topic: string, signal: AbortSignal): Promise<string> => {
		const prompt = [
			`Boardroom question: ${topic}`,
			"",
			`Answer from your remit only (${officer.remit}).`,
			"At most 60 words. No preamble, no sign-off block, no headings.",
			"Open with your position, then the one fact that earned it.",
		].join("\n");
		return runClaude(["--agent", officer.agent, "-p", prompt], cwd, signal);
	};
}

export function askVerdictViaClaude(cwd: string) {
	return (topic: string, rows: OfficerRow[], signal: AbortSignal): Promise<string> => {
		const briefs = rows
			.filter((r) => r.status === "done")
			.map((r) => `${r.officer.code} ${r.officer.name}: ${r.brief}`)
			.join("\n");
		const prompt = [
			`Question: ${topic}`,
			"",
			"Officer positions:",
			briefs,
			"",
			`Give the board's verdict in at most ${MAX_VERDICT_WORDS} words.`,
			"Decision first. Name the strongest dissent in the same sentence if there is one.",
			"No preamble, no sign-off block.",
		].join("\n");
		return runClaude(["--agent", "ai-james", "-p", prompt], cwd, signal);
	};
}

function runClaude(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("claude", [...args, "--disallowedTools", ...OFFICER_DENIED_TOOLS], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		const onAbort = () => child.kill("SIGTERM");
		signal.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (d) => {
			out += String(d);
		});
		child.stderr?.on("data", (d) => {
			err += String(d);
		});
		child.on("error", (e) => {
			signal.removeEventListener("abort", onAbort);
			reject(e);
		});
		child.on("close", (code) => {
			signal.removeEventListener("abort", onAbort);
			if (code === 0) resolve(normaliseOfficerText(out));
			else reject(new Error(err.trim().slice(-160) || `claude exited ${code}`));
		});
	});
}

/**
 * Officers end on a `VOICE:`/`SIGN-OFF:` block, which is noise in a chat row,
 * and they emit em dashes, which the house style bans on every surface. Both
 * are fixed here rather than asked for in the prompt, because a prompt is a
 * request and this is a rule. Observed in the first live 8-officer run.
 */
export function normaliseOfficerText(text: string): string {
	return text
		.replace(/\n\s*(?:SIGN-OFF:|VOICE:)[\s\S]*$/i, "")
		.replace(/\s*[—–]\s*/g, " - ")
		.replace(/^\s*Verdict:\s*/i, "")
		.trim();
}
