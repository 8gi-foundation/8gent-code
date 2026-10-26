/**
 * @8gent/telegram-bot - Run display
 *
 * The default Telegram surface for a run: one status message, edited in
 * place, with Cancel and Show steps. Pure helpers live here (summariser,
 * rate limiter, log builder, texts) so they test without a network.
 *
 * Spec: 8PO tg-run-display, 26 Oct 2026. No model call anywhere in this
 * file: the sentence is a fixed map from tool kind to a plain verb.
 */

import { redact } from "../memory/redact";
import { redactKeys } from "../secrets/keys";
import { summarizeToolCall, summarizeToolResult } from "./mobile-formatter";

export const STATUS_MAX_CHARS = 80;
/** Spec 3: at most one live edit per 5 s. */
export const STATUS_EDIT_INTERVAL_MS = 5000;
/** Spec 7: Show steps stays on a finished run for 24 h. */
export const STEPS_RETENTION_MS = 24 * 60 * 60 * 1000;

export const ONLY_STARTER_CANCEL = "Only the person who started this can stop it.";
export const ONLY_STARTER_STEPS = "Only the person who started this can see the steps.";
export const RUN_GONE = "Those steps are no longer available.";
export const RUN_FINISHED = "That run has already finished.";

type Verb = { phrase: string; changes: boolean };

const READ = new Set(["read", "read_file", "cat", "view", "open"]);
const LOOK = new Set(["glob", "grep", "search", "find", "ls", "list", "list_files"]);
const CODE_LOOK = new Set([
	"get_symbol",
	"search_symbols",
	"get_file_outline",
	"outline",
	"get_file_tree",
]);
const WRITE = new Set(["write", "write_file", "edit", "edit_file", "patch", "multi_edit"]);
const SHELL = new Set(["bash", "shell", "run", "exec"]);
const WEB = new Set(["fetch", "web_fetch", "browse", "web_search", "websearch"]);
const HELPER = new Set(["agent", "delegate", "spawn"]);

/** Reduce an input to a lowercase blob used only to pick a topic word, never shown. */
function topicBlob(input: unknown): string {
	if (input === null || typeof input !== "object") return String(input ?? "").toLowerCase();
	try {
		return JSON.stringify(input).toLowerCase().slice(0, 600);
	} catch {
		return "";
	}
}

function topicOf(blob: string): "voice" | "settings" | null {
	if (/voice|speech|tts/.test(blob)) return "voice";
	if (/settings|config|\.env|preferences/.test(blob)) return "settings";
	return null;
}

function verbFor(tool: string, input: unknown): Verb {
	const name = String(tool || "").toLowerCase();
	const topic = topicOf(topicBlob(input));
	if (READ.has(name) || LOOK.has(name)) {
		if (topic === "voice") return { phrase: "checking the voice settings", changes: false };
		if (topic === "settings") return { phrase: "checking settings", changes: false };
		return { phrase: READ.has(name) ? "reading files" : "looking through files", changes: false };
	}
	if (CODE_LOOK.has(name)) return { phrase: "looking through the code", changes: false };
	if (WRITE.has(name)) {
		if (topic === "voice") return { phrase: "changing the voice settings", changes: true };
		if (topic === "settings") return { phrase: "changing settings", changes: true };
		return { phrase: "making changes", changes: true };
	}
	if (SHELL.has(name)) return { phrase: "running a check", changes: true };
	if (WEB.has(name)) return { phrase: "looking something up online", changes: false };
	if (name === "git") return { phrase: "working with the project history", changes: true };
	if (HELPER.has(name)) return { phrase: "getting a helper on part of it", changes: true };
	return { phrase: "working on it", changes: true };
}

/** One plain sentence for the step in flight. Deterministic, never a path or code, max 80. */
export function summariseStep(tool: string, input: unknown): string {
	const s = `Working on: ${verbFor(tool, input).phrase}`;
	return s.length <= STATUS_MAX_CHARS ? s : `${s.slice(0, STATUS_MAX_CHARS - 3)}...`;
}

/** True when this tool kind can change something, so a stop may leave it half done. */
export function stepChanges(tool: string, input: unknown): boolean {
	return verbFor(tool, input).changes;
}

