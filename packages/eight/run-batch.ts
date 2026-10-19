/**
 * run_batch: an "action chunk" for tool calls (#3502). One model turn plans N tool calls,
 * the harness runs them, the model re-plans only on a surprising result.
 *
 * Offered only with EIGHT_RUN_BATCH=1 exactly. Every item goes back through
 * ToolExecutor.execute, so permissions, the policy gate and secret scrubbing apply per item.
 */

import { isErrorToolResult } from "./honesty";

export const RUN_BATCH_MAX_ITEMS = 12;
const ITEM_CHARS = 1500;
const TOTAL_CHARS = 12000;

/** Read-only tools that never exec a helper: safe to run side by side. git_status and git_diff are out (fsmonitor, external diff and textconv can exec). */
export const RUN_BATCH_READ_ONLY = new Set([
	"read_file",
	"list_files",
	"get_outline",
	"get_symbol",
	"search_symbols",
	"locate",
	"git_log",
]);

export function runBatchOn(): boolean {
	return process.env.EIGHT_RUN_BATCH === "1";
}

export const RUN_BATCH_TOOL_DEF = {
	type: "function",
	function: {
		name: "run_batch",
		description:
			"Runs a list of up to 12 tool calls in order, each item {tool, args}, and returns one short result per item. Use it when you already know the next several steps, such as reading three files or reading then editing then testing. Read-only items (read_file, list_files, get_outline, get_symbol, search_symbols, locate, git_log) run in parallel; any other item runs in order, and a failure cancels every later item that is not read-only. Do not nest run_batch.",
		parameters: {
			type: "object",
			properties: {
				items: {
					type: "array",
					description: "Tool calls to run, in order",
					items: {
						type: "object",
						properties: {
							tool: { type: "string", description: "Tool name, e.g. read_file" },
							args: { type: "object", description: "That tool's arguments" },
						},
						required: ["tool"],
					},
				},
			},
			required: ["items"],
		},
	},
};

type Item = { tool: string; args: Record<string, unknown> };
type Exec = (tool: string, args: Record<string, unknown>) => Promise<string>;

// isErrorToolResult misses hyphenated markers such as [MAKER-CHECKER BLOCKED] and hook refusals.
const failed = (s: string) =>
	isErrorToolResult(s) ||
	/^(\[[A-Z0-9_ -]*(BLOCKED|DENIED|ERROR)\]|Hook blocked)/.test(s.trimStart());

export async function runBatch(rawItems: unknown, exec: Exec): Promise<string> {
	if (!Array.isArray(rawItems) || rawItems.length === 0)
		return "Error: run_batch needs items, a non-empty list of {tool, args}. Nothing was run.";
	if (rawItems.length > RUN_BATCH_MAX_ITEMS)
		return `Error: run_batch takes at most ${RUN_BATCH_MAX_ITEMS} items, got ${rawItems.length}. Nothing was run.`;
	const items: Item[] = [];
	for (const [i, r] of rawItems.entries()) {
		const it = r as { tool?: unknown; args?: unknown };
		if (typeof it?.tool !== "string" || !it.tool)
			return `Error: run_batch item ${i + 1} has no tool name. Nothing was run.`;
		if (
			it.args !== undefined &&
			(typeof it.args !== "object" || it.args === null || Array.isArray(it.args))
		)
			return `Error: run_batch item ${i + 1} args must be an object. Nothing was run.`;
		if (it.tool.trim().toLowerCase() === "run_batch")
			return "Error: run_batch cannot contain run_batch. Nothing was run.";
		items.push({ tool: it.tool, args: (it.args as Record<string, unknown>) ?? {} });
	}

	type Row = { status: "ok" | "FAILED" | "cancelled"; text: string };
	const rows: Row[] = new Array(items.length);
	const run = async (n: number): Promise<boolean> => {
		let text: string;
		try {
			text = await exec(items[n].tool, items[n].args);
		} catch (e) {
			text = `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
		const bad = failed(text);
		rows[n] = { status: bad ? "FAILED" : "ok", text };
		return !bad;
	};

	let cancelWrites = false;
	let i = 0;
	while (i < items.length) {
		if (RUN_BATCH_READ_ONLY.has(items[i].tool)) {
			let j = i;
			while (j < items.length && RUN_BATCH_READ_ONLY.has(items[j].tool)) j++;
			const oks = await Promise.all(Array.from({ length: j - i }, (_, k) => run(i + k)));
			if (oks.includes(false)) cancelWrites = true;
			i = j;
		} else if (cancelWrites) {
			rows[i] = { status: "cancelled", text: "" };
			i++;
		} else {
			if (!(await run(i))) cancelWrites = true;
			i++;
		}
	}

	// Header lines are never dropped: they carry FAILED and cancelled. Only bodies are budgeted.
	const heads = rows.map((r, n) => `${n + 1}. ${items[n].tool} ${r.status}`);
	const spare = TOTAL_CHARS - heads.reduce((t, h) => t + h.length + 1, 0);
	const each = Math.min(ITEM_CHARS, Math.max(0, Math.floor(spare / rows.length)));
	const body = rows.map((r, n) => {
		if (r.status === "cancelled") return heads[n];
		if (r.text.length <= each) return `${heads[n]}\n${r.text}`;
		const cut = `[cut, ${r.text.length - each} more chars: call ${items[n].tool} alone for all of it]`;
		return each > 0 ? `${heads[n]}\n${r.text.slice(0, each)}\n${cut}` : `${heads[n]}\n${cut}`;
	});
	const idx = (st: Row["status"]) => rows.flatMap((r, n) => (r.status === st ? [n + 1] : []));
	const bad = idx("FAILED");
	const skipped = idx("cancelled");
	const summary = `run_batch: ${items.length} items, ${bad.length} failed${bad.length ? ` (${bad.join(", ")})` : ""}, ${skipped.length} cancelled`;
	return `${summary}\n${body.join("\n")}`;
}
