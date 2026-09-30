/**
 * One real Agent turn with a stubbed model: records every request the model
 * would receive and prints them as one @@PROBE@@ JSON line (#3146).
 *
 *   HOME=<tmp> bun prompt-capture-probe.ts <workdir> <runtime> [role] [scope]
 */
export {};

const [workdir, runtime, role, scope] = process.argv.slice(2);
const requests: unknown[] = [];
let turns = 0;

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
	const url = String(
		typeof input === "string" ? input : ((input as { url?: string })?.url ?? input),
	);
	if (url.endsWith("/api/tags"))
		return Response.json({ models: [{ name: "probe:1b", model: "probe:1b" }] });
	if (url.includes("/chat/completions")) {
		const body = JSON.parse(String(init?.body ?? "{}"));
		requests.push(body);
		// A one-token capability probe ("ping") is not a turn.
		if (body.max_tokens !== 1) turns++;
		// Prose with no tool call and no DONE marker, then DONE: this walks the
		// text-tool loop through its completion check the way a real reply can.
		const content = turns === 1 ? "I looked at it and it is fine." : "DONE: nothing to change.";
		return Response.json({
			id: "c",
			object: "chat.completion",
			created: 0,
			model: "probe:1b",
			choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		});
	}
	return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

const { Agent } = await import("../../agent");
const agent = new Agent({
	model: "probe:1b",
	runtime,
	workingDirectory: workdir,
	...(role ? { role } : {}),
	...(scope ? { agentScope: scope } : {}),
} as ConstructorParameters<typeof Agent>[0]);
const system = (agent as unknown as { messageHistory: { role: string; content: string }[] })
	.messageHistory.filter((m) => m.role === "system")
	.map((m) => m.content);
try {
	await agent.chat("Check src/index.ts and tell me if it needs a change.");
} catch (err) {
	process.stderr.write(`chat threw: ${String(err)}\n`);
}
process.stdout.write(`\n@@PROBE@@${JSON.stringify({ system, requests })}\n`);
process.exit(0);
