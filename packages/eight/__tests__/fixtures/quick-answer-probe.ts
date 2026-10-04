/**
 * Runs ONE real Agent turn on the local text-tool path with the network stubbed
 * (#3411). The fake model answers a "[QUICK ANSWER]" request per <mode> and any
 * other request with "DONE: full loop answer.", then prints the reply and what
 * each request declared. Run in a child process with HOME in a temp dir.
 *
 *   bun quick-answer-probe.ts <answer|needs-deep|long-error> <workdir> <prompt>
 *
 * PROBE_TAGS (comma list) sets the installed Ollama models; default "probe:1b".
 * Every ToolExecutor.execute call is recorded, so a test can prove no
 * run_command ran outside the lane (8SO F1).
 *
 * #3416 knobs (all optional):
 *   PROBE_NO_PROVISIONAL=1  register no onProvisional (a surface that cannot show it)
 *   PROBE_QUICK_TEXT        the lane's final answer (default "DONE: It listens on 4100.")
 *   PROBE_DEEP_TEXT         the full loop's answer (default "DONE: full loop answer.")
 *   PROBE_DEEP_FAIL=1       the full loop's requests fail with HTTP 400
 *   PROBE_ESC=lane|deep     press ESC (agent.abort()) on the first lane or full-loop request
 *   PROBE_ESC=after-deep    press ESC as the full loop's answer comes back
 *   PROBE_PROVISIONAL_THROW=1  the onProvisional callback throws (a broken display)
 *   PROBE_SECOND            a second prompt, sent after the first reply in the same session
 * `timeline` records lane requests, full-loop requests and provisional messages in order.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [mode, workdir, prompt] = process.argv.slice(2);
writeFileSync(join(workdir, "server.ts"), 'export const port = process.env.PORT ?? "4100";\n');

const tags = (process.env.PROBE_TAGS ?? "probe:1b").split(",");
const executed: string[] = [];
const { ToolExecutor } = await import("../../tools");
const realExecute = ToolExecutor.prototype.execute;
ToolExecutor.prototype.execute = function (name: string, args: Record<string, unknown>) {
	executed.push(name);
	return realExecute.call(this, name, args);
};

type Seen = {
	quick: boolean;
	proactive: boolean;
	tools: string[];
	model: string;
	reasoningEffort: string | null;
	chars: number;
	system: string;
	roles: string[];
};
const seen: Seen[] = [];
const timeline: string[] = [];
const provisionals: string[] = [];
let quickRequests = 0;
let escPressed = false;
let agentRef: { abort: () => void } | null = null;
/** ESC: abort the turn, and hang this request until the abort reaches it. */
function pressEsc(signal: AbortSignal | undefined): Promise<Response> {
	escPressed = true;
	agentRef?.abort();
	return new Promise((_, reject) => {
		const fail = () => reject(new DOMException("This operation was aborted", "AbortError"));
		if (!signal || signal.aborted) return fail();
		signal.addEventListener("abort", fail, { once: true });
	});
}
globalThis.fetch = (async (input: unknown, init?: { body?: string; signal?: AbortSignal }) => {
	const url = String(
		typeof input === "string" ? input : ((input as { url?: string })?.url ?? input),
	);
	if (url.endsWith("/api/tags"))
		return Response.json({ models: tags.map((name) => ({ name, model: name })) });
	if (url.includes("/chat/completions")) {
		const body = JSON.parse(init?.body ?? "{}") as {
			model?: string;
			reasoning_effort?: string;
			tools?: Array<{ function: { name: string } }>;
			messages?: Array<{ role: string; content: string }>;
		};
		const quick = (body.messages ?? []).some((m) => m.content?.includes("[QUICK ANSWER]"));
		const full = !quick && (body.tools ?? []).some((t) => t.function.name === "write_file");
		timeline.push(quick ? "lane" : full ? "full" : "other");
		seen.push({
			quick,
			proactive: (body.messages ?? []).some((m) => m.content?.includes("[PROACTIVE QUESTIONING]")),
			tools: (body.tools ?? []).map((t) => t.function.name),
			model: body.model ?? "",
			reasoningEffort: body.reasoning_effort ?? null,
			// What the endpoint has to process: every message plus the declared tool schemas.
			chars:
				(body.messages ?? []).reduce((n, m) => n + (m.content?.length ?? 0), 0) +
				(body.tools ? JSON.stringify(body.tools).length : 0),
			system: (body.messages ?? []).find((m) => m.role === "system")?.content ?? "",
			roles: (body.messages ?? []).map((m) => m.role),
		});
		let content = process.env.PROBE_DEEP_TEXT ?? "DONE: full loop answer.";
		if (quick && mode === "long-error") {
			return new Response(`upstream exploded: ${"x".repeat(1000)}`, { status: 400 });
		}
		if (!escPressed && process.env.PROBE_ESC === (quick ? "lane" : full ? "deep" : "")) {
			return pressEsc(init?.signal);
		}
		if (full && !escPressed && process.env.PROBE_ESC === "after-deep") {
			escPressed = true;
			agentRef?.abort();
		}
		if (full && process.env.PROBE_DEEP_FAIL === "1") {
			return new Response("upstream exploded", { status: 400 });
		}
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
						: (process.env.PROBE_QUICK_TEXT ?? "DONE: It listens on 4100.");
		}
		return Response.json({
			choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
			usage: {
				prompt_tokens: 100 + seen.length,
				completion_tokens: 5,
				total_tokens: 105 + seen.length,
			},
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
	events:
		process.env.PROBE_NO_PROVISIONAL === "1"
			? {}
			: {
					onProvisional: (event: { text: string }) => {
						timeline.push("provisional");
						provisionals.push(event.text);
						if (process.env.PROBE_PROVISIONAL_THROW === "1") throw new Error("display broke");
					},
				},
});
agentRef = agent;
const reply = await agent.chat(prompt);
const second = process.env.PROBE_SECOND ? await agent.chat(process.env.PROBE_SECOND) : null;
const history = (
	agent as unknown as { messageHistory: Array<{ role: string; content: string }> }
).messageHistory
	.filter((m) => m.role === "assistant")
	.map((m) => m.content);
const runLog = join(homedir(), ".8gent", "runs.jsonl");
const runs = existsSync(runLog)
	? readFileSync(runLog, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
	: [];
process.stdout.write(
	`\n@@PROBE@@${JSON.stringify({
		reply,
		second,
		seen,
		runs,
		executed,
		timeline,
		provisionals,
		history,
		abortControllerAfter:
			(agent as unknown as { abortController: unknown }).abortController != null,
	})}\n`,
);
await agent.cleanup?.();
process.exit(0);
