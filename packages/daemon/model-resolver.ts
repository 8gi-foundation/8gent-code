/**
 * Model Resolver - Auto-selects the best free model from OpenRouter.
 *
 * Queries the OpenRouter API on startup, filters for free models,
 * ranks by context length and capability, and returns the best pick.
 */

interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
  };
  top_provider?: {
    max_completion_tokens?: number;
  };
}

interface ResolvedModel {
  id: string;
  name: string;
  contextLength: number;
  free: boolean;
}

/** Keywords that suggest coding capability (ranked) */
const CODING_KEYWORDS = ["coder", "code", "dev", "instruct", "chat"];

/** Models to avoid (known bad for agentic use) */
const BLOCKLIST = ["openrouter/free", "openrouter/auto"];

/**
 * Query OpenRouter API and return the best free model.
 * Falls back to cheapest model if no free models exist.
 */
export async function resolveBestFreeModel(apiKey?: string): Promise<ResolvedModel> {
  const headers: Record<string, string> = {
    "HTTP-Referer": "https://8gent.dev",
    "X-Title": "8gent Daemon",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  let models: OpenRouterModel[];
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", { headers });
    if (!res.ok) {
      throw new Error(`OpenRouter API returned ${res.status}`);
    }
    const data = await res.json();
    models = data.data || [];
  } catch (err) {
    console.error("[model-resolver] failed to fetch models:", err);
    // Hardcoded fallback if API is unreachable
    return {
      id: "nvidia/nemotron-3-super-120b-a12b:free",
      name: "Nemotron 3 Super 120B (fallback)",
      contextLength: 32768,
      free: true,
    };
  }

  // Filter for free models
  const freeModels = models.filter((m) => {
    if (BLOCKLIST.includes(m.id)) return false;
    return m.pricing?.prompt === "0" && m.pricing?.completion === "0";
  });

  if (freeModels.length === 0) {
    console.warn("[model-resolver] no free models found, using cheapest");
    // Sort by prompt price and pick cheapest
    const sorted = models
      .filter((m) => !BLOCKLIST.includes(m.id) && m.pricing?.prompt)
      .sort((a, b) => parseFloat(a.pricing.prompt) - parseFloat(b.pricing.prompt));

    const cheapest = sorted[0];
    if (cheapest) {
      return {
        id: cheapest.id,
        name: cheapest.name,
        contextLength: cheapest.context_length || 4096,
        free: false,
      };
    }

    // Absolute fallback
    return {
      id: "nvidia/nemotron-3-super-120b-a12b:free",
      name: "Nemotron 3 Super 120B (fallback)",
      contextLength: 32768,
      free: true,
    };
  }

  // Score and rank free models
  const scored = freeModels.map((m) => {
    let score = 0;

    // Prefer larger context windows (normalized to 0-40 range)
    score += Math.min((m.context_length || 0) / 4096, 40);

    // Prefer coding-capable models
    const idLower = m.id.toLowerCase();
    const nameLower = (m.name || "").toLowerCase();
    for (const kw of CODING_KEYWORDS) {
      if (idLower.includes(kw) || nameLower.includes(kw)) {
        score += 20;
        break;
      }
    }

    // Prefer larger models (param count heuristic from ID)
    const paramMatch = m.id.match(/(\d+)b/i);
    if (paramMatch) {
      const params = parseInt(paramMatch[1], 10);
      score += Math.min(params / 10, 15); // Cap at 15 points
    }

    // Prefer models with higher max completion tokens
    if (m.top_provider?.max_completion_tokens) {
      score += Math.min(m.top_provider.max_completion_tokens / 1000, 10);
    }

    return { model: m, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Log top 5 candidates
  console.log("[model-resolver] top free models:");
  for (const { model, score } of scored.slice(0, 5)) {
    console.log(`  ${score.toFixed(1)} - ${model.id} (ctx: ${model.context_length})`);
  }

  // Try top candidates until one actually responds
  for (const { model } of scored.slice(0, 5)) {
    const works = await probeModel(model.id, apiKey);
    if (works) {
      return {
        id: model.id,
        name: model.name || model.id,
        contextLength: model.context_length || 4096,
        free: true,
      };
    }
    console.log(`[model-resolver] ${model.id} failed probe, trying next...`);
  }

  // None of the top 5 responded - use the highest scored anyway
  const best = scored[0].model;
  console.warn(`[model-resolver] no model passed probe, using ${best.id} anyway`);
  return {
    id: best.id,
    name: best.name || best.id,
    contextLength: best.context_length || 4096,
    free: true,
  };
}

/** Send a tiny test prompt to verify a model is actually responding */
async function probeModel(modelId: string, apiKey?: string): Promise<boolean> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey || ""}`,
        "HTTP-Referer": "https://8gent.dev",
        "X-Title": "8gent Daemon",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Say OK" }],
        max_tokens: 5,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.log(`[model-resolver] probe ${modelId}: ${res.status} ${body.slice(0, 100)}`);
      return false;
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    console.log(`[model-resolver] probe ${modelId}: OK ("${content.slice(0, 20)}")`);
    return true;
  } catch (err) {
    console.log(`[model-resolver] probe ${modelId}: error ${err}`);
    return false;
  }
}
