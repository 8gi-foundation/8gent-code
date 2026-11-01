/**
 * The folded trace (#5170): while a turn runs, the per-step rows (tool calls,
 * their output, the judge's lines) sit behind one status row that reads
 * "Working: reading files (step 3, 12s)". Enter opens the full list in place;
 * Esc or Enter folds it again. The same rule as the Telegram run display: only
 * what the person needs to read shows by default, the full trace is one action
 * away.
 *
 * Pure functions only, so the wording, the cap and the switch are testable
 * without a renderer. components/FoldedStatus.tsx draws the row.
 */

import { type Settings, loadSettings } from "../../../../packages/settings/index.js";
import type { ToolTrailEntry } from "./tool-trail.js";

/** The longest the status row may be, paths or not. */
export const STATUS_MAX_CHARS = 80;
/** The row redraws at most twice a second. */
export const STATUS_REFRESH_MS = 500;

/**
 * Whether the steps show as rows while a turn works (today's behaviour).
 * EIGHT_TUI_TRACE=on forces them on, =off forces them folded; unset, the
 * "Show steps while working" setting decides, and it defaults to off.
 */
export function showStepsWhileWorking(
	env: Record<string, string | undefined> = process.env,
	read: () => Pick<Settings, "ui"> = loadSettings,
): boolean {
	const v = env.EIGHT_TUI_TRACE?.trim().toLowerCase();
	if (v === "on" || v === "1" || v === "true") return true;
	if (v === "off" || v === "0" || v === "false") return false;
	try {
		return read().ui?.showSteps === true;
	} catch {
		return false;
	}
}

/** A plain verb phrase for what a call is doing. Never a path, never a tool name. */
export function stepPhrase(tool: string | null | undefined): string {
	const name = (tool ?? "").toLowerCase();
	if (!name) return "thinking it through";
	if (/judge|system_?one|safety/.test(name)) return "asking the judge";
	if (/command|shell|exec|bash|test|check|lint|build|typecheck/.test(name))
		return "running a check";
	if (/edit|write|patch|apply|create|delete|remove|move|rename|replace/.test(name))
		return "editing a file";
	if (/search|grep|glob|find|fetch|web|query|lookup/.test(name)) return "searching";
	if (/read|list|view|get_|cat|open|ls|outline|symbol/.test(name)) return "reading files";
	return "working on the next step";
}

/**
 * "Working: reading files (step 3, 12s)". Capped at STATUS_MAX_CHARS. Given a
 * narrower `fit` (columns the row has), the seconds go first, then the word
 * "step", so the phrase and the step count survive on a phone.
 */
export function statusLine(
	opts: {
		tool: string | null | undefined;
		step: number;
		seconds: number;
	},
	fit: number = STATUS_MAX_CHARS,
): string {
	const step = Math.max(1, Math.floor(opts.step));
	const seconds = Math.max(0, Math.floor(opts.seconds));
	const phrase = stepPhrase(opts.tool);
	const max = Math.min(STATUS_MAX_CHARS, Math.max(1, fit));
	const forms = [
		`Working: ${phrase} (step ${step}, ${seconds}s)`,
		`Working: ${phrase} (step ${step})`,
		`Working: ${phrase} (${step})`,
		`Working: ${phrase}`,
		phrase,
	];
	const line = forms.find((f) => f.length <= max) ?? (forms[forms.length - 1] as string);
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** The call the status row speaks of: the one running, else the newest finished. */
export function statusTool(
	liveTool: string | null | undefined,
	trail: ToolTrailEntry[],
): string | null {
	return liveTool ?? trail[trail.length - 1]?.tool ?? null;
}

/** The call count the row shows: finished calls, plus the one in flight. */
export function statusStep(liveTool: string | null | undefined, trail: ToolTrailEntry[]): number {
	return Math.max(1, trail.length + (liveTool ? 1 : 0));
}

/**
 * One plain sentence for a turn a blocked or refused step ended, or null when
 * nothing did. Says what was blocked and that the person can allow it if they
 * want; never the raw reason text, never a settings change (prompts default No,
 * nothing is allowed on the person's behalf).
 */
export function blockedSentence(trail: ToolTrailEntry[]): string | null {
	const last = trail[trail.length - 1];
	if (!last || last.status !== "blocked") return null;
	const what = stepPhrase(last.tool);
	return `A safety check stopped this while ${what}, so it did not run. Say so if you want it allowed.`;
}

/**
 * The sentence shows only under the turn that just ended (`justEnded`: the last
 * item, no turn running), and only when the block is why it ended: no reply came
 * after it. An older turn, a running turn, or one that recovered in text shows none.
 */
export function showsBlockedSentence(o: { justEnded: boolean; reply: string }): boolean {
	return o.justEnded && !o.reply.trim();
}

/** Narrower than this many columns for the row, the marker carries the key hint. */
export const NARROW_ROW = 54;

/**
 * The folded status row, marker included. Narrow rows have no footer hint
 * room, so the marker carries it ("▸ Enter: steps"); an open list says
 * "Esc closes" in the row at any width.
 */
export function foldedRow(o: {
	marker: string;
	open: boolean;
	tool: string | null | undefined;
	step: number;
	seconds: number;
	width: number;
}): string {
	const lead = `${o.marker} `;
	const status = (fit: number) =>
		statusLine({ tool: o.tool, step: o.step, seconds: o.seconds }, fit);
	if (o.width < NARROW_ROW) {
		const head = `${lead}${o.open ? "Esc closes" : "Enter: steps"}`;
		const rest = o.width - head.length - 1;
		return rest >= 8 ? `${head} ${status(rest)}` : head;
	}
	if (o.open) {
		const tail = " - Esc closes";
		return `${lead}${status(o.width - lead.length - tail.length)}${tail}`;
	}
	return `${lead}${status(o.width - lead.length)}`;
}

/** A sentence broken on spaces into lines of at most `width` columns. */
export function wrapSentence(text: string, width: number): string[] {
	const w = Math.max(1, width);
	const lines: string[] = [];
	let line = "";
	for (let word of text.split(" ")) {
		if (line && line.length + 1 + word.length <= w) {
			line += ` ${word}`;
			continue;
		}
		if (line) lines.push(line);
		while (word.length > w) {
			lines.push(word.slice(0, w));
			word = word.slice(w);
		}
		line = word;
	}
	if (line) lines.push(line);
	return lines;
}
