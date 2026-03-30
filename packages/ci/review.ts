/**
 * 8gent CI Review - AI code review. Ollama local, OpenRouter fallback.
 */
const REVIEW_PROMPT = `You are a code reviewer. Analyze this diff for:
1. Bugs or logic errors  2. Security issues  3. Style problems
Output a flat list. Each item: [ERROR|WARNING|INFO] file:line - description
If no issues, say "No issues found." No preamble.`;

async function tryOllama(diff: string): Promise<string | null> {
  try {
    const tags = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
    const data = (await tags.json()) as any;
    const models = (data.models || []).map((m: any) => m.name as string);
    const model = models.find((m: string) => m.startsWith("eight")) || models.find((m: string) => !m.includes("embed")) || models[0];
    if (!model) return null;
    const res = await fetch("http://localhost:11434/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: REVIEW_PROMPT }, { role: "user", content: diff }], stream: false }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as any).message?.content || null;
  } catch { return null; }
}

async function tryOpenRouter(diff: string): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://8gent.dev", "X-Title": "8gent Code Review" },
      body: JSON.stringify({ model: "meta-llama/llama-4-scout:free", messages: [{ role: "system", content: REVIEW_PROMPT }, { role: "user", content: diff.slice(0, 24000) }] }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as any).choices?.[0]?.message?.content || null;
  } catch { return null; }
}

export async function reviewDiff(diff: string): Promise<string> {
  if (!diff.trim()) return "No changes to review.";
  const result = (await tryOllama(diff)) || (await tryOpenRouter(diff));
  return result || "Review unavailable - no Ollama model or OPENROUTER_API_KEY found.";
}
