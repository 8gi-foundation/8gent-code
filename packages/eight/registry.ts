/**
 * Model registry for the 8gent Computer build.
 *
 * Each entry describes one model: which provider runs it, what it can do
 * (text/vision/tool-calling), how big its context window is, and which
 * daemon channel it's the default for.
 *
 * The registry is consumed by the failover chain (see
 * `packages/providers/failover.ts`) and by the role config so that a single
 * change here propagates to every surface that resolves a model.
 */

export type ModelCapability = "text" | "vision" | "tool-calling" | "streaming";

export type ModelChannel = "text" | "computer";

export interface ModelEntry {
  /** Canonical model identifier as passed to the provider. */
  id: string;
  /** Human-readable label for UI. */
  label: string;
  /** Provider name from `packages/providers` registry. */
  provider:
    | "8gent"
    | "ollama"
    | "lmstudio"
    | "apple-foundation"
    | "apfel"
    | "deepseek"
    | "openrouter";
  /** Maximum context window in tokens. */
  context: number;
  /** Capabilities the model supports. */
  capabilities: ModelCapability[];
  /** Channels this model is the default for, if any. */
  defaultForChannel?: ModelChannel[];
  /** Optional tier hint used by failover ordering. */
  tier?: "chat" | "vision-tool" | "heavy-cloud" | "free-fallback";
  /** Notes for docs / install hints. */
  notes?: string;
}

export const MODELS: ModelEntry[] = [
  // Chat tier: Apple Foundation via apfel.
  {
    id: "apple-foundation-system",
    label: "Apple Foundation (apfel)",
    provider: "apfel",
    context: 8192,
    capabilities: ["text", "streaming"],
    tier: "chat",
    notes:
      "Apple Silicon, macOS 26 Tahoe+. No vision. Run apfel on port 11500 to " +
      "avoid colliding with Ollama on 11434.",
  },

  // Vision/tool tier: Qwen 3.6-27B (DEFAULT for the computer channel).
  {
    id: "qwen3.6:27b",
    label: "Qwen 3.6-27B (vision/tool, default)",
    provider: "ollama",
    context: 125_000,
    capabilities: ["text", "vision", "tool-calling", "streaming"],
    defaultForChannel: ["computer"],
    tier: "vision-tool",
    notes:
      "Apache 2.0, dense vision-language, ~21 GB at Q4_K_M. " +
      "Needs Ollama 0.6.2+ or LM Studio 0.4.12+. " +
      "24 GB VRAM or 32 GB unified memory recommended.",
  },

  // Heavy cloud fallback: DeepSeek V4-Flash.
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4-Flash",
    provider: "deepseek",
    context: 1_000_000,
    capabilities: ["text", "tool-calling", "streaming"],
    tier: "heavy-cloud",
    notes: "284B/13B MoE, MIT, 1M context. Requires DEEPSEEK_API_KEY.",
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4-Pro",
    provider: "deepseek",
    context: 1_000_000,
    capabilities: ["text", "tool-calling", "streaming"],
    notes:
      "1.6T/49B MoE. Flagged-only via DEEPSEEK_USE_PRO=1 to keep the default " +
      "tier predictable.",
  },

  // Existing local default for the text channel: kept for back-compat.
  {
    id: "eight-1.0-q3:14b",
    label: "8gent 1.0 Q3 (14B)",
    provider: "8gent",
    context: 32_000,
    capabilities: ["text", "tool-calling", "streaming"],
    defaultForChannel: ["text"],
    tier: "vision-tool",
  },

  // Free-tier last-resort fallback.
  {
    id: "meta-llama/llama-3-8b-instruct:free",
    label: "Llama 3 8B Instruct (OpenRouter free)",
    provider: "openrouter",
    context: 8_000,
    capabilities: ["text", "streaming"],
    tier: "free-fallback",
  },
];

export function getModel(id: string): ModelEntry | undefined {
  return MODELS.find((m) => m.id === id);
}

export function defaultModelForChannel(channel: ModelChannel): ModelEntry {
  const found = MODELS.find((m) => m.defaultForChannel?.includes(channel));
  if (!found) {
    throw new Error(`No default model registered for channel "${channel}"`);
  }
  return found;
}

export function modelsByCapability(cap: ModelCapability): ModelEntry[] {
  return MODELS.filter((m) => m.capabilities.includes(cap));
}
