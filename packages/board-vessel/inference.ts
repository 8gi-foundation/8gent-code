/**
 * Inference wrapper for board vessel workers.
 *
 * Routes through the 8gi-model-proxy (OpenAI-compatible API) for cloud inference,
 * or directly to local Ollama if INFERENCE_MODE=ollama.
 *
 * The model-proxy handles provider selection, rate limiting, and fallback.
 */

// Model proxy on Fly internal network, or Ollama fallback
const MODEL_PROXY_URL = process.env.MODEL_PROXY_URL || "http://8gi-model-proxy.internal:3200";
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const INFERENCE_MODE = process.env.INFERENCE_MODE || "proxy"; // "proxy" | "ollama"
const MAX_RESPONSE_LENGTH = 1900;

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

export async function generateResponse(
  req: InferenceRequest,
): Promise<InferenceResult> {
  const start = Date.now();

  const messages = [
    { role: "system", content: req.systemPrompt },
    ...req.contextMessages,
    { role: "user", content: req.userMessage },
  ];

  let reply: string;
  let tokensUsed: number | undefined;

  if (INFERENCE_MODE === "ollama") {
    // Direct Ollama call (for factory/local use)
    const model = req.model ?? "qwen3:latest";
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false, options: { num_predict: 500 } }),
    });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
    const data = await res.json() as any;
    reply = data.message?.content ?? "No response generated.";
    tokensUsed = data.eval_count ?? undefined;
  } else {
    // Model proxy (OpenAI-compatible) - default for cloud vessels
    const model = req.model ?? "auto:free";
    const vesselId = process.env.BOARD_MEMBER_CODE || "unknown";
    const res = await fetch(`${MODEL_PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vessel-ID": vesselId,
      },
      body: JSON.stringify({ model, messages, max_tokens: 500 }),
    });
    if (!res.ok) throw new Error(`Model proxy returned ${res.status}: ${await res.text()}`);
    const data = await res.json() as any;
    reply = data.choices?.[0]?.message?.content ?? "No response generated.";
    tokensUsed = data.usage?.completion_tokens ?? undefined;
  }

  if (reply.length > MAX_RESPONSE_LENGTH) {
    reply = reply.slice(0, MAX_RESPONSE_LENGTH) + "...";
  }

  return { response: reply, durationMs: Date.now() - start, tokensUsed };
}
