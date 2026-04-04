/**
 * vision-router.ts — Auto-discover the best available vision model
 *
 * Pipeline:
 * 1. If user has configured a preferred model in .8gent/config.json → use it
 * 2. Check local Ollama for OCR-specialized models (dots.ocr, deepseek-ocr, glm-ocr, etc.)
 * 3. Check local Ollama for vision-capable models (qwen2.5-vl, llava, moondream, etc.)
 * 4. Check OpenRouter for free vision models
 * 5. Check OpenRouter for cheapest paid vision models
 * 6. Never fail — always return a model or a clear error
 */

import * as fs from "fs";
import * as path from "path";

// Known vision-capable model families (Ollama) — general vision
const OLLAMA_VISION_MODELS = [
  "llava",
  "llava-llama3",
  "llava-phi3",
  "moondream",
  "bakllava",
  "llama3.2-vision",
  "minicpm-v",
  "nanollava",
  "qwen2.5-vl",
  "smolvlm2",
  "internvl2",
  // Gemma multimodal (Ollama tags often look like gemma3:latest, google/gemma-3-*, etc.)
  "gemma3",
  "gemma-3",
  "gemma4",
  "gemma-4",
  "gemma2",
  "gemma-2",
];

// OCR-specialized models (Ollama) — preferred for text extraction tasks
// Ordered by quality: best first
const OLLAMA_OCR_MODELS = [
  "dots.ocr",       // rednote-hilab — 3B, SOTA multilingual OCR (83.9 on olmOCR-bench)
  "dots.ocr-1.5",   // dots.ocr v1.5 — all human scripts + symbols
  "deepseek-ocr",   // DeepSeek — vision-language OCR
  "glm-ocr",        // GLM — 0.9B, fast multimodal document understanding
  "ocrflux",        // OCRFlux — 3B, cross-page table/paragraph merging
  "lightonocr-2",   // LightOnOCR-2 — claims 5x faster than dots.ocr
  "paddleocr-vl",   // PaddleOCR-VL — 0.9B, 109 languages, 92.6 on OmniDocBench
];

// General vision models that also have strong OCR capability (fallback for OCR tasks)
const VISION_MODELS_WITH_OCR = [
  "qwen2.5-vl",
  "minicpm-v",
  "internvl2",
  "llama3.2-vision",
];

export type VisionTaskType = "general" | "ocr";

/**
 * User-configurable vision settings from .8gent/config.json
 */
export interface VisionConfig {
  enabled: boolean;
  preferLocal: boolean;
  defaultModel: string;
  ocrModel: string; // "auto" = auto-discover, or a specific model name
  fallback: string[];
  ocrFallback: string[];
  provider: "ollama" | "openrouter" | "auto";
  timeout: number;
}

const DEFAULT_VISION_CONFIG: VisionConfig = {
  enabled: true,
  preferLocal: true,
  defaultModel: "qwen2.5-vl:latest",
  ocrModel: "auto",
  fallback: ["minicpm-v:latest", "llava:latest", "moondream:latest"],
  ocrFallback: ["deepseek-ocr:latest", "glm-ocr:latest", "dots.ocr:latest"],
  provider: "ollama",
  timeout: 60000,
};

/**
 * Load vision config from .8gent/config.json.
 * Falls back to sensible defaults (Qwen2.5-VL as general, auto-discover for OCR).
 */
export function loadVisionConfig(projectDir?: string): VisionConfig {
  const candidates = [
    projectDir ? path.join(projectDir, ".8gent", "config.json") : null,
    path.join(process.cwd(), ".8gent", "config.json"),
    path.join(process.env.HOME || "", ".8gent", "config.json"),
  ].filter(Boolean) as string[];

  for (const configPath of candidates) {
    try {
      if (fs.existsSync(configPath)) {
        const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (data.vision) {
          return { ...DEFAULT_VISION_CONFIG, ...data.vision };
        }
      }
    } catch {
      // Config parse error — use defaults
    }
  }

  return DEFAULT_VISION_CONFIG;
}

/**
 * Save vision config back to .8gent/config.json
 */
