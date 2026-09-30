/**
 * The real spawn path for #3101: an Orchestrator's executor calls spawn_agent
 * with allowedPaths, the agent pool builds the sub-agent, and the sub-agent
 * (a stubbed model) does what the pilot's llama3.2:3b did: rewrites README.md,
 * prepends to the other agent's file, and fixes its own. Prints the files and
 * the sub-agent's tool results. Run in a child process with HOME in a temp dir.
 *
 *   bun scoped-spawn-probe.ts <workdir> <allowedPaths-json|->
 */
export {};

const [workdir, scopeArg] = process.argv.slice(2);
const allowedPaths = scopeArg === "-" ? undefined : (JSON.parse(scopeArg) as string[]);

const fence = (name: string, args: Record<string, unknown>) =>
	["```tool_call", JSON.stringify({ name, arguments: args }), "```"].join("\n");
// With a scope the README rewrite is write_file, exactly as in the pilot (it
// is refused, so nothing is written). Without one it is edit_file, because a
// successful write_file opens the file on macOS.
const SUB_AGENT_TURN = [
	allowedPaths
		? fence("write_file", { path: "README.md", content: "# rewritten by the clamp agent\n" })
		: fence("edit_file", { path: "README.md", oldText: "# twofix", newText: "# rewritten by the clamp agent" }),
	fence("edit_file", { path: "src/wordcount.ts", oldText: "export", newText: "// clamp agent was here\nexport" }),
	fence("edit_file", {
		path: "src/clamp.ts",
		oldText: "Math.max(max, Math.min(n, min))",
		newText: "Math.min(Math.max(n, min), max)",
	}),
].join("\n");

const results: string[] = [];
let calls = 0;
globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
	const url = String(typeof input === "string" ? input : (input as { url?: string })?.url ?? input);
	if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "probe:1b", model: "probe:1b" }] });
	if (url.includes("/chat/completions")) {
		const body = JSON.parse(init?.body ?? "{}") as { messages?: Array<{ role: string; content: string }> };
		const last = body.messages?.at(-1)?.content ?? "";
		if (last.includes("returned:")) results.push(last);
		calls++;
		const content = last.includes("returned:") ? "DONE: fixed src/clamp.ts." : SUB_AGENT_TURN;
		return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
	}
	return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

const { ToolExecutor } = await import("../../tools");
const { getAgentPool } = await import("../../../orchestration");
const orchestrator = new ToolExecutor(workdir);
const spawned = JSON.parse(
	await orchestrator.execute("spawn_agent", {
		runtime: "8gent",
		model: "probe:1b",
		task: "Fix src/clamp.ts. Edit only src/clamp.ts.",
		...(allowedPaths ? { allowedPaths } : {}),
	}),
) as { agentId: string };
const pool = getAgentPool();
for (let i = 0; i < 600; i++) {
	const a = pool.getAgent(spawned.agentId);
	if (a && (a.status === "completed" || a.status === "failed")) break;
	await Bun.sleep(50);
}
const fs = await import("node:fs");
const path = await import("node:path");
const file = (rel: string) => fs.readFileSync(path.join(workdir, rel), "utf-8");
process.stdout.write(
	`\n@@PROBE@@${JSON.stringify({
		status: pool.getAgent(spawned.agentId)?.status,
		calls,
		results,
		readme: file("README.md"),
		wordcount: file("src/wordcount.ts"),
		clamp: file("src/clamp.ts"),
	})}\n`,
);
process.exit(0);
