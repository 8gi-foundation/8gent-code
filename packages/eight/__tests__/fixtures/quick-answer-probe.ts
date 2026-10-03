/**
 * Runs ONE real Agent turn on the local text-tool path with the network stubbed
 * (#3411). The fake model answers a "[QUICK ANSWER]" request per <mode> and any
 * other request with "DONE: full loop answer.", then prints the reply and what
 * each request declared. Run in a child process with HOME in a temp dir.
 *
 *   bun quick-answer-probe.ts <answer|needs-deep> <workdir> <prompt>
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, workdir, prompt] = process.argv.slice(2);
writeFileSync(join(workdir, "server.ts"), 'export const port = process.env.PORT ?? "4100";\n');

type Seen = { quick: boolean; tools: string[] };
const seen: Seen[] = [];
let quickRequests = 0;
globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
	const url = String(
		typeof input === "string" ? input : ((input as { url?: string })?.url ?? input),
	);
	if (url.endsWith("/api/tags"))
		return Response.json({ models: [{ name: "probe:1b", model: "probe:1b" }] });
	if (url.includes("/chat/completions")) {
		const body = JSON.parse(init?.body ?? "{}") as {
			tools?: Array<{ function: { name: string } }>;
			messages?: Array<{ role: string; content: string }>;
		};
		const quick = (body.messages ?? []).some((m) => m.content?.includes("[QUICK ANSWER]"));
		seen.push({ quick, tools: (body.tools ?? []).map((t) => t.function.name) });
		let content = "DONE: full loop answer.";
		if (quick) {
			quickRequests++;
			content =
				mode === "needs-deep"
					? "NEEDS_DEEP"
					: quickRequests === 1
						? [
								"```tool_call",
								JSON.stringify({ name: "read_file", arguments: { path: "server.ts" } }),
								"```",
							].join("\n")
						: "DONE: It listens on 4100.";
		}
		return Response.json({
			choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
		});
	}
	return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

const { Agent } = await import("../../agent");
const agent = new Agent({
	model: "probe:1b",
	runtime: "ollama",
	workingDirectory: workdir,
	maxTurns: 4,
});
const reply = await agent.chat(prompt);
process.stdout.write(`\n@@PROBE@@${JSON.stringify({ reply, seen })}\n`);
await agent.cleanup?.();
process.exit(0);
