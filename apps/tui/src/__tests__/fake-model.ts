/**
 * A fake local model for real-App tests: answers ollama's model list and
 * chat, both the native /api/chat and the OpenAI-style /v1/chat/completions,
 * with a fixed reply, and keeps every chat request body so a test can check
 * what the model was sent. Pass `env` to runAppHarness as extraEnv.
 */

export const FAKE_MODEL = "shell-test:1b";

export interface FakeModel {
	env: Record<string, string>;
	/** Every chat request body, in order. */
	requests: unknown[];
	stop: () => void;
}

function sse(model: string, reply: string): Response {
	const chunk = (delta: Record<string, unknown>, finish: string | null) =>
		`data: ${JSON.stringify({
			id: "fake",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`;
	const body =
		chunk({ role: "assistant", content: reply }, null) +
		chunk({}, "stop") +
		`data: ${JSON.stringify({
			id: "fake",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		})}\n\ndata: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export function serveFakeModel(reply: string): FakeModel {
	const requests: unknown[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/api/tags") {
				return Response.json({ models: [{ name: FAKE_MODEL, model: FAKE_MODEL, size: 1 }] });
			}
			if (url.pathname === "/api/version") return Response.json({ version: "0.0.0" });
			if (url.pathname === "/v1/models") {
				return Response.json({ object: "list", data: [{ id: FAKE_MODEL, object: "model" }] });
			}
			if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
				const body = (await req.json()) as { stream?: boolean };
				requests.push(body);
				if (body.stream) return sse(FAKE_MODEL, reply);
				return Response.json({
					id: "fake",
					object: "chat.completion",
					created: 0,
					model: FAKE_MODEL,
					choices: [
						{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				});
			}
			if (req.method === "POST" && url.pathname === "/api/chat") {
				const body = (await req.json()) as { stream?: boolean };
				requests.push(body);
				const done = {
					model: FAKE_MODEL,
					created_at: new Date(0).toISOString(),
					message: { role: "assistant", content: reply },
					done: true,
					done_reason: "stop",
					prompt_eval_count: 1,
					eval_count: 1,
				};
				if (body.stream === false) return Response.json(done);
				return new Response(`${JSON.stringify(done)}\n`, {
					headers: { "content-type": "application/x-ndjson" },
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	const base = `http://127.0.0.1:${server.port}`;
	return {
		env: { OLLAMA_BASE_URL: base, OLLAMA_HOST: base },
		requests,
		stop: () => server.stop(true),
	};
}
