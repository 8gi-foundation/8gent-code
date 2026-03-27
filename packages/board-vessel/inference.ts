/**
 * Ollama inference wrapper for board vessel workers.
 *
 * Calls the local Ollama chat API, enforces max response length,
 * and returns timing metrics.
 */

const OLLAMA_HOST = "http://localhost:11434";
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
  const model = req.model ?? "qwen3:latest";
  const start = Date.now();

  const messages = [
    { role: "system", content: req.systemPrompt },
    ...req.contextMessages,
    { role: "user", content: req.userMessage },
  ];

  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: { num_predict: 500 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  let reply: string = data.message?.content ?? "No response generated.";

  if (reply.length > MAX_RESPONSE_LENGTH) {
    reply = reply.slice(0, MAX_RESPONSE_LENGTH) + "...";
  }

  const durationMs = Date.now() - start;

  return {
    response: reply,
    durationMs,
    tokensUsed: data.eval_count ?? undefined,
  };
}
