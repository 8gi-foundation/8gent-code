// Stub OpenAI-compatible model server for the Windows one-task CI job (#3892).
// First chat request (no assistant turn yet) answers with one write_file call in
// the text-tool format; any later request answers with a DONE: summary.
// Usage: bun scripts/ci/stub-model-server.ts [port]   (default 8189)
const port = Number(process.argv[2] ?? 8189);
const TARGET = process.env.STUB_TARGET_FILE ?? "hello.txt";
const CONTENT = process.env.STUB_TARGET_CONTENT ?? "hello from windows ci";

const toolReply =
	"```tool_call\n" +
	JSON.stringify({ name: "write_file", arguments: { path: TARGET, content: CONTENT } }) +
	"\n```";
const doneReply = `DONE: wrote ${TARGET}`;

function completion(content: string) {
	return {
		id: "stub",
		object: "chat.completion",
		model: "stub",
		choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

function sse(content: string) {
	const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
	return (
		frame({ id: "stub", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }) +
		frame({ id: "stub", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
		"data: [DONE]\n\n"
	);
}

Bun.serve({
	port,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname.endsWith("/models")) {
			return Response.json({ object: "list", data: [{ id: "stub", object: "model" }] });
		}
		if (url.pathname.endsWith("/chat/completions")) {
			const body = (await req.json()) as { stream?: boolean; messages?: Array<{ role: string }> };
			const seenAssistant = (body.messages ?? []).some((m) => m.role === "assistant");
			const content = seenAssistant ? doneReply : toolReply;
			console.log(`[stub] chat stream=${!!body.stream} assistantSeen=${seenAssistant}`);
			if (body.stream) {
				return new Response(sse(content), { headers: { "content-type": "text/event-stream" } });
			}
			return Response.json(completion(content));
		}
		return new Response("not found", { status: 404 });
	},
});
console.log(`[stub] listening on 127.0.0.1:${port}`);
