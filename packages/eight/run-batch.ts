/**
 * run_batch: an "action chunk" for tool calls (#3502). One model turn plans N tool calls,
 * the harness runs them, the model re-plans only on a surprising result.
 *
 * Offered only with EIGHT_RUN_BATCH=1 exactly. Every item goes back through
 * ToolExecutor.execute, so permissions, the policy gate and secret scrubbing apply per item.
 */

export const RUN_BATCH_MAX_ITEMS = 12;
const ITEM_CHARS = 1500;
const TOTAL_CHARS = 12000;

/** Read-only tools: no writes, no shell, safe to run side by side. */
export const RUN_BATCH_READ_ONLY = new Set([
	"read_file",
	"list_files",
	"get_outline",
	"get_symbol",
	"search_symbols",
	"locate",
	"git_status",
	"git_diff",
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
			"Runs a list of up to 12 tool calls in order, each item {tool, args}, and returns one short result per item. Use it when you already know the next several steps, such as reading three files or reading then editing then testing. Read-only items (read_file, list_files, get_outline, get_symbol, search_symbols, locate, git_status, git_diff, git_log) run in parallel; any other item runs in order, and a failure cancels every later item that is not read-only. Do not nest run_batch.",
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

const failed = (s: string) => /^(Error|\[BLOCKED\])/.test(s.trimStart());

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
		if (it.tool === "run_batch")
			return "Error: run_batch cannot contain run_batch. Nothing was run.";
		items.push({ tool: it.tool, args: (it.args as Record<string, unknown>) ?? {} });
	}

	const out: string[] = new Array(items.length);
	const run = async (n: number): Promise<boolean> => {
		let text: string;
		try {
			text = await exec(items[n].tool, items[n].args);
		} catch (e) {
			text = `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
		const bad = failed(text);
		const body =
			text.length > ITEM_CHARS
				? `${text.slice(0, ITEM_CHARS)}\n[cut, ${text.length - ITEM_CHARS} more chars: call ${items[n].tool} alone for all of it]`
				: text;
		out[n] = `${n + 1}. ${items[n].tool} ${bad ? "FAILED" : "ok"}\n${body}`;
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
			out[i] = `${i + 1}. ${items[i].tool} cancelled (an earlier item failed)`;
			i++;
		} else {
			if (!(await run(i))) cancelWrites = true;
			i++;
		}
	}

	let text = out.join("\n");
	if (text.length > TOTAL_CHARS)
		text = `${text.slice(0, TOTAL_CHARS)}\n[run_batch result cut at ${TOTAL_CHARS} chars]`;
	return `run_batch: ${items.length} items\n${text}`;
}
