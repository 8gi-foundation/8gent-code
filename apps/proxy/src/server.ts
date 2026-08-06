/**
 * 8gent Model Proxy - OpenAI-compatible localhost gateway.
 *
 * A thin HTTP front-end over the 8gent adaptive router
 * (`packages/providers` + `packages/eight/clients`). Point ANY
 * OpenAI-compatible client at `http://127.0.0.1:8787/v1` and every request is
 * dispatched through `ProviderManager.chat()`, which keeps the PII-egress gate,
 * thinking-level resolution and local-first provider selection intact. We add
 * model-not-found reroute via the existing `callLocalModelWithReroute`.
 *
 * This file imports the router; it does not duplicate any routing logic.
 */

import {
	callLocalModelWithReroute,
	getProviderManager,
} from "../../../packages/providers";
import {
	type OpenAIChatRequest,
	toChatRequest,
	toOpenAICompletion,
	toOpenAISSE,
} from "./openai";

export interface ProxyOptions {
	port: number;
	host: string;
}

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = "127.0.0.1";

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...extraHeaders },
	});
}

function errorBody(message: string, type: string, status: number): Response {
	// OpenAI-shaped error envelope so client SDKs surface a sane message.
	return json({ error: { message, type, code: null } }, status);
}

/** `GET /v1/models` - advertise the enabled providers' models, OpenAI-shaped. */
function handleModels(): Response {
	const pm = getProviderManager();
	const created = Math.floor(Date.now() / 1000);
	const data = pm
		.listEnabledProviders()
		.flatMap((p) =>
			(p.models.length > 0 ? p.models : [p.defaultModel]).map((model) => ({
				id: model,
				object: "model" as const,
				created,
				owned_by: p.name,
			})),
		);
	return json({ object: "list", data });
}

/** `GET /health` - liveness plus the router's current active selection. */
function handleHealth(): Response {
	const pm = getProviderManager();
	return json({
		status: "ok",
		service: "8gent-proxy",
		activeProvider: pm.getActiveProvider().name,
		activeModel: pm.getActiveModel(),
	});
}

/** `POST /v1/chat/completions` - the one route that matters. */
async function handleChatCompletions(req: Request): Promise<Response> {
	let body: OpenAIChatRequest;
	try {
		body = (await req.json()) as OpenAIChatRequest;
	} catch {
		return errorBody("Request body must be valid JSON.", "invalid_request_error", 400);
	}

	if (!Array.isArray(body.messages) || body.messages.length === 0) {
		return errorBody("`messages` must be a non-empty array.", "invalid_request_error", 400);
	}

	const chatRequest = toChatRequest(body);
	const pm = getProviderManager();
	const active = pm.getActiveProvider();

	// Route through the existing reroute-on-missing-model wrapper. The router
	// itself owns the PII-egress gate and thinking resolution inside `chat()`.
	const outcome = await callLocalModelWithReroute({
		provider: active.name,
		model: chatRequest.model ?? pm.getActiveModel(),
		run: (_provider, model) => pm.chat({ ...chatRequest, model }),
	});

	if (!outcome.ok) {
		return errorBody(outcome.message, "model_not_found", 404);
	}

	const response = outcome.value;

	if (body.stream === true) {
		return new Response(toOpenAISSE(response), {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	}

	return json(toOpenAICompletion(response));
}

/** Build the request router. Exported so tests can drive it without a socket. */
export async function handle(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const { pathname } = url;

	if (req.method === "GET" && (pathname === "/health" || pathname === "/healthz")) {
		return handleHealth();
	}
	if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
		return handleModels();
	}
	if (
		req.method === "POST" &&
		(pathname === "/v1/chat/completions" || pathname === "/chat/completions")
	) {
		try {
			return await handleChatCompletions(req);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return errorBody(message, "api_error", 502);
		}
	}

	return errorBody(`No route for ${req.method} ${pathname}`, "not_found", 404);
}

/** Start the Bun HTTP server. Returns the running server handle. */
export function startServer(opts: Partial<ProxyOptions> = {}) {
	const port = opts.port ?? DEFAULT_PORT;
	const host = opts.host ?? DEFAULT_HOST;
	const server = Bun.serve({ port, hostname: host, fetch: handle });
	return server;
}
