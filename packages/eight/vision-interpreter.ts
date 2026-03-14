/**
 * vision-interpreter.ts — Async parallel vision sub-agent
 *
 * Runs image interpretation on a side-thread (like /btw).
 * The main agent never switches models. Instead:
 *
 * 1. Image comes in with user message
 * 2. Vision interpreter starts async — calls a vision model to describe the image
 * 3. Main agent gets the text message immediately and starts working
 * 4. When vision result arrives, it's injected into the conversation as a system message
 * 5. If the main agent is waiting on image context, it picks it up and continues
 *
 * The vision interpreter is a fire-and-forget sub-agent.
 */

import { findVisionModel, type VisionModel } from "./vision-router";

interface VisionInterpretation {
  description: string;
  model: string;
  provider: string;
  durationMs: number;
  free: boolean;
}

interface PendingVision {
  promise: Promise<VisionInterpretation>;
  status: "pending" | "done" | "error";
  result?: VisionInterpretation;
  error?: string;
  startedAt: number;
}

/**
 * Call a vision model to interpret an image.
 * Works with both Ollama and OpenRouter vision models.
 */
async function callVisionModel(
  model: VisionModel,
  imageBase64: string,
  mimeType: string,
  prompt: string,
  apiKey?: string,
): Promise<string> {
  const imageUrl = `data:${mimeType};base64,${imageBase64}`;

  if (model.provider === "ollama") {
    // Ollama vision API
    const res = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model: model.model,
        messages: [
          {
            role: "user",
            content: prompt,
            images: [imageBase64], // Ollama takes raw base64, no data: prefix
          },
        ],
        stream: false,
      }),
    });

    if (!res.ok) throw new Error(`Ollama vision error: ${res.statusText}`);
    const data = await res.json();
    return data.message?.content || "";
  } else {
    // OpenRouter / OpenAI-compatible vision API
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
      headers["HTTP-Referer"] = "https://8gent.app";
      headers["X-Title"] = "8gent-vision";
    }

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model: model.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        max_tokens: 1024,
      }),
    });

    if (!res.ok) throw new Error(`OpenRouter vision error: ${res.statusText}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }
}

const VISION_PROMPT = `Describe this image in detail for a coding agent. Focus on:
- If it's a screenshot of code: transcribe the code, note the language, highlight errors or key patterns
- If it's a UI screenshot: describe the layout, components, colors, text content, and any issues
- If it's a diagram/architecture: describe the structure, connections, and labels
- If it's an error message: transcribe it exactly
- If it's a design mockup: describe elements, spacing, typography, and interactions
Be precise and technical. The coding agent needs actionable details, not artistic descriptions.`;

/**
 * VisionInterpreter — async parallel image interpretation
 *
 * Usage:
 *   const vi = new VisionInterpreter(apiKey);
 *   const id = vi.interpret(base64, "image/png");  // fire-and-forget
 *   // ... main agent works ...
 *   const result = await vi.waitFor(id);  // blocks only if needed
 *   // or
 *   const result = vi.getIfReady(id);  // non-blocking check
 */
export class VisionInterpreter {
  private pending = new Map<string, PendingVision>();
  private apiKey?: string;
  private onResult?: (id: string, result: VisionInterpretation) => void;

  constructor(options?: { apiKey?: string; onResult?: (id: string, result: VisionInterpretation) => void }) {
    this.apiKey = options?.apiKey || process.env.OPENROUTER_API_KEY;
    this.onResult = options?.onResult;
  }

  /**
   * Start interpreting an image asynchronously.
   * Returns an ID to check/wait for the result.
   */
  interpret(imageBase64: string, mimeType = "image/png", customPrompt?: string): string {
    const id = `vision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();

    const promise = (async (): Promise<VisionInterpretation> => {
      // Find best vision model
      const { found, model, error } = await findVisionModel({
        openRouterApiKey: this.apiKey,
      });

      if (!found || !model) {
        throw new Error(error || "No vision model available");
      }

      // Call the vision model
      const description = await callVisionModel(
        model,
        imageBase64,
        mimeType,
        customPrompt || VISION_PROMPT,
        this.apiKey,
      );

      return {
        description,
        model: model.model,
        provider: model.provider,
        durationMs: Date.now() - startedAt,
        free: model.free,
      };
    })();

    const entry: PendingVision = { promise, status: "pending", startedAt };

    // When done, update status and fire callback
    promise
      .then((result) => {
        entry.status = "done";
        entry.result = result;
        this.onResult?.(id, result);
      })
      .catch((err) => {
        entry.status = "error";
        entry.error = err instanceof Error ? err.message : String(err);
      });

    this.pending.set(id, entry);
    return id;
  }

  /**
   * Wait for a specific interpretation to complete.
   * Blocks until result is ready.
   */
  async waitFor(id: string): Promise<VisionInterpretation | null> {
    const entry = this.pending.get(id);
    if (!entry) return null;

    try {
      return await entry.promise;
    } catch {
      return null;
    }
  }

  /**
   * Non-blocking check — returns result if ready, null if still pending.
   */
  getIfReady(id: string): VisionInterpretation | null {
    const entry = this.pending.get(id);
    if (!entry || entry.status !== "done") return null;
    return entry.result || null;
  }

  /**
   * Check if an interpretation is still running.
   */
  isPending(id: string): boolean {
    const entry = this.pending.get(id);
    return entry?.status === "pending";
  }

  /**
   * Get status of all pending interpretations.
   */
  getStatus(): { pending: number; done: number; error: number } {
    let pending = 0, done = 0, error = 0;
    for (const entry of this.pending.values()) {
      if (entry.status === "pending") pending++;
      else if (entry.status === "done") done++;
      else error++;
    }
    return { pending, done, error };
  }

  /**
   * Clean up completed entries.
   */
  cleanup(): void {
    for (const [id, entry] of this.pending.entries()) {
      if (entry.status !== "pending") this.pending.delete(id);
    }
  }
}

export type { VisionInterpretation, PendingVision };
