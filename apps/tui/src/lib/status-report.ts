/**
 * 8gent Code - /status report and approval mode
 *
 * Pure functions only: no React, no fs, no clocks. The TUI collects a plain
 * `StatusReportState` from the same state the ActivityRail and the per-tab
 * agent bookkeeping already use, and this module turns it into the short
 * aligned lines `/status` prints.
 *
 * The rule for every section is "only when it has something real to say".
 * A section with nothing in it is omitted rather than rendered as a
 * placeholder row, so the message answers "what is going on?" and nothing
 * else. When nothing is running, waiting or blocked the report says so in
 * one line, because "idle" is a real state, not a placeholder.
 */

import { formatSessionTime } from "./format.js";

// ============================================
// Approval mode (shared by the ContextRail and the bottom APPROVAL tile)
// ============================================

export type ApprovalMode = "ask" | "auto" | "waiting";

export interface ApprovalModeInputs {
	/** A tool call is parked on a Y/N/E prompt right now. */
	approvalPending: boolean;
	/** Infinite mode: the session runs without asking. */
	infiniteModeActive: boolean;
	/** `--auto-approve` style launch flag: the session runs without asking. */
	cliAutoApprove: boolean;
}

/**
 * One derivation for every surface that names the approval mode, so the
 * rail and the instrument strip can never disagree. Waiting wins over
 * everything (a pending prompt is a fact regardless of mode), then the
 * autonomous flags, then the default of asking.
 */
export function deriveApprovalMode(i: ApprovalModeInputs): ApprovalMode {
	if (i.approvalPending) return "waiting";
	if (i.infiniteModeActive || i.cliAutoApprove) return "auto";
	return "ask";
}

// ============================================
// Status report
// ============================================

export interface StatusRunningTab {
	/** Chat tab title as shown in the tab bar. */
	title: string;
	/** Milliseconds since this tab's turn started. */
	elapsedMs: number;
	/** Tool call in flight on this tab, when one is known. */
	tool?: string | null;
}

export interface StatusQueuedTab {
	title: string;
	/** Follow-up messages queued behind the running turn on this tab. */
	count: number;
}

export interface StatusReportState {
	running: StatusRunningTab[];
	waiting: {
		/** Command or action parked on the approval prompt, if any. */
		approvalTarget: string | null;
		/** Onboarding question still open, if any. */
		onboardingQuestion: string | null;
		queued: StatusQueuedTab[];
	};
	blocked: {
		/** Provider id in use (ollama, lmstudio, apfel, openrouter, ...). */
		provider: string;
		/** False when the model list for the provider could not be fetched. */
		providerReachable: boolean;
		/** Local engine probe result, when the probe has reported. */
		localEngines: { live: number; total: number } | null;
	};
	plan: {
		ready: number;
		inProgress: number;
		done: number;
		/** Description of the next step, when the board has one. */
		next: string | null;
	};
	session: {
		provider: string;
		model: string | null;
		branch: string | null;
		durationMs: number;
		tokens: number;
	};
}

/** Label column width; "Waiting on you" is the longest label. */
const LABEL_WIDTH = 15;
/** Longest fragment we keep from a free-text field before truncating. */
const MAX_FRAGMENT = 60;

function pad(label: string): string {
	return label.padEnd(LABEL_WIDTH, " ");
}

function row(label: string, text: string): string {
	return `${pad(label)}${text}`;
}

function continuation(text: string): string {
	return row("", text);
}

function clip(text: string, max = MAX_FRAGMENT): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Push a section's lines with the label on the first line and blank
 * label space on the rest, so a section with several facts stays aligned.
 */
function pushSection(out: string[], label: string, lines: string[]): void {
	lines.forEach((line, i) => {
		out.push(i === 0 ? row(label, line) : continuation(line));
	});
}

function runningLines(s: StatusReportState): string[] {
	return s.running.map((r) => {
		const parts = [r.title, formatSessionTime(Math.max(0, r.elapsedMs))];
		if (r.tool) parts.push(clip(r.tool, 40));
		return parts.join("  ");
	});
}

function waitingLines(s: StatusReportState): string[] {
	const lines: string[] = [];
	if (s.waiting.approvalTarget) {
		lines.push(`approve? ${clip(s.waiting.approvalTarget)}`);
	}
	if (s.waiting.onboardingQuestion) {
		lines.push(`answer: ${clip(s.waiting.onboardingQuestion)}`);
	}
	for (const q of s.waiting.queued) {
		if (q.count <= 0) continue;
		lines.push(`${q.count} queued on ${q.title}`);
	}
	return lines;
}

function blockedLines(s: StatusReportState): string[] {
	if (s.blocked.providerReachable) return [];
	let line = `${s.blocked.provider} unreachable`;
	const eng = s.blocked.localEngines;
	if (eng && eng.total > 0) {
		line += ` · local engines ${eng.live}/${eng.total} up`;
	}
	return [line];
}

function planLines(s: StatusReportState): string[] {
	const { ready, inProgress, done, next } = s.plan;
	const lines: string[] = [];
	if (ready + inProgress + done > 0) {
		lines.push(`ready ${ready} · in progress ${inProgress} · done ${done}`);
	}
	if (next) lines.push(`next: ${clip(next)}`);
	return lines;
}

function sessionLine(s: StatusReportState): string {
	const parts: string[] = [];
	const where = s.session.model ? `${s.session.provider} ${s.session.model}` : s.session.provider;
	if (where.trim()) parts.push(where.trim());
	if (s.session.branch) parts.push(s.session.branch);
	parts.push(formatSessionTime(Math.max(0, s.session.durationMs)));
	parts.push(`${s.session.tokens.toLocaleString("en-US")} tok`);
	return parts.join(" · ");
}

/**
 * Render the status report as aligned lines, sections in priority order:
 * Running, Waiting on you, Blocked, Plan, Session. Empty sections are
 * omitted; when the first three are all empty a single Idle line states
 * that instead.
 */
export function formatStatusReport(s: StatusReportState): string[] {
	const out: string[] = [];
	const running = runningLines(s);
	const waiting = waitingLines(s);
	const blocked = blockedLines(s);

	pushSection(out, "Running", running);
	pushSection(out, "Waiting on you", waiting);
	pushSection(out, "Blocked", blocked);
	if (running.length === 0 && waiting.length === 0 && blocked.length === 0) {
		out.push(row("Idle", "nothing running, nothing waiting on you"));
	}
	pushSection(out, "Plan", planLines(s));
	out.push(row("Session", sessionLine(s)));
	return out;
}
