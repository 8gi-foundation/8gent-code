/**
 * Inference wrapper for board vessel workers.
 *
 * Routes through the 8gi-model-proxy (OpenAI-compatible API) for cloud inference,
 * or directly to local Ollama if INFERENCE_MODE=ollama.
 *
 * The model-proxy handles provider selection, rate limiting, and fallback.
 */

import {
	anonymizeMessages,
	deanonymize,
	verifyClean,
} from "../permissions/pii-anonymizer";

// Model proxy on Fly internal network, or Ollama fallback. Read at CALL time
// (not module load) so the deploy/host config and the cloud-vs-local routing
// decision always reflect the live environment.
const DEFAULT_MODEL_PROXY_URL = "http://8gi-model-proxy.internal:3200";
const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const MAX_RESPONSE_LENGTH = 1900;

/**
 * Hostnames considered on-device. A request to any of these never leaves the
 * machine, so the PII gate may bypass it.
 */
const LOCAL_HOST_RE = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/i;

/**
 * Decide whether a target URL sends data off the local machine. Mirrors
 * `isCloudProvider` from `packages/providers/index.ts` exactly, inlined here so
 * the board-vessel Fly image (which copies only board-plane + board-vessel) has
 * no cross-package runtime dependency. `*.internal` (Fly private net) is NOT
 * proven local - the proxy behind it forwards to a public cloud provider - so
 * it is treated as cloud (fail-safe). Unparseable URLs are treated as cloud.
 */
function isCloudHost(url: string): boolean {
	const u = (url || "").trim();
	if (!u) return false;
	let host: string;
	try {
		host = new URL(u).hostname;
	} catch {
		return true;
	}
	return !LOCAL_HOST_RE.test(host);
}

export interface InferenceRequest {
	systemPrompt: string;
	contextMessages: Array<{ role: string; content: string }>;
	userMessage: string;
	model?: string;
}

export interface InferenceResult {
	response: string;
	durationMs: number;
	tokensUsed?: number;
}

export async function generateResponse(req: InferenceRequest): Promise<InferenceResult> {
	const start = Date.now();

	const rawMessages = [
		{ role: "system", content: req.systemPrompt },
		...req.contextMessages,
		{ role: "user", content: req.userMessage },
	];

	const modelProxyUrl = process.env.MODEL_PROXY_URL || DEFAULT_MODEL_PROXY_URL;
	const ollamaHost = process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST;
	const inferenceMode = process.env.INFERENCE_MODE || "proxy"; // "proxy" | "ollama"

	const useOllama = inferenceMode === "ollama";
	const target = useOllama ? ollamaHost : modelProxyUrl;

	// ── PII gate (cloud-egress boundary) ────────────────────────────────────
	// HARD RULE: no PII may reach a cloud target. The model proxy forwards to a
	// public provider (OpenRouter minimax), so its `*.internal` host counts as
	// cloud. Anonymize the FULL outbound payload (system + context + user) and
	// de-anonymize the reply. If anonymization throws or PII survives, FAIL
	// CLOSED: when the target is cloud, refuse; the local Ollama path is sent raw
	// (data stays on-device).
	let messages = rawMessages;
	let piiMap: Map<string, string> | null = null;
	if (isCloudHost(target)) {
		let failClosed = false;
		try {
			const gated = anonymizeMessages(rawMessages);
			if (verifyClean(gated.messages.map((m) => m.content).join("\n"))) {
				messages = gated.messages;
				piiMap = gated.map;
			} else {
				failClosed = true;
			}
		} catch {
			failClosed = true;
		}
		if (failClosed) {
			throw new Error(
				"PII gate fail-closed (board inference): could not produce a verified-clean " +
					"payload for a cloud target. Refusing to send.",
			);
		}
	}

	let reply: string;
	let tokensUsed: number | undefined;

	if (useOllama) {
		// Direct Ollama call (for factory/local use)
		const model = req.model ?? "qwen3:latest";
		const res = await fetch(`${ollamaHost}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages,
				stream: false,
				options: { num_predict: 500 },
			}),
		});
		if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
		const data = (await res.json()) as any;
		reply = data.message?.content ?? "No response generated.";
		tokensUsed = data.eval_count ?? undefined;
	} else {
		// Model proxy (OpenAI-compatible) - default for cloud vessels
		const model = req.model ?? "auto:free";
		const vesselId = process.env.BOARD_MEMBER_CODE || "unknown";
		const res = await fetch(`${modelProxyUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Vessel-ID": vesselId,
			},
			body: JSON.stringify({ model, messages, max_tokens: 500 }),
		});
		if (!res.ok) throw new Error(`Model proxy returned ${res.status}: ${await res.text()}`);
		const data = (await res.json()) as any;
		reply = data.choices?.[0]?.message?.content ?? "No response generated.";
		tokensUsed = data.usage?.completion_tokens ?? undefined;
	}

	// De-anonymize the cloud reply so the officer sees real values; the cloud
	// only ever saw pseudonyms.
	if (piiMap && piiMap.size > 0) {
		reply = deanonymize(reply, piiMap);
	}

	if (reply.length > MAX_RESPONSE_LENGTH) {
		reply = `${reply.slice(0, MAX_RESPONSE_LENGTH)}...`;
	}

	return { response: reply, durationMs: Date.now() - start, tokensUsed };
}