export function saveVisionConfig(config: Partial<VisionConfig>, projectDir?: string): boolean {
  const configPath = path.join(projectDir || process.cwd(), ".8gent", "config.json");
  try {
    let data: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
    data.vision = { ...(data.vision as object || {}), ...config };
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

interface VisionModel {
  provider: "ollama" | "openrouter";
  model: string;
  displayName: string;
  free: boolean;
  ocrSpecialized?: boolean;
}

interface VisionRouterResult {
  found: boolean;
  model: VisionModel | null;
  allAvailable: VisionModel[];
  error?: string;
}

/**
 * Check if a specific model is installed on Ollama.
 * Used to validate user-configured preferred models.
 */
async function checkOllamaModel(baseUrl: string, modelName: string): Promise<VisionModel | null> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;

    const data = await res.json();
    const models = (data.models || []) as Array<{ name: string }>;
    const baseName = modelName.split(":")[0].toLowerCase();

    const match = models.find((m) => {
      const name = m.name.toLowerCase();
      return name === modelName.toLowerCase() || name.split(":")[0] === baseName;
    });

    if (!match) return null;

    const isOcr = OLLAMA_OCR_MODELS.some((v) => baseName.includes(v));
    return {
      provider: "ollama",
      model: match.name,
      displayName: `${match.name} (local${isOcr ? " OCR" : ""})`,
      free: true,
      ocrSpecialized: isOcr,
    };
  } catch {
    return null;
  }
}

/**
 * Check Ollama for locally installed vision models.
 * Separates OCR-specialized models from general vision models.
 */
