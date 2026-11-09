/**
 * What this session changed on disk: the inline diff after an edit and /diff.
 *
 * Local and read-only. The file is read before write_file / edit_file runs and
 * again after it lands, so the diff is the bytes that changed, not what the
 * model said it changed. Nothing leaves the machine, nothing is written.
 *
 * Pure text out, so the chat's row budget can count it before it is drawn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { safePath } from "../../../../packages/eight/tools.js";
import { cleanOutput } from "./bang-command.js";
import { sanitizeForTerminal } from "./telegram-tab.js";

/** Tools whose success means a file on disk may have changed. */
export const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file"]);

/** Context lines kept around each change. */
const CONTEXT = 2;
/** The middle of a diff past this many cells (rows x rows) is not diffed line by line. */
const MAX_CELLS = 4_000_000;
/** An inline diff shows at most this many lines, then says how many are left. */
export const INLINE_MAX_LINES = 40;
/** /diff shows at most this many lines in all. */
export const REPORT_MAX_LINES = 200;
/** Files past this size are not read for a diff. */
const MAX_BYTES = 1_000_000;

type Op = { t: " " | "+" | "-"; line: string };

function lineOps(a: string[], b: string[]): Op[] | null {
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail] === b[b.length - 1 - tail]
	)
		tail++;
	const am = a.slice(head, a.length - tail);
	const bm = b.slice(head, b.length - tail);
	if (am.length * bm.length > MAX_CELLS) return null;
	const w = bm.length + 1;
	const dp = new Uint32Array((am.length + 1) * w);
	for (let i = am.length - 1; i >= 0; i--)
		for (let j = bm.length - 1; j >= 0; j--)
			dp[i * w + j] =
				am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
	const ops: Op[] = a.slice(0, head).map((line) => ({ t: " ", line }));
	let i = 0;
	let j = 0;
	while (i < am.length || j < bm.length) {
		if (i < am.length && j < bm.length && am[i] === bm[j]) {
			ops.push({ t: " ", line: am[i] });
			i++;
			j++;
		} else if (j >= bm.length || (i < am.length && dp[(i + 1) * w + j] >= dp[i * w + j + 1])) {
			ops.push({ t: "-", line: am[i++] });
		} else {
			ops.push({ t: "+", line: bm[j++] });
		}
	}
	for (const line of a.slice(a.length - tail)) ops.push({ t: " ", line });
	return ops;
}

function splitLines(s: string): string[] {
	if (s === "") return [];
	const lines = s.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Added and removed line counts. */
export interface DiffStat {
	added: number;
	removed: number;
}

/**
 * A unified-style diff body (hunk headers, ' ', '+', '-' rows) and its counts.
 * `before` null means the file did not exist. Empty body when nothing changed.
 */
export function diffBody(
	before: string | null,
	after: string | null,
): { body: string[]; stat: DiffStat } {
	const a = splitLines(before ?? "");
	const b = splitLines(after ?? "");
	const ops = lineOps(a, b);
	if (!ops) {
		return {
			body: [`  (too large to diff line by line: ${a.length} lines became ${b.length})`],
			stat: { added: Math.max(0, b.length - a.length), removed: Math.max(0, a.length - b.length) },
		};
	}
	const stat = {
		added: ops.filter((o) => o.t === "+").length,
		removed: ops.filter((o) => o.t === "-").length,
	};
	const keep = new Array<boolean>(ops.length).fill(false);
	ops.forEach((o, idx) => {
		if (o.t === " ") return;
		for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(ops.length - 1, idx + CONTEXT); k++)
			keep[k] = true;
	});
	const body: string[] = [];
	let ai = 1;
	let bi = 1;
	let k = 0;
	while (k < ops.length) {
		if (!keep[k]) {
			if (ops[k].t !== "+") ai++;
			if (ops[k].t !== "-") bi++;
			k++;
			continue;
		}
		let end = k;
		while (end < ops.length && keep[end]) end++;
		const run = ops.slice(k, end);
		const aLen = run.filter((o) => o.t !== "+").length;
		const bLen = run.filter((o) => o.t !== "-").length;
		body.push(`@@ -${ai},${aLen} +${bi},${bLen} @@`);
		for (const o of run) body.push(`${o.t}${o.line}`);
		ai += aLen;
		bi += bLen;
		k = end;
	}
	return { body, stat };
}

