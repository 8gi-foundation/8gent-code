/**
 * batch (#69): up to 8 independent read-only tool calls in one model turn, one
 * combined result with a labelled section per call.
 *
 * Every call takes the owner's item gate (mode tool set, PreToolUse hooks,
 * beforeTool/afterTool hooks, privacy gate, session row), then goes back through
 * ToolExecutor.execute, so permission mode, the ToolG8 gate, the read boundary and
 * secret scrubbing apply exactly as when the tool is called alone. The allowlist
 * below only decides what may be named at all.
 */

export const BATCH_MAX_CALLS = 8;

/** Read-only tools that run no helper process. git_status and git_diff are out: fsmonitor and textconv can exec. */
export const BATCH_READ_ONLY = new Set([
	"read_file",
	"search_files",
	"list_files",
	"get_outline",
	"get_symbol",
	"search_symbols",
	"locate",
	"git_log",
]);

export const BATCH_TOOL_DEF = {
	type: "function",
	function: {
		name: "batch",
		description: `Runs up to ${BATCH_MAX_CALLS} independent read-only tool calls at once and returns one labelled section per call. Allowed: ${[...BATCH_READ_ONLY].join(", ")}. Anything that writes, runs a command or uses the network is refused and nothing in the batch runs.`,
		parameters: {
			type: "object",
			properties: {
				calls: {
					type: "array",
					description: "The reads to run, each {tool, args}",
					items: {
						type: "object",
						properties: {
							tool: { type: "string", description: "A read-only tool name, e.g. read_file" },
							args: { type: "object", description: "That tool's arguments" },
						},
						required: ["tool"],
					},
				},
			},
			required: ["calls"],
		},
	},
};

type Exec = (tool: string, args: Record<string, unknown>) => Promise<string>;

export async function runReadBatch(rawCalls: unknown, exec: Exec): Promise<string> {
	if (!Array.isArray(rawCalls) || rawCalls.length === 0)
		return "Error: batch needs calls, a non-empty list of {tool, args}. Nothing was run.";
	if (rawCalls.length > BATCH_MAX_CALLS)
		return `Error: batch takes at most ${BATCH_MAX_CALLS} calls, got ${rawCalls.length}. Nothing was run.`;
	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	for (const [i, r] of rawCalls.entries()) {
		const c = r as { tool?: unknown; args?: unknown };
		if (typeof c?.tool !== "string" || !c.tool)
			return `Error: batch call ${i + 1} has no tool name. Nothing was run.`;
		if (!BATCH_READ_ONLY.has(c.tool))
			return `Error: batch only runs read-only tools, and ${c.tool} is not one (call ${i + 1}). Allowed: ${[...BATCH_READ_ONLY].join(", ")}. Nothing was run.`;
		if (c.args !== undefined && (typeof c.args !== "object" || c.args === null || Array.isArray(c.args)))
			return `Error: batch call ${i + 1} args must be an object. Nothing was run.`;
		calls.push({ tool: c.tool, args: (c.args as Record<string, unknown>) ?? {} });
	}
	const texts = await Promise.all(
		calls.map(async (c) => {
			try {
				return await exec(c.tool, c.args);
			} catch (e) {
				return `Error: ${e instanceof Error ? e.message : String(e)}`;
			}
		}),
	);
	return texts.map((t, n) => `[${n + 1}/${calls.length} ${calls[n].tool}]\n${t}`).join("\n\n");
}
