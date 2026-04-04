/**
 * Pick a sensible default chat model from provider lists (avoid embedding / rerank models).
 */

/** Heuristic: model id is probably an embedding or rerank model, not for chat completions. */
export function isLikelyEmbeddingModelId(id: string): boolean {
  const s = id.toLowerCase();
  if (/\brerank\b/.test(s)) return true;
  if (/\btext-embedding\b/.test(s)) return true;
  if (/\bsentence-transformers\b/.test(s)) return true;
  if (/^nomic-embed|^bge-|^mxbai-embed|^jina-embed|^e5-|multilingual-e5|all-minilm|snowflake-arctic-embed/.test(s)) {
    return true;
  }
  if (/\bembedding\b/.test(s)) return true;
  if (/\bembed\b/.test(s) && !/\bembedd?ed\b/.test(s)) return true;
  return false;
}

function scoreChatModelCandidate(id: string): number {
  if (isLikelyEmbeddingModelId(id)) return -1e9;
  const s = id.toLowerCase();
  let score = 10;
  if (s.startsWith("eight")) score += 500;
  if (/\b(instruct|chat)\b/.test(s) || /(?:^|[-_/])(it|instruct)(?:$|[-_/])/i.test(id)) {
    score += 80;
  }
  const sizeMatch = s.match(/(\d{1,3})b\b/);
  if (sizeMatch) score += Math.min(parseInt(sizeMatch[1], 10), 120);
  if (/\b(0\.5b|1b|2b|3b)\b/.test(s) && !/\b(30|32|70|72)\b/.test(s)) score -= 15;
  return score;
}

/**
 * Prefer a non-embedding model; optional `preference` does exact, substring, then fuzzy match.
 */
export function pickBestChatModel(
  modelIds: string[],
  opts?: { preference?: string },
): string {
  if (modelIds.length === 0) return "";
  const unique = [...new Set(modelIds.map((x) => x.trim()).filter(Boolean))];
  const chatOnly = unique.filter((id) => !isLikelyEmbeddingModelId(id));
  const pool = chatOnly.length > 0 ? chatOnly : unique;

  const want = opts?.preference?.trim();
  if (want) {
    const lo = want.toLowerCase();
    const exact = pool.find((id) => id === want);
    if (exact) return exact;
    const exactLo = pool.find((id) => id.toLowerCase() === lo);
    if (exactLo) return exactLo;
    const sub = pool.find(
      (id) =>
        id.toLowerCase().includes(lo) ||
        lo.replace(/[-_:]/g, "").includes(id.toLowerCase().replace(/[-_:./]/g, "")),
    );
    if (sub) return sub;
    const norm = (s: string) => s.toLowerCase().replace(/[-_:./]/g, "");
    const nLo = norm(lo);
    const fuzzy = pool.find((id) => {
      const n = norm(id);
      return n.includes(nLo) || nLo.includes(n);
    });
    if (fuzzy) return fuzzy;
  }

  const scored = pool.map((id) => ({ id, score: scoreChatModelCandidate(id) }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.id || pool[0] || "";
}

/** Map CLI / saved provider strings to internal provider ids. */
export function normalizeProviderId(raw?: string): string | undefined {
  if (!raw?.trim()) return undefined;
  const x = raw.trim().toLowerCase().replace(/_/g, "-");
  const compact = x.replace(/-/g, "");
  if (x === "lmstudio" || x === "lm-studio" || compact === "lmstudio") return "lmstudio";
  if (x === "ollama") return "ollama";
  if (x === "openrouter-free" || compact === "openrouterfree") return "openrouter-free";
  if (x === "openrouter") return "openrouter";
  if (x === "groq") return "groq";
  if (x === "openai") return "openai";
  if (x === "anthropic") return "anthropic";
  if (x === "mistral") return "mistral";
  return undefined;
}