/** First sentence of the agent's reply as a short plain outcome. No markup, no code. */
export function outcomeSentence(text: string, max = 160): string {
	const flat = String(text ?? "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[`*_#>]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!flat) return "finished";
	const m = flat.match(/^.*?[.!?](?=\s|$)/);
	const first = (m ? m[0] : flat).trim();
	return first.length <= max ? first : `${first.slice(0, max - 3)}...`;
}

/** Words and shapes banned on the default surface (spec 10). Shared by the status line and the Done line. */
const DEFAULT_SURFACE_BANNED: RegExp[] = [
	/\btool/i,
	/PERMISSION DENIED/i,
	/SYSTEM ONE/i,
	/Run Command/i,
	/Get Symbol/i,
	/constants/i,
	/\//,
	/`/,
	/\.(ts|js|json|md)\b/,
	/Error:/,
];

export function isPlainForDefaultSurface(sentence: string): boolean {
	return !DEFAULT_SURFACE_BANNED.some((re) => re.test(sentence));
}

/** The Done line's outcome: the first sentence if it is plain, else "" (the line then reads "Done."). */
export function doneOutcome(text: string): string {
	const o = outcomeSentence(text);
	return isPlainForDefaultSurface(o) ? o : "";
}

const BLOCKED_RE = /permission|denied|not allowed|needs your ok|approval|refus|forbidden|blocked/i;

/** One plain sentence for a run that ended in error. Never the raw error text. */
export function failureSentence(error: string): string {
	if (BLOCKED_RE.test(String(error ?? ""))) {
		return "I could not finish because a step needs your OK. Reply yes to allow it.";
	}
	return "Something went wrong and I could not finish. Send your request again, or tap Show steps to see what happened.";
}

export const statusText = {
	working: (sentence: string) => sentence,
	done: (outcome: string) => (outcome ? `Done: ${outcome}` : "Done."),
	failed: (reason: string) => `Stopped: ${reason}`,
	cancelled: (halfDone: boolean) =>
		halfDone
			? "Stopped. A change was in progress, so it may be half done. Check it before relying on it."
			: "Stopped. Nothing was left half done.",
};

export interface RunStep {
	at: number;
	tool: string;
	label: string;
	changes: boolean;
	done: boolean;
	result?: string;
}

/**
 * The step log leaves the device (it is a Telegram attachment), so every line
 * goes through the two existing redactors: memory/redact (tokens, bearer
 * headers, .env style lines, URL credentials) and secrets/keys (provider keys).
 */
export function redactForExport(text: string): string {
	return redactKeys(redact(String(text ?? ""))).text;
}

/** Build the full step log. Local text only; this is where raw detail is allowed. */
export function buildStepsLog(run: {
	id: string;
	request: string;
	startedAt: number;
	endedAt?: number;
	state: string;
	steps: RunStep[];
	error?: string;
}): string {
	const iso = (t: number) => new Date(t).toISOString();
	const lines = [
		"Step log",
		`Run: ${run.id}`,
		`Started: ${iso(run.startedAt)}`,
		`State: ${run.state}${run.endedAt ? ` at ${iso(run.endedAt)}` : ""}`,
		`Request: ${run.request}`,
		`Snapshot taken: ${iso(Date.now())}`,
		"",
	];
	if (run.steps.length === 0) lines.push("No steps recorded yet.");
	run.steps.forEach((s, i) => {
		lines.push(`${i + 1}. [${iso(s.at).slice(11, 19)}] ${s.label} (${s.tool})`);
		lines.push(`   ${s.done ? (s.result ?? "ok") : "in progress"}`);
	});
	if (run.error) lines.push("", `Error: ${run.error}`);
	return redactForExport(`${lines.join("\n")}\n`);
}

export function stepLabel(tool: string, input: unknown): string {
	const s = summarizeToolCall(tool, input);
	return `${s.icon} ${s.label}`;
}

export function stepResult(output: unknown, durationMs?: number): string {
	return summarizeToolResult(output, durationMs);
}

/**
 * Rate limiter for the live line. `set` records the newest sentence; an edit
 * goes out at most once per `intervalMs`, only if the sentence differs from
 * the one on screen. The first change after a quiet spell goes out at once.
 */
export class StatusLine {
	private shown: string;
	private latest: string;
	private lastEditAt: number;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private closed = false;

	constructor(
		initial: string,
		private intervalMs: number,
		private edit: (sentence: string) => Promise<void>,
	) {
		this.shown = initial;
		this.latest = initial;
		this.lastEditAt = Date.now();
	}

	set(sentence: string): void {
		if (this.closed) return;
		this.latest = sentence;
		if (sentence === this.shown || this.timer) return;
		const wait = Math.max(0, this.lastEditAt + this.intervalMs - Date.now());
		if (wait === 0) {
			this.fire();
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = null;
			this.fire();
		}, wait);
	}

	private fire(): void {
		if (this.closed || this.latest === this.shown) return;
		this.shown = this.latest;
		this.lastEditAt = Date.now();
		this.edit(this.shown).catch(() => {});
	}

	close(): void {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}
}
