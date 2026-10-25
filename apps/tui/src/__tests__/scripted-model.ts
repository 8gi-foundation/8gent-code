/**
 * A fake local model that answers from a script, one step per turn request,
 * each after its own delay: the way to hold a turn open long enough for a
 * test to press keys while it runs (#3918 D1). The task router's
 * classification request and the readiness "ping" are answered at once and
 * not counted. Serves what
 * fake-model.ts serves (ollama tags, both chat shapes, streaming or not) plus
 * /api/show, and lists the models given so a test can cycle between them.
 */

export interface ScriptStep {
	reply: string;
	delayMs?: number;
}

export interface ScriptedModel {
	env: Record<string, string>;
	/** Every turn request body, in order (classification requests excluded). */
	requests: unknown[];
	stop: () => void;
}

const CLASSIFY = "Classify this user task";

interface ChatBody {
	stream?: boolean;
	messages?: { role: string; content: unknown }[];
}

function openAiStream(model: string, reply: string): Response {
	const chunk = (delta: Record<string, unknown>, finish: string | null) =>
		`data: ${JSON.stringify({
			id: "fake",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`;
	const body = `${chunk({ role: "assistant", content: reply }, null)}${chunk({}, "stop")}data: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** The task router's classification and the readiness "ping" are not turns. */
function isProbe(body: ChatBody): boolean {
	const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
	if (typeof last?.content !== "string") return false;
	return last.content.startsWith(CLASSIFY) || last.content.trim() === "ping";
}

export function serveScriptedModel(
	steps: readonly ScriptStep[],
	models: readonly string[] = ["shell-test:1b"],
): ScriptedModel {
	const requests: unknown[] = [];
	let cursor = 0;
	const primary = models[0] ?? "shell-test:1b";
	const next = async (body: ChatBody) => {
		if (isProbe(body)) return { reply: "simple", model: primary };
		requests.push(body);
		const step = steps[Math.min(cursor, steps.length - 1)] ?? { reply: "" };
		cursor++;
		if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
		return { reply: step.reply, model: primary };
	};
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/api/tags") {
				return Response.json({ models: models.map((m) => ({ name: m, model: m, size: 1 })) });
			}
			if (url.pathname === "/api/version") return Response.json({ version: "0.0.0" });
			if (url.pathname === "/api/show") return Response.json({ capabilities: ["completion"] });
			if (url.pathname === "/v1/models") {
				return Response.json({
					object: "list",
					data: models.map((id) => ({ id, object: "model" })),
				});
			}
			if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
				const body = (await req.json()) as ChatBody;
				const { reply, model } = await next(body);
				if (body.stream) return openAiStream(model, reply);
				return Response.json({
					id: "fake",
					object: "chat.completion",
					created: 0,
					model,
					choices: [
						{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				});
			}
			if (req.method === "POST" && url.pathname === "/api/chat") {
				const body = (await req.json()) as ChatBody;
				const { reply, model } = await next(body);
				const done = {
					model,
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
		env: { OLLAMA_BASE_URL: base, OLLAMA_HOST: base, EIGHT_TEXT_TOOLS: "1" },
		requests,
		stop: () => server.stop(true),
	};
}

/** Every user message text in every turn request, in order. */
export function userTexts(requests: unknown[]): string[] {
	return requests.flatMap((body) =>
		((body as { messages?: { role: string; content: unknown }[] }).messages ?? [])
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))),
	);
}
