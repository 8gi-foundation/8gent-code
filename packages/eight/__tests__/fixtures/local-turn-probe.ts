/**
 * Runs ONE real Agent turn on the local text-tool path with the network
 * stubbed, and prints what the model would have been sent: the tool names
 * declared on the chat request and the system message. Run in a child process
 * with HOME set to a temp dir (see local-delegation.test.ts), so the agent's
 * memory, sessions and settings never touch the real home.
 *
 *   bun local-turn-probe.ts <role|-> <workdir>
 */
export {};

const [roleArg, workdir] = process.argv.slice(2);
const role = roleArg === "-" ? undefined : (roleArg as "orchestrator" | "engineer" | "qa");

type Seen = { tools: string[]; system: string };
const seen: Seen[] = [];
globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
	const url = String(typeof input === "string" ? input : (input as { url?: string })?.url ?? input);
	if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "probe:1b", model: "probe:1b" }] });
	if (url.includes("/chat/completions")) {
		const body = JSON.parse(init?.body ?? "{}") as {
			tools?: Array<{ function: { name: string } }>;
			messages?: Array<{ role: string; content: string }>;
		};
		seen.push({
			tools: (body.tools ?? []).map((t) => t.function.name),
			system: body.messages?.find((m) => m.role === "system")?.content ?? "",
		});
		return Response.json({
			choices: [{ message: { role: "assistant", content: "DONE: nothing to do." }, finish_reason: "stop" }],
		});
	}
	return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

const { Agent } = await import("../../agent");
const agent = new Agent({ model: "probe:1b", runtime: "ollama", workingDirectory: workdir, maxTurns: 4, role });
await agent.chat("say hi");
// The last request is the real turn (earlier ones may be capability probes).
const turn = seen.filter((s) => s.tools.length > 1).at(-1) ?? seen.at(-1);
process.stdout.write(`\n@@PROBE@@${JSON.stringify(turn ?? null)}\n`);
await agent.cleanup?.();
process.exit(0);
