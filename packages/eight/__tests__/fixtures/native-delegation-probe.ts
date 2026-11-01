/**
 * The native (AI SDK) spawn_agent / check_agent tools, end to end through the
 * agent pool with a stubbed model: a scoped sub-agent that ends at once with
 * prose and no tool call. Prints one @@PROBE@@ JSON line.
 *
 *   bun native-delegation-probe.ts <workdir>
 */
export {};

const [workdir] = process.argv.slice(2);

globalThis.fetch = (async (input: unknown) => {
	const url = String(
		typeof input === "string" ? input : ((input as { url?: string })?.url ?? input),
	);
	if (url.endsWith("/api/tags"))
		return Response.json({ models: [{ name: "probe:1b", model: "probe:1b" }] });
	if (url.includes("/chat/completions")) {
		return Response.json({
			choices: [
				{
					message: { role: "assistant", content: "Finished, with a flourish." },
					finish_reason: "stop",
				},
			],
		});
	}
	return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

const { agentTools, setToolContext } = await import("../../../ai/tools");
const { getAgentPool } = await import("../../../orchestration");
setToolContext({ workingDirectory: workdir });
const opts = { toolCallId: "t", messages: [] };
const spawned = JSON.parse(
	String(
		await agentTools.spawn_agent.execute?.(
			{
				task: "Fix src/wordcount.ts.",
				runtime: "8gent",
				model: "probe:1b",
				allowedPaths: ["src/wordcount.ts"],
			},
			opts,
		),
	),
) as Record<string, unknown> & { agentId: string };
const pool = getAgentPool();
for (let i = 0; i < 600; i++) {
	const a = pool.getAgent(spawned.agentId);
	if (a && (a.status === "completed" || a.status === "failed")) break;
	await Bun.sleep(50);
}
const checked = JSON.parse(
	String(await agentTools.check_agent.execute?.({ agentId: spawned.agentId }, opts)),
);
process.stdout.write(
	`\n@@PROBE@@${JSON.stringify({ spawned, checked, poolScope: pool.getAgent(spawned.agentId)?.config.allowedPaths })}\n`,
);
process.exit(0);
