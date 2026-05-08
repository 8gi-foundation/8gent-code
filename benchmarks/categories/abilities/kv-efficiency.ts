// -- KV Cache Efficiency Baseline Benchmark ------------------------------------
// Measures token throughput at varying context lengths against Ollama.
// Run: bun run benchmarks/categories/abilities/kv-efficiency.ts
// Purpose: establish baseline BEFORE Google's KV compression lands in llama.cpp.

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3:1.7b";

// Context padding prompts at increasing lengths
const CONTEXT_LENGTHS = [512, 1024, 2048, 4096, 8192] as const;

interface Result {
  contextTokens: number;
  firstTokenMs: number;
  totalMs: number;
  outputTokens: number;
  tokensPerSecond: number;
}

function padContext(targetTokens: number): string {
  // ~4 chars per token approximation
  const word = "alpha ";
  const repeats = Math.floor((targetTokens * 4) / word.length);
  return word.repeat(repeats);
}

async function ollamaGenerate(prompt: string): Promise<{
  firstTokenMs: number;
  totalMs: number;
  outputTokens: number;
}> {
  const start = performance.now();
  let firstTokenMs = 0;
  let outputTokens = 0;

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: true,
      options: { num_predict: 64, temperature: 0.1 },
    }),
  });

  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const json = JSON.parse(line);
      if (json.response) {
        if (firstTokenMs === 0) firstTokenMs = performance.now() - start;
        outputTokens++;
      }
    }
  }

  return { firstTokenMs, totalMs: performance.now() - start, outputTokens };
}

async function runBenchmark(): Promise<void> {
  console.log(`\n  KV Cache Efficiency Baseline`);
  console.log(`  Model: ${MODEL}  |  Endpoint: ${OLLAMA_URL}\n`);
  console.log("  Context  | TTFT (ms) | Total (ms) | Tokens | tok/s");
  console.log("  ---------|-----------|------------|--------|------");

  const results: Result[] = [];

  for (const ctx of CONTEXT_LENGTHS) {
    const padding = padContext(ctx);
    const prompt = `${padding}\n\nSummarize the above text in one sentence.`;

    try {
      const { firstTokenMs, totalMs, outputTokens } = await ollamaGenerate(prompt);
      const tokensPerSecond = outputTokens / (totalMs / 1000);

      results.push({
        contextTokens: ctx,
        firstTokenMs,
        totalMs,
        outputTokens,
        tokensPerSecond,
      });

      const ctxStr = String(ctx).padStart(7);
      const ttft = firstTokenMs.toFixed(0).padStart(9);
      const total = totalMs.toFixed(0).padStart(10);
      const toks = String(outputTokens).padStart(6);
      const tps = tokensPerSecond.toFixed(1).padStart(5);
      console.log(`  ${ctxStr} | ${ttft} | ${total} | ${toks} | ${tps}`);
    } catch (e) {
      console.log(`  ${String(ctx).padStart(7)} | FAILED: ${(e as Error).message}`);
    }
  }

  const outPath = `${import.meta.dir}/../../autoresearch/kv-baseline-${Date.now()}.json`;
  await Bun.write(
    outPath,
    JSON.stringify({ model: MODEL, date: new Date().toISOString(), results }, null, 2),
  );
  console.log(`\n  Baseline saved: ${outPath}\n`);
}

runBenchmark().catch(console.error);