async function checkOllamaVision(baseUrl = "http://localhost:11434"): Promise<VisionModel[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];

    const data = await res.json();
    const models = (data.models || []) as Array<{ name: string }>;
    const results: VisionModel[] = [];

    for (const m of models) {
      const name = m.name.toLowerCase().split(":")[0];

      // Check OCR-specialized models first
      const isOcr = OLLAMA_OCR_MODELS.some((v) => name.includes(v));
      if (isOcr) {
        results.push({
          provider: "ollama",
          model: m.name,
          displayName: `${m.name} (local OCR)`,
          free: true,
          ocrSpecialized: true,
        });
        continue;
      }

      // Check general vision models
      const isVision = OLLAMA_VISION_MODELS.some((v) => name.includes(v));
      if (isVision) {
        results.push({
          provider: "ollama",
          model: m.name,
          displayName: `${m.name} (local)`,
          free: true,
          ocrSpecialized: false,
        });
      }
    }

    return results;
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
        /vision|llava|pixtral|moondream|gpt-4o|claude.*sonnet|gemini|gemma/i.test(m.id);

      if (!hasVision) continue;

      const isFree = m.id.endsWith(":free") ||
        (m.pricing?.prompt === "0" && m.pricing?.completion === "0");

      // Check if this is an OCR-specialized model on OpenRouter
      const isOcr = /ocr|dots\.ocr|document-parse/i.test(m.id) ||
        /ocr|dots\.ocr|document-parse/i.test(m.name || "");

      visionModels.push({
        provider: "openrouter",
        model: m.id,
        displayName: m.name || m.id,
        free: isFree,
        ocrSpecialized: isOcr,
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
 * 0. User-configured model in .8gent/config.json (if set and available)
 * 1. Local Ollama vision model (free, fast, private)
 * 2. User-configured fallback chain
 * 3. OpenRouter free vision model
 * 4. OpenRouter cheapest paid vision model
 */
export async function findVisionModel(options?: {
  ollamaUrl?: string;
  openRouterApiKey?: string;
  preferLocal?: boolean;
  taskType?: VisionTaskType;
  config?: VisionConfig;
}): Promise<VisionRouterResult> {
  const config = options?.config || loadVisionConfig();
  const ollamaUrl = options?.ollamaUrl || "http://localhost:11434";
  const apiKey = options?.openRouterApiKey || process.env.OPENROUTER_API_KEY;
  const preferLocal = options?.preferLocal ?? config.preferLocal;
  const taskType = options?.taskType || "general";

  if (!config.enabled) {
    return { found: false, model: null, allAvailable: [], error: "Vision is disabled in config. Enable with /vision on" };
  }

  const allAvailable: VisionModel[] = [];

  // Step 0: Check user-configured preferred model first
  const preferredModel = taskType === "ocr" && config.ocrModel !== "auto"
    ? config.ocrModel
    : config.defaultModel;

  if (preferredModel && preferLocal) {
    const configured = await checkOllamaModel(ollamaUrl, preferredModel);
    if (configured) {
      allAvailable.push(configured);
      return { found: true, model: configured, allAvailable };
    }
  }

  // Step 1: Check local Ollama (auto-discover)
  const ollamaModels = await checkOllamaVision(ollamaUrl);
  allAvailable.push(...ollamaModels);

  if (preferLocal && ollamaModels.length > 0) {
    const best = pickBestModel(ollamaModels, taskType);
    return { found: true, model: best, allAvailable };
  }

  // Step 1.5: Check user-configured fallback chain
  const fallbackList = taskType === "ocr" ? config.ocrFallback : config.fallback;
  for (const fallbackModel of fallbackList) {
    const fb = await checkOllamaModel(ollamaUrl, fallbackModel);
    if (fb) {
      allAvailable.push(fb);
      return { found: true, model: fb, allAvailable };
    }
  }

  // Step 2: Check OpenRouter (works with or without API key for free models)
  const orModels = await checkOpenRouterVision(apiKey);
  allAvailable.push(...orModels);

  // Prefer free OpenRouter models (no API key needed for :free models)
  const freeVision = orModels.filter((m) => m.free);
  if (freeVision.length > 0) {
    const localBest = ollamaModels.length > 0 ? pickBestModel(ollamaModels, taskType) : null;
    const remoteBest = pickBestModel(freeVision, taskType);
    return {
      found: true,
      model: localBest || remoteBest, // Still prefer local if available
      allAvailable,
    };
  }

  // Fall back to cheapest paid (requires API key)
  if (apiKey && orModels.length > 0) {
    const localBest = ollamaModels.length > 0 ? pickBestModel(ollamaModels, taskType) : null;
    const remoteBest = pickBestModel(orModels, taskType);
    return {
      found: true,
      model: localBest || remoteBest,
      allAvailable,
    };
  }

  // Step 3: No API key, no local models
  if (ollamaModels.length > 0) {
    const best = pickBestModel(ollamaModels, taskType);
    return { found: true, model: best, allAvailable };
  }

  return {
    found: false,
    model: null,
    allAvailable,
    error: allAvailable.length === 0
      ? "No vision models found. Pull one locally: `ollama pull deepseek-ocr` (for OCR) or `ollama pull llava` (general vision), or set OPENROUTER_API_KEY for cloud vision."
      : "Vision models found but none are free. Set OPENROUTER_API_KEY or pull a local model: `ollama pull deepseek-ocr`",
  };
}

/**
 * Find the best available OCR model specifically.
 * Shorthand for findVisionModel({ taskType: "ocr" }).
 *
 * Priority:
 * 1. Local OCR-specialized model (dots.ocr, deepseek-ocr, glm-ocr)
 * 2. Local general vision model with strong OCR (qwen2.5-vl, minicpm-v)
 * 3. OpenRouter OCR/vision model
 */
export async function findOCRModel(options?: {
  ollamaUrl?: string;
  openRouterApiKey?: string;
}): Promise<VisionRouterResult> {
  return findVisionModel({
    ...options,
    taskType: "ocr",
    preferLocal: true,
  });
}

/**
 * Pick the best model from a list based on task type.
 * For OCR tasks: prefer OCR-specialized models, then vision models with strong OCR.
 * For general tasks: prefer general vision models (broader capabilities).
 */
function pickBestModel(models: VisionModel[], taskType: VisionTaskType): VisionModel {
  if (taskType === "ocr") {
    // First: OCR-specialized models
    const ocrModels = models.filter((m) => m.ocrSpecialized);
    if (ocrModels.length > 0) return ocrModels[0];

    // Second: general vision models known to have strong OCR
    const strongOcr = models.filter((m) => {
      const name = m.model.toLowerCase().split(":")[0];
      return VISION_MODELS_WITH_OCR.some((v) => name.includes(v));
    });
    if (strongOcr.length > 0) return strongOcr[0];

    // Fallback: any model
    return models[0];
  }

  // For general vision tasks, prefer non-OCR models (broader capabilities)
  const generalModels = models.filter((m) => !m.ocrSpecialized);
  if (generalModels.length > 0) return generalModels[0];
  return models[0];
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

/**
 * List all recommended OCR models for `ollama pull` suggestions.
 */
export function getRecommendedOCRModels(): Array<{ model: string; description: string; size: string }> {
  return [
    { model: "deepseek-ocr", description: "DeepSeek vision-language OCR", size: "~2GB" },
    { model: "glm-ocr", description: "GLM multimodal document understanding (fastest)", size: "~1GB" },
    { model: "dots.ocr", description: "SOTA multilingual OCR — 83.9 on olmOCR-bench", size: "~3GB" },
    { model: "qwen2.5-vl", description: "General vision + strong OCR (native resolution)", size: "~5GB" },
    { model: "minicpm-v", description: "Mobile-friendly vision + OCR", size: "~5GB" },
  ];
}

export type { VisionModel, VisionRouterResult };
