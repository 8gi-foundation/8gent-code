/**
 * The real delegation path for pilot l4-spawn-parallel-m5: an Orchestrator's
 * executor spawns sub-agents through the agent pool, and each sub-agent (a
 * stubbed model, routed by a keyword in its task) behaves like the pilot's
 * llama3.2:3b agents did:
 *
 *   QUIT   ends at once with prose and no tool call (changes nothing)
 *   SLOW   thinks for 4 s, then fixes src/clamp.ts with edit_file
 *   REGEX  writes the wordCount fix as a bare JSON call with an unescaped \s,
 *          the exact shape that was dropped in run 2026-09-30_070309
 *
 * Prints one @@PROBE@@ JSON line. Run in a child process with HOME in a temp
 * dir and EIGHT_CHECK_AGENT_WAIT_MS set.
 *
 *   bun delegation-probe.ts <workdir>
 */
export {};

const [workdir] = process.argv.slice(2);

const fence = (name: string, args: Record<string, unknown>) =>
	["```tool_call", JSON.stringify({ name, arguments: args }), "```"].join("\n");

// Verbatim shape of the pilot sub-agent's final reply (session ilq4st).
const REGEX_REPLY =
	'{"name": "write_file", "arguments": {"path": "src/wordcount.ts", "content": "export function wordCount(text: string): number {\\n  return text.trim().split(/\\s+/).filter(Boolean).length;\\n}"}}';

globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
	const url = String(
		typeof input === "string" ? input : ((input as { url?: string })?.url ?? input),
	);
	if (url.endsWith("/api/tags"))
		return Response.json({ models: [{ name: "probe:1b", model: "probe:1b" }] });
	if (url.includes("/chat/completions")) {
		const body = JSON.parse(init?.body ?? "{}") as {
			messages?: Array<{ role: string; content: string }>;
		};
		const all = (body.messages ?? []).map((m) => String(m.content)).join("\n");
		const last = String(body.messages?.at(-1)?.content ?? "");
		const followUp = last.includes("returned:");
		let content = "DONE.";
		if (!followUp && all.includes("QUIT")) content = "Finished, with a flourish.";
		else if (!followUp && all.includes("SLOW")) {
			await Bun.sleep(4000);
			content = fence("edit_file", {
				path: "src/clamp.ts",
				oldText: "Math.max(max, Math.min(n, min))",
				newText: "Math.min(Math.max(n, min), max)",
			});
		} else if (!followUp && all.includes("REGEX")) content = REGEX_REPLY;
		return Response.json({
			choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
		});
	}
	return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

const { ToolExecutor } = await import("../../tools");
const { getAgentPool } = await import("../../../orchestration");
const orchestrator = new ToolExecutor(workdir);
const pool = getAgentPool();

const spawn = async (task: string, allowedPaths?: string[]) =>
	JSON.parse(
		await orchestrator.execute("spawn_agent", {
			runtime: "8gent",
			model: "probe:1b",
			task,
			...(allowedPaths ? { allowedPaths } : {}),
		}),
	) as Record<string, unknown> & { agentId: string };
const check = async (id: string) =>
	JSON.parse(await orchestrator.execute("check_agent", { agentId: id }));
const settle = async (id: string) => {
	for (let i = 0; i < 600; i++) {
		const a = pool.getAgent(id);
		if (a && (a.status === "completed" || a.status === "failed")) return;
		await Bun.sleep(50);
	}
};

// Two siblings in parallel; the quitter ends while the slow one still runs.
const slow = await spawn("SLOW: fix src/clamp.ts. You may edit ONLY src/clamp.ts.", [
	"src/clamp.ts",
]);
const quit = await spawn("QUIT: fix src/wordcount.ts. You may edit ONLY src/wordcount.ts.", [
	"src/wordcount.ts",
]);
const t0 = Date.now();
const slowWhileRunning = await check(slow.agentId);
const slowCheckMs = Date.now() - t0;
const quitStatusAtSlowCheck = pool.getAgent(quit.agentId)?.status;
const quitCheck = await check(quit.agentId);

// The Orchestrator re-spawns the quitter's job; this agent writes the pilot's \s reply.
const regex = await spawn("REGEX: fix src/wordcount.ts. You may edit ONLY src/wordcount.ts.", [
	"src/wordcount.ts",
]);
await settle(regex.agentId);
const regexCheck = await check(regex.agentId);
await settle(slow.agentId);
const slowDone = await check(slow.agentId);

// A spawn with no scope is told so.
const unscoped = await spawn("QUIT: say hello.");
await settle(unscoped.agentId);

const fs = await import("node:fs");
const path = await import("node:path");
process.stdout.write(
	`\n@@PROBE@@${JSON.stringify({
		slowCheckMs,
		quitStatusAtSlowCheck,
		slowWhileRunning,
		quitCheck,
		regexCheck,
		slowDone,
		scopedSpawn: slow,
		unscopedSpawn: unscoped,
		wordcount: fs.readFileSync(path.join(workdir, "src/wordcount.ts"), "utf-8"),
		clamp: fs.readFileSync(path.join(workdir, "src/clamp.ts"), "utf-8"),
	})}\n`,
);
process.exit(0);
