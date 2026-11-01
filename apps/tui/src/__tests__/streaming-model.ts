/**
 * A fake local model that streams slowly, for flicker tests (#4970). Each chat
 * answer arrives as many small chunks over a few seconds, the way a phone sees
 * a real local model. The first request that offers tools gets one list_files
 * tool call, so a turn shows a tool row, the spinner and then streamed text.
 * Serves ollama's native /api/chat and the OpenAI-style /v1/chat/completions.
 */

export const STREAM_MODEL = "shell-test:1b";

export interface StreamingModel {
	env: Record<string, string>;
	stop: () => void;
}

interface ChatBody {
	stream?: boolean;
	tools?: unknown[];
}

function drip(parts: string[], gapMs: number): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	let i = 0;
	return new ReadableStream({
		async pull(ctrl) {
			if (i >= parts.length) return ctrl.close();
			if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
			ctrl.enqueue(enc.encode(parts[i++]));
		},
	});
}

export function serveStreamingModel(words: string[], gapMs = 25): StreamingModel {
	// Only the first request that offers tools gets the tool call; every later
	// chat streams the text, so the turn always ends with an answer.
	let toolCallSent = false;
	const wantsTool = (b: ChatBody) => {
		if (toolCallSent || !Array.isArray(b.tools) || b.tools.length === 0) return false;
		toolCallSent = true;
		return true;
	};
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (process.env.FLICKER_DEBUG) console.error(`[model] ${req.method} ${url.pathname}`);
			if (url.pathname === "/api/tags") {
				return Response.json({
					models: [{ name: STREAM_MODEL, model: STREAM_MODEL, size: 1 }],
				});
			}
			if (url.pathname === "/api/version") return Response.json({ version: "0.0.0" });
			if (url.pathname === "/v1/models") {
				return Response.json({ object: "list", data: [{ id: STREAM_MODEL, object: "model" }] });
			}
			if (req.method === "POST" && url.pathname === "/api/chat") {
				const body = (await req.json()) as ChatBody;
				const base = { model: STREAM_MODEL, created_at: new Date(0).toISOString() };
				if (wantsTool(body)) {
					const call = {
						...base,
						message: {
							role: "assistant",
							content: "",
							tool_calls: [{ function: { name: "list_files", arguments: { path: "." } } }],
						},
						done: true,
						done_reason: "stop",
						prompt_eval_count: 1,
						eval_count: 1,
					};
					return new Response(`${JSON.stringify(call)}\n`, {
						headers: { "content-type": "application/x-ndjson" },
					});
				}
				const lines = words.map(
					(w) =>
						`${JSON.stringify({ ...base, message: { role: "assistant", content: `${w} ` }, done: false })}\n`,
				);
				lines.push(
					`${JSON.stringify({ ...base, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: words.length })}\n`,
				);
				if (body.stream === false) {
					return Response.json({
						...base,
						message: { role: "assistant", content: words.join(" ") },
						done: true,
						done_reason: "stop",
						prompt_eval_count: 1,
						eval_count: words.length,
					});
				}
				return new Response(drip(lines, gapMs), {
					headers: { "content-type": "application/x-ndjson" },
				});
			}
			if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
				const body = (await req.json()) as ChatBody;
				const chunk = (delta: Record<string, unknown>, finish: string | null) =>
					`data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: STREAM_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
				if (wantsTool(body)) {
					return new Response(
						chunk(
							{
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: "c1",
										type: "function",
										function: { name: "list_files", arguments: '{"path":"."}' },
									},
								],
							},
							null,
						) +
							chunk({}, "tool_calls") +
							"data: [DONE]\n\n",
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
				const parts = words.map((w) => chunk({ content: `${w} ` }, null));
				parts.push(chunk({}, "stop"), "data: [DONE]\n\n");
				return new Response(drip(parts, gapMs), {
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	const base = `http://127.0.0.1:${server.port}`;
	return { env: { OLLAMA_BASE_URL: base, OLLAMA_HOST: base }, stop: () => server.stop(true) };
}
