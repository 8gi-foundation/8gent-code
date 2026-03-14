/**
 * vision-router.ts — Auto-discover the best available vision model
 *
 * Pipeline:
 * 1. Check local Ollama for vision-capable models (llava, moondream, llama3.2-vision, etc.)
 * 2. Check OpenRouter for free vision models
 * 3. Check OpenRouter for cheapest paid vision models
 * 4. Never fail — always return a model or a clear error
 */

// Known vision-capable model families (Ollama)
const OLLAMA_VISION_MODELS = [
  "llava",
  "llava-llama3",
  "llava-phi3",
  "moondream",
  "bakllava",
  "llama3.2-vision",
  "minicpm-v",
  "nanollava",
];

interface VisionModel {
  provider: "ollama" | "openrouter";
  model: string;
  displayName: string;
  free: boolean;
}

interface VisionRouterResult {
  found: boolean;
  model: VisionModel | null;
  allAvailable: VisionModel[];
  error?: string;
}

/**
 * Check Ollama for locally installed vision models
 */
async function checkOllamaVision(baseUrl = "http://localhost:11434"): Promise<VisionModel[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];

    const data = await res.json();
    const models = (data.models || []) as Array<{ name: string }>;

    return models
      .filter((m) => {
        const name = m.name.toLowerCase().split(":")[0];
        return OLLAMA_VISION_MODELS.some((v) => name.includes(v));
      })
      .map((m) => ({
        provider: "ollama" as const,
        model: m.name,
        displayName: `${m.name} (local)`,
        free: true,
      }));
  } catch {
    return [];
  }
}

/**
 * Check OpenRouter for free vision-capable models
 */
async function checkOpenRouterVision(apiKey?: string): Promise<VisionModel[]> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];

    const data = await res.json();
    const models = (data.data || []) as Array<{
      id: string;
      name?: string;
      architecture?: { modality?: string; input_modalities?: string[] };
      pricing?: { prompt?: string; completion?: string };
    }>;

    const visionModels: VisionModel[] = [];

    for (const m of models) {
      // Check if model supports image input
      const hasVision =
        m.architecture?.modality?.includes("image") ||
        m.architecture?.input_modalities?.includes("image") ||
        // Fallback: check common vision model name patterns
        /vision|llava|pixtral|moondream|gpt-4o|claude.*sonnet|gemini/i.test(m.id);

      if (!hasVision) continue;

      const isFree = m.id.endsWith(":free") ||
        (m.pricing?.prompt === "0" && m.pricing?.completion === "0");

      visionModels.push({
        provider: "openrouter",
        model: m.id,
        displayName: m.name || m.id,
        free: isFree,
      });
    }

    // Sort: free first, then by name
    return visionModels.sort((a, b) => {
      if (a.free && !b.free) return -1;
      if (!a.free && b.free) return 1;
      return a.model.localeCompare(b.model);
    });
  } catch {
    return [];
  }
}

/**
 * Find the best available vision model.
 *
 * Priority:
 * 1. Local Ollama vision model (free, fast, private)
 * 2. OpenRouter free vision model
 * 3. OpenRouter cheapest paid vision model
 */
export async function findVisionModel(options?: {
  ollamaUrl?: string;
  openRouterApiKey?: string;
  preferLocal?: boolean;
}): Promise<VisionRouterResult> {
  const ollamaUrl = options?.ollamaUrl || "http://localhost:11434";
  const apiKey = options?.openRouterApiKey || process.env.OPENROUTER_API_KEY;
  const preferLocal = options?.preferLocal !== false;

  const allAvailable: VisionModel[] = [];

  // Step 1: Check local Ollama
  const ollamaModels = await checkOllamaVision(ollamaUrl);
  allAvailable.push(...ollamaModels);

  if (preferLocal && ollamaModels.length > 0) {
    return {
      found: true,
      model: ollamaModels[0],
      allAvailable,
    };
  }

  // Step 2: Check OpenRouter
  if (apiKey) {
    const orModels = await checkOpenRouterVision(apiKey);
    allAvailable.push(...orModels);

    // Prefer free models
    const freeVision = orModels.filter((m) => m.free);
    if (freeVision.length > 0) {
      return {
        found: true,
        model: ollamaModels[0] || freeVision[0], // Still prefer local if available
        allAvailable,
      };
    }

    // Fall back to cheapest paid
    if (orModels.length > 0) {
      return {
        found: true,
        model: ollamaModels[0] || orModels[0],
        allAvailable,
      };
    }
  }

  // Step 3: No API key, no local models
  if (ollamaModels.length > 0) {
    return { found: true, model: ollamaModels[0], allAvailable };
  }

  return {
    found: false,
    model: null,
    allAvailable,
    error: allAvailable.length === 0
      ? "No vision models found. Pull one locally: `ollama pull llava` or set OPENROUTER_API_KEY for cloud vision."
      : "Vision models found but none are free. Set OPENROUTER_API_KEY or pull a local model: `ollama pull moondream`",
  };
}

/**
 * Quick check — is any vision model available?
 */
export async function hasVisionSupport(options?: {
  ollamaUrl?: string;
  openRouterApiKey?: string;
}): Promise<boolean> {
  const result = await findVisionModel(options);
  return result.found;
}

export type { VisionModel, VisionRouterResult };
