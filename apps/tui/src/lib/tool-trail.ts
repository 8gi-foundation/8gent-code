/**
 * Tool trail: one compact chat line per tool call, attached to the assistant
 * turn it belongs to.
 *
 * Why: tools like write_file (3-5 ms) and run_command (3-350 ms) finish before
 * a person can read the live "Running <tool>" status, and tool messages are
 * kept out of chat, so afterwards only an "N tools" counter remained. A person
 * watching could not tell what the agent actually did (Rishi's pilot,
 * 2026-09-29). This is the visible half of the claim check in
 * packages/ai/claim-check.ts: the model's answer and the calls it made sit
 * side by side.
 *
 * Pure functions only, so the formatting and grouping rules are testable
 * without a renderer. components/ToolTrail.tsx draws the rows.
 */

export type TrailStatus = "ok" | "fail" | "blocked";

export interface ToolTrailEntry {
	tool: string;
	/** Short argument summary: path, command, or query. May be empty. */
	summary: string;
	status: TrailStatus;
	/** Short reason for fail/blocked, e.g. "exit 1" or "blocked: [no-secrets-in-files]". */
	reason?: string;
	/** update_plan only: the steps and statuses the agent reported (lib/turn-results.ts). */
	plan?: Array<{ step: string; status: string }>;
}

export interface ToolTrailRow extends ToolTrailEntry {
	/** Number of calls this row stands for (>1 when collapsed or folded). */
	count: number;
	/** True for the "N earlier calls" row of a very long turn. */
	folded?: boolean;
	/** Folded rows only: how many of the folded calls failed / were blocked. */
	failed?: number;
	blocked?: number;
	/** Folded rows only: true when the fold covers every call in the turn. */
	all?: boolean;
}

/** Above this many calls in a turn, consecutive successful reads collapse. */
export const COLLAPSE_THRESHOLD = 8;
/** Hard ceiling on rows per turn; oldest successes fold into one row. */
export const MAX_TRAIL_ROWS = 12;

const PATH_KEYS = ["path", "file_path", "filePath", "file", "directory", "dir"];
const COMMAND_KEYS = ["command", "cmd"];
const QUERY_KEYS = ["query", "pattern", "q", "search", "url"];

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim().slice(0, 200);
}

function pick(args: Record<string, unknown>, keys: string[]): string | null {
	for (const k of keys) {
		const v = args[k];
		if (typeof v === "string" && v.trim()) return oneLine(v);
	}
	return null;
}

/** The part of a call's arguments worth one glance. */
export function summarizeToolArgs(tool: string, args: Record<string, unknown> | undefined): string {
	if (!args || typeof args !== "object") return "";
	const isCommand = /command|shell|exec|bash/.test(tool);
	const order = isCommand
		? [COMMAND_KEYS, PATH_KEYS, QUERY_KEYS]
		: /search|grep|glob|find|fetch/.test(tool)
			? [QUERY_KEYS, PATH_KEYS, COMMAND_KEYS]
			: [PATH_KEYS, COMMAND_KEYS, QUERY_KEYS];
	for (const keys of order) {
		const hit = pick(args, keys);
		if (hit) return hit;
	}
	for (const v of Object.values(args)) {
		if (typeof v === "string" && v.trim()) return oneLine(v);
	}
	return "";
}

// "[TOOLG8 BLOCKED]", "[BLOCKED]", "[MAKER-CHECKER BLOCKED]", "[PERMISSION DENIED]".
const GATE_PREFIX = /^\s*\[([A-Z0-9_ -]*\b(?:BLOCKED|DENIED)\b[A-Z0-9_ -]*)\]/;
const OTHER_BLOCK = /^\s*(?:Path blocked by path-guard|Path traversal blocked)|Hook blocked tool/;
// Policy rule names are lowercase kebab-case in brackets: [no-secrets-in-files].
const RULE_NAME = /\[([a-z0-9]+(?:-[a-z0-9]+)+)\]/;

