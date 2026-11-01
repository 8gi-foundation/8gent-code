/**
 * Inference wrapper for board vessel workers.
 *
 * Routes through the model-proxy (OpenAI-compatible API) for cloud inference,
 * or directly to local Ollama if INFERENCE_MODE=ollama.
 *
 * The model-proxy handles provider selection, rate limiting, and fallback.
 */

import { anonymizeMessages, deanonymize, verifyClean } from "../permissions/pii-anonymizer";
import { withRedirectHint } from "../providers/redirect-hint";

// Model proxy on Fly internal network, or Ollama fallback. Read at CALL time
// (not module load) so the deploy/host config and the cloud-vs-local routing
// decision always reflect the live environment.
const DEFAULT_MODEL_PROXY_URL = "http://model-proxy.example.internal:3200";
const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const MAX_RESPONSE_LENGTH = 1900;

/**
 * Direct providers an officer vessel may call, and nothing else (egress
 * allowlist in code). Each is OpenAI-compatible. MiniMax is its own API with no
 * middleman; OpenRouter stays for models MiniMax does not serve (Kimi).
 */
const DIRECT_PROVIDERS = {
	minimax: {
		label: "MiniMax",
		keyEnv: "MINIMAX_API_KEY",
		baseEnv: "MINIMAX_BASE_URL",
		// International endpoint; China region is api.minimaxi.com. No other host.
		defaultBase: "https://api.minimax.io/v1",
		allowedHosts: ["api.minimax.io", "api.minimaxi.com"],
	},
	openrouter: {
		label: "OpenRouter",
		keyEnv: "OPENROUTER_API_KEY",
		baseEnv: "",
		defaultBase: "https://openrouter.ai/api/v1",
		allowedHosts: ["openrouter.ai"],
	},
} as const;

export type DirectProviderName = keyof typeof DIRECT_PROVIDERS;

export interface DirectProvider {
	name: DirectProviderName;
	label: string;
	base: string;
	key: string;
	keyEnv: string;
}

/**
 * Resolve the vessel's direct provider from the environment. INFERENCE_MODE=direct
 * reads VESSEL_PROVIDER; INFERENCE_MODE=openrouter is the same path pinned to
 * OpenRouter. Fails closed on an unknown provider, an off-allowlist base URL, or
 * a missing key.
 */
export function resolveDirectProvider(): DirectProvider {
	const mode = process.env.INFERENCE_MODE || "";
	const wanted = mode === "openrouter" ? "openrouter" : process.env.VESSEL_PROVIDER || "";
	if (!(wanted in DIRECT_PROVIDERS)) {
		throw new Error(
			`VESSEL_PROVIDER must be one of ${Object.keys(DIRECT_PROVIDERS).join(", ")} (got "${wanted}")`,
		);
	}
	const name = wanted as DirectProviderName;
	const cfg = DIRECT_PROVIDERS[name];
	const base = ((cfg.baseEnv && process.env[cfg.baseEnv]) || cfg.defaultBase).replace(/\/+$/, "");
	let host = "";
	try {
		host = new URL(base).hostname;
	} catch {
		/* falls through to the refusal below */
	}
	if (!base.startsWith("https://") || !(cfg.allowedHosts as readonly string[]).includes(host)) {
		throw new Error(`${cfg.label} base URL is not on the egress allowlist: ${host || base}`);
	}
	const key = process.env[cfg.keyEnv] || "";
	if (!key) throw new Error(`${cfg.keyEnv} is not set for provider ${name}`);
	return { name, label: cfg.label, base, key, keyEnv: cfg.keyEnv };
}

/**
 * Check a model id against the provider's own live model list. Officer vessels
 * pick their model per officer (VESSEL_MODEL), never from a literal in code, so
 * the id is validated at boot. Any failure to read the list throws: the caller
 * fails closed.
 */
export async function modelIsListed(
	model: string,
	provider = resolveDirectProvider(),
): Promise<boolean> {
	const res = await fetch(`${provider.base}/models`, {
		headers: { Authorization: `Bearer ${provider.key}` },
	});
	if (!res.ok) throw new Error(`${provider.label} model list returned ${res.status}`);
	const data = (await res.json()) as { data?: Array<{ id: string }> };
	return (data.data ?? []).some((m) => m.id === model);
}

/** MiniMax M2.x put reasoning inline as <think>...</think>; the officer gets the answer only. */
function stripThinking(text: string): string {
	return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

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
	maxTokens?: number;
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
	// "proxy" | "ollama" | "direct" (VESSEL_PROVIDER) | "openrouter" (direct, pinned)
	const inferenceMode = process.env.INFERENCE_MODE || "proxy";

	const useOllama = inferenceMode === "ollama";
	const direct =
		inferenceMode === "direct" || inferenceMode === "openrouter" ? resolveDirectProvider() : null;
	const target = useOllama ? ollamaHost : direct ? direct.base : modelProxyUrl;

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
			redirect: "error",
		}).catch((err) => {
			throw withRedirectHint(err, ollamaHost, "OLLAMA_HOST");
		});
		if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
		const data = (await res.json()) as any;
		reply = data.message?.content ?? "No response generated.";
		tokensUsed = data.eval_count ?? undefined;
	} else if (direct) {
		// Officer vessel: straight to the provider with the vessel's own key. The
		// model is the officer's setting (VESSEL_MODEL); there is no default.
		if (!req.model) throw new Error("No model set: VESSEL_MODEL is required for a direct provider");
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${direct.key}`,
		};
		if (direct.name === "openrouter") {
			headers["X-Title"] =
				`8gi-vessel-${(process.env.BOARD_MEMBER_CODE || "unknown").toLowerCase()}`;
		}
		const res = await fetch(`${direct.base}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: req.model, messages, max_tokens: req.maxTokens ?? 500 }),
		});
		if (!res.ok) throw new Error(`${direct.label} returned ${res.status}`);
		const data = (await res.json()) as any;
		const content = data.choices?.[0]?.message?.content;
		reply =
			typeof content === "string" && content ? stripThinking(content) : "No response generated.";
		tokensUsed = data.usage?.completion_tokens ?? undefined;
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
			redirect: "error",
		}).catch((err) => {
			throw withRedirectHint(err, modelProxyUrl, "MODEL_PROXY_URL");
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
