/**
 * "Changed" is not "fixed" (#3126), end to end through the real ToolExecutor
 * and agent pool with a stubbed model. Each sub-agent is routed by a keyword in
 * its task:
 *
 *   SAME    rewrites src/wordcount.ts with the SAME bug (pilot run 083409)
 *   BUGGY   rewrites src/clamp.ts with a different bug
 *   NOTEST  writes src/extra.ts, which has no sibling test
 *   HANG    writes src/hang.ts, whose sibling test outlasts the timeout
 *   GOOD    writes the correct src/clamp.ts fix
 *
 * With "deny", the permission policy denies `bun test *` first and only GOOD
 * runs: its verify run must be blocked by the same gate run_command obeys.
 *
 * Prints one @@PROBE@@ JSON line. Run with HOME in a temp dir.
 *   bun fixed-probe.ts <workdir> [deny]
 */
export {};

const [workdir, mode] = process.argv.slice(2);
const fs = await import("node:fs");
const path = await import("node:path");
const read = (rel: string) => fs.readFileSync(path.join(workdir, rel), "utf-8");

const fence = (name: string, args: Record<string, unknown>) =>
	["```tool_call", JSON.stringify({ name, arguments: args }), "```"].join("\n");
const SAME_BUG = read("src/wordcount.ts");

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
		const followUp = String(body.messages?.at(-1)?.content ?? "").includes("returned:");
		let content = "DONE: fixed it.";
		if (!followUp && all.includes("SAME"))
			content = fence("write_file", { path: "src/wordcount.ts", content: SAME_BUG });
		else if (!followUp && all.includes("BUGGY"))
			content = fence("write_file", {
				path: "src/clamp.ts",
				content:
					"export function clamp(n: number, min: number, max: number): number {\n\treturn Math.min(n, min);\n}\n",
			});
		else if (!followUp && all.includes("NOTEST"))
			content = fence("write_file", { path: "src/extra.ts", content: "export const extra = 2;\n" });
		else if (!followUp && all.includes("GOOD"))
			content = fence("write_file", {
				path: "src/clamp.ts",
				content:
					"export function clamp(n: number, min: number, max: number): number {\n\treturn Math.min(Math.max(n, min), max);\n}\n",
			});
		else if (!followUp && all.includes("HANG"))
			content = fence("write_file", { path: "src/hang.ts", content: "export const hang = 2;\n" });
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
const spawn = async (task: string, allowedPaths: string[]) =>
	JSON.parse(
		await orchestrator.execute("spawn_agent", {
			runtime: "8gent",
			model: "probe:1b",
			task,
			allowedPaths,
		}),
	) as { agentId: string };
const settle = async (id: string) => {
	for (let i = 0; i < 1200; i++) {
		const a = pool.getAgent(id);
		if (a && (a.status === "completed" || a.status === "failed")) return;
		await Bun.sleep(50);
	}
};
const check = async (id: string) =>
	JSON.parse(await orchestrator.execute("check_agent", { agentId: id }));

if (mode === "deny") {
	const { getPermissionManager } = await import("../../../permissions");
	getPermissionManager().denyPattern("bun test *");
}
const ids: Record<string, string> =
	mode === "deny"
		? { good: (await spawn("GOOD: fix src/clamp.ts.", ["src/clamp.ts"])).agentId }
		: {
				same: (await spawn("SAME: fix src/wordcount.ts.", ["src/wordcount.ts"])).agentId,
				buggy: (await spawn("BUGGY: fix src/clamp.ts.", ["src/clamp.ts"])).agentId,
				notest: (await spawn("NOTEST: write src/extra.ts.", ["src/extra.ts"])).agentId,
				hang: (await spawn("HANG: write src/hang.ts.", ["src/hang.ts"])).agentId,
			};
for (const id of Object.values(ids)) await settle(id);
const out: Record<string, unknown> = {};
for (const [k, id] of Object.entries(ids)) out[k] = await check(id);
process.stdout.write(`\n@@PROBE@@${JSON.stringify(out)}\n`);
process.exit(0);