/** Map a tool's success flag and result text to a trail status and reason. */
export function classifyToolResult(
	success: boolean,
	preview: string | undefined,
): { status: TrailStatus; reason?: string } {
	const text = preview ?? "";
	const gate = text.match(GATE_PREFIX);
	if (gate || OTHER_BLOCK.test(text)) {
		if (gate && /DENIED/.test(gate[1])) return { status: "blocked", reason: "denied" };
		const rule = text.match(RULE_NAME);
		return { status: "blocked", reason: rule ? `blocked: [${rule[1]}]` : "blocked" };
	}
	const exit = text.match(/^\s*Exit code (-?\d+)/);
	if (exit && exit[1] !== "0") return { status: "fail", reason: `exit ${exit[1]}` };
	if (!success || /^\s*(?:Error\b|Unknown tool:)/.test(text)) {
		const first = (text.split("\n").find((l) => l.trim()) ?? "")
			.replace(/^\s*Error(?: running tool "[^"]*")?:?\s*/, "")
			.trim();
		if (!first) return { status: "fail", reason: "error" };
		return { status: "fail", reason: first.length > 40 ? `${first.slice(0, 39)}…` : first };
	}
	return { status: "ok" };
}

/** Build a trail entry from an AgentToolEndEvent-shaped object. */
export function toTrailEntry(event: {
	toolName: string;
	args?: Record<string, unknown>;
	success: boolean;
	resultPreview?: string;
}): ToolTrailEntry {
	const { status, reason } = classifyToolResult(event.success !== false, event.resultPreview);
	const entry: ToolTrailEntry = {
		tool: event.toolName,
		summary: summarizeToolArgs(event.toolName, event.args),
		status,
	};
	if (reason) entry.reason = reason;
	if (event.toolName === "update_plan") {
		const items = (event.args as { plan?: unknown } | undefined)?.plan;
		if (Array.isArray(items)) {
			const plan = items
				.map((i) => (i && typeof i === "object" ? (i as { step?: unknown; status?: unknown }) : {}))
				.filter((i): i is { step: string; status: unknown } => typeof i.step === "string" && i.step.trim() !== "")
				.map((i) => ({ step: i.step, status: typeof i.status === "string" ? i.status : "pending" }));
			if (plan.length > 0) entry.plan = plan;
		}
	}
	return entry;
}

function isReadTool(tool: string): boolean {
	return /^(?:read_|list_|get_|search|grep|glob|find|view|web_search|web_fetch)/.test(tool);
}

/** Longest shared directory prefix of paths, ending in "/", or "". */
function commonDir(paths: string[]): string {
	const split = paths.map((p) => p.split("/").slice(0, -1));
	const first = split[0] ?? [];
	let n = 0;
	while (n < first.length && split.every((s) => s[n] === first[n])) n++;
	return n > 0 ? `${first.slice(0, n).join("/")}/` : "";
}

/**
 * Turn a turn's entries into display rows. Up to COLLAPSE_THRESHOLD calls show
 * one per line. Above that, consecutive successful calls of the same read tool
 * collapse into "read_file ×5 (dir/…)". Failures and blocks never collapse. If
 * the result is still longer than `maxRows` (MAX_TRAIL_ROWS by default, less
 * when the chat window is short), the oldest rows fold into one "N earlier
 * calls" row: successes first, so failures and blocks stay visible for as long
 * as the space allows. The fold row counts what it hides that went wrong.
 */
export function collapseTrail(entries: ToolTrailEntry[], maxRows = MAX_TRAIL_ROWS): ToolTrailRow[] {
	let rows: ToolTrailRow[] = entries.map((e) => ({ ...e, count: 1 }));
	if (entries.length > COLLAPSE_THRESHOLD) {
		const out: ToolTrailRow[] = [];
		for (let i = 0; i < entries.length; ) {
			const e = entries[i];
			let j = i + 1;
			if (e.status === "ok" && isReadTool(e.tool)) {
				while (j < entries.length && entries[j].tool === e.tool && entries[j].status === "ok") j++;
			}
			if (j - i > 1) {
				const run = entries.slice(i, j);
				out.push({
					tool: e.tool,
					status: "ok",
					count: run.length,
					summary: commonDir(run.map((r) => r.summary)),
				});
			} else {
				out.push({ ...e, count: 1 });
			}
			i = j;
		}
		rows = out;
	}
	const cap = Math.max(1, Math.floor(maxRows));
	if (rows.length > cap) {
		// Rows to hide so the fold row plus the rest fit in `cap`.
		let toFold = rows.length - cap + 1;
		const fold = new Set<number>();
		// Pass 1: oldest successes. Pass 2 (only if still too many): oldest of any status.
		for (const wantOk of [true, false]) {
			for (let i = 0; i < rows.length && toFold > 0; i++) {
				if (fold.has(i) || (wantOk && rows[i].status !== "ok")) continue;
				fold.add(i);
				toFold--;
			}
		}
		const folded = rows.filter((_, i) => fold.has(i));
		const count = (s: TrailStatus) =>
			folded.filter((r) => r.status === s).reduce((n, r) => n + r.count, 0);
		const failed = count("fail");
		const blocked = count("blocked");
		const summary: ToolTrailRow = {
			tool: "",
			summary: "",
			status: failed > 0 ? "fail" : blocked > 0 ? "blocked" : "ok",
			count: folded.reduce((n, r) => n + r.count, 0),
			folded: true,
			all: fold.size === rows.length,
		};
		if (failed > 0) summary.failed = failed;
		if (blocked > 0) summary.blocked = blocked;
		rows = [summary, ...rows.filter((_, i) => !fold.has(i))];
	}
	return rows;
}

const ICONS: Record<TrailStatus, string> = { ok: "✓", fail: "✗", blocked: "⊘" };

/**
 * Format a row to fit `width` columns including the icon and one space. The
 * summary is truncated first so the reason, which carries the fact that
 * matters, survives.
 */
export function formatTrailRow(row: ToolTrailRow, width: number): { icon: string; text: string } {
	const icon = ICONS[row.status];
	const budget = Math.max(1, width - icon.length - 1);
	if (row.folded) {
		const parts = [`${row.count} ${row.all ? "calls" : "earlier calls"}`];
		if (row.failed) parts.push(`${row.failed} failed`);
		if (row.blocked) parts.push(`${row.blocked} blocked`);
		return { icon, text: clip(parts.join(", "), budget) };
	}
	const head = row.count > 1 ? `${row.tool} ×${row.count}` : row.tool;
	const tail = row.reason ? ` (${row.reason})` : "";
	let summary = row.count > 1 ? (row.summary ? `(${row.summary}…)` : "") : row.summary;
	if (!summary) return { icon, text: clip(`${head}${tail}`, budget) };
	const room = budget - head.length - 1 - tail.length;
	if (room < 4) return { icon, text: clip(`${head}${tail}`, budget) };
	if (summary.length > room) summary = `${summary.slice(0, room - 1)}…`;
	return { icon, text: `${head} ${summary}${tail}` };
}

function clip(s: string, width: number): string {
	return s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`;
}

/** Minimal message shape buildChatItems needs; app.tsx's Message satisfies it. */
export interface TrailMessage {
	id: string;
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	timestamp: Date;
	toolTrail?: ToolTrailEntry;
}

export interface ChatItem<M extends TrailMessage> {
	/** The message to render. role "tool" means a standalone trail with no reply yet. */
	message: M;
	trail: ToolTrailEntry[];
}

/**
 * Group chat messages into render items. Tool messages carrying a toolTrail
 * entry attach to the next assistant reply. Calls with no reply yet (a turn
 * still running, or one that ended in an error) render as a standalone trail
 * where the reply would be. Every other tool message stays out of chat.
 */
export function buildChatItems<M extends TrailMessage>(messages: M[]): ChatItem<M>[] {
	const items: ChatItem<M>[] = [];
	let pending: ToolTrailEntry[] = [];
	let pendingFirst: M | null = null;
	const flush = () => {
		if (pending.length > 0 && pendingFirst) {
			items.push({
				message: { ...pendingFirst, id: `trail-${pendingFirst.id}`, role: "tool", content: "" },
				trail: pending,
			});
		}
		pending = [];
		pendingFirst = null;
	};
	for (const m of messages) {
		if (m.role === "tool") {
			if (m.toolTrail) {
				if (!pendingFirst) pendingFirst = m;
				pending.push(m.toolTrail);
			}
			continue;
		}
		if (m.role === "assistant") {
			items.push({ message: m, trail: pending });
			pending = [];
			pendingFirst = null;
			continue;
		}
		if (m.role === "user") flush();
		items.push({ message: m, trail: [] });
	}
	flush();
	return items;
}