/**
 * Everything drawn passes through here. File bytes are not ours: a .env value
 * must not reach the screen (pilot recordings are sent on), and an ESC or OSC
 * sequence in a file must not drive the terminal. Redact secrets, drop every
 * escape and control byte, then the C1 and format characters cleanOutput keeps.
 */
export function safeForScreen(text: string): string {
	return sanitizeForTerminal(cleanOutput(text).text);
}

function readOrNull(abs: string): string | null {
	try {
		const st = fs.statSync(abs);
		if (!st.isFile() || st.size > MAX_BYTES) return null;
		return fs.readFileSync(abs, "utf-8");
	} catch {
		return null;
	}
}

function clip(lines: string[], max: number): string[] {
	if (lines.length <= max) return lines;
	return [...lines.slice(0, max), `  ... ${lines.length - max} more lines (/diff shows the session's changes)`];
}

/** The tab-local record of file changes: first content seen and latest content per path. */
export class SessionChanges {
	private pending = new Map<string, { abs: string; before: string | null }>();
	private files = new Map<string, { before: string | null; after: string | null }>();

	constructor(private readonly cwd: () => string) {}

	/** Call at tool start. Ignores tools that do not write files. */
	begin(callId: string, tool: string, args: Record<string, unknown> | undefined): void {
		if (!FILE_WRITE_TOOLS.has(tool)) return;
		const p = args?.path;
		if (typeof p !== "string" || !p) return;
		// The model's path, read before the tool's own check has run: apply the
		// same check first, and read nothing the tool would refuse (outside the
		// workspace, a symlink out of it, a credential file).
		let abs: string;
		try {
			abs = safePath(p, this.cwd(), "write");
		} catch {
			return;
		}
		this.pending.set(callId, { abs, before: readOrNull(abs) });
	}

	/**
	 * Call at tool end. Returns the inline diff text for this one call, or null
	 * when the call failed, was not a file write, or changed nothing.
	 */
	finish(callId: string, success: boolean): string | null {
		const p = this.pending.get(callId);
		this.pending.delete(callId);
		if (!p || !success) return null;
		const after = readOrNull(p.abs);
		if (after === p.before) return null;
		const prev = this.files.get(p.abs);
		this.files.set(p.abs, { before: prev ? prev.before : p.before, after });
		const { body, stat } = diffBody(p.before, after);
		if (body.length === 0) return null;
		return safeForScreen(
			[this.header(p.abs, stat, p.before === null), ...clip(body, INLINE_MAX_LINES)].join("\n"),
		);
	}

	private header(abs: string, stat: DiffStat, created: boolean): string {
		const rel = path.relative(this.cwd(), abs) || abs;
		const shown = rel.startsWith("..") ? abs : rel;
		return `diff ${shown}${created ? " (new file)" : ""}  +${stat.added} -${stat.removed}`;
	}

	/** /diff: every file the session changed, first content seen against what is on disk now. */
	report(): string {
		const parts: string[] = [];
		let files = 0;
		for (const [abs, rec] of this.files) {
			const now = readOrNull(abs);
			if (now === rec.before) continue;
			const { body, stat } = diffBody(rec.before, now);
			if (body.length === 0) continue;
			files++;
			parts.push(this.header(abs, stat, rec.before === null), ...body);
		}
		if (files === 0) return "No file changes in this session yet.";
		return safeForScreen(clip(parts, REPORT_MAX_LINES).join("\n"));
	}
}

/** True for a message body made by SessionChanges, so the chat can colour its rows. */
export function isDiffText(content: string): boolean {
	return content.startsWith("diff ");
}
