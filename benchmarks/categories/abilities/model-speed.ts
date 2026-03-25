// -- Model Speed Benchmark -----------------------------------------------------
// Measures TTFT (time-to-first-token) and total generation time across models.
// Run: bun run benchmarks/categories/abilities/model-speed.ts
// Export: benchmarkModel() for use by harness or other benchmarks.

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const DEFAULT_MODELS = (process.env.BENCH_MODELS ?? "qwen3:1.7b").split(",").map((m) => m.trim());

// Prompts that vary in complexity and output length
const TEST_PROMPTS = [
  {
    id: "trivial",
    prompt: "Reply with exactly one word: hello",
    expectedOutputTokens: 1,
  },
  {
    id: "short",
    prompt: "What is 2 + 2? Reply with only the number.",
    expectedOutputTokens: 2,
  },
  {
    id: "medium",
    prompt: "List three programming languages in a comma-separated list. No explanation.",
    expectedOutputTokens: 12,
  },
  {
    id: "paragraph",
    prompt: "Write a single paragraph (3-5 sentences) describing what a compiler does.",
    expectedOutputTokens: 60,
  },
  {
    id: "reasoning",
    prompt:
      "A train leaves city A at 60 km/h. Another train leaves city B 150 km away at 90 km/h toward city A. When do they meet? Show your working.",
    expectedOutputTokens: 120,
  },
] as const;

export interface RunResult {
  promptId: string;
  ttftMs: number;
  totalMs: number;
  outputTokens: number;
  tokensPerSec: number;
  error?: string;
}

export interface ModelResult {
  model: string;
  runs: RunResult[];
  stats: {
    medianTtftMs: number;
    p95TtftMs: number;
    medianTotalMs: number;
    p95TotalMs: number;
    medianTokPerSec: number;
    failRate: number;
  };
}

// ---------------------------------------------------------------------------
// Core: stream one generation, return timing + token count
// ---------------------------------------------------------------------------
async function streamGenerate(
  model: string,
  prompt: string,
  maxTokens = 256,
): Promise<{ ttftMs: number; totalMs: number; outputTokens: number }> {
  const start = performance.now();
  let ttftMs = 0;
  let outputTokens = 0;

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: true,
      options: { num_predict: maxTokens, temperature: 0.0 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const dec = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      if (json.response) {
        if (ttftMs === 0) ttftMs = performance.now() - start;
        outputTokens++;
      }
    }
  }

  return { ttftMs, totalMs: performance.now() - start, outputTokens };
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------
function median(vals: number[]): number {
  if (vals.length === 0) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(vals: number[], p: number): number {
  if (vals.length === 0) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ---------------------------------------------------------------------------
// Export: benchmarkModel
// ---------------------------------------------------------------------------
export async function benchmarkModel(model: string, runs = 1): Promise<ModelResult> {
  const allRuns: RunResult[] = [];

  for (const { id, prompt, expectedOutputTokens } of TEST_PROMPTS) {
    for (let r = 0; r < runs; r++) {
      try {
        const { ttftMs, totalMs, outputTokens } = await streamGenerate(
          model,
          prompt,
          expectedOutputTokens * 4,
        );
        const tokensPerSec = outputTokens > 0 ? outputTokens / (totalMs / 1000) : 0;
        allRuns.push({ promptId: id, ttftMs, totalMs, outputTokens, tokensPerSec });
      } catch (e) {
        allRuns.push({
          promptId: id,
          ttftMs: 0,
          totalMs: 0,
          outputTokens: 0,
          tokensPerSec: 0,
          error: (e as Error).message,
        });
      }
    }
  }

  const successful = allRuns.filter((r) => !r.error);
  const failRate = allRuns.length > 0 ? (allRuns.length - successful.length) / allRuns.length : 1;

  const stats: ModelResult["stats"] = {
    medianTtftMs: median(successful.map((r) => r.ttftMs)),
    p95TtftMs: percentile(successful.map((r) => r.ttftMs), 95),
    medianTotalMs: median(successful.map((r) => r.totalMs)),
    p95TotalMs: percentile(successful.map((r) => r.totalMs), 95),
    medianTokPerSec: median(successful.map((r) => r.tokensPerSec)),
    failRate,
  };

  return { model, runs: allRuns, stats };
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const models = DEFAULT_MODELS;
  const runsPerPrompt = parseInt(process.env.BENCH_RUNS ?? "1", 10);

  console.log(`\n  Model Speed Benchmark`);
  console.log(`  Endpoint: ${OLLAMA_URL}  |  Runs per prompt: ${runsPerPrompt}`);
  console.log(`  Models: ${models.join(", ")}\n`);

  const allResults: ModelResult[] = [];

  for (const model of models) {
    console.log(`  Running: ${model} ...`);

    let result: ModelResult;
    try {
      result = await benchmarkModel(model, runsPerPrompt);
    } catch (e) {
      console.log(`  SKIPPED ${model}: ${(e as Error).message}\n`);
      continue;
    }

    allResults.push(result);

    // Per-prompt table
    console.log(`\n  ${model}`);
    console.log("  Prompt      | TTFT (ms) | Total (ms) | Tokens | tok/s");
    console.log("  ------------|-----------|------------|--------|------");

    for (const run of result.runs) {
      if (run.error) {
        console.log(`  ${run.promptId.padEnd(11)} | ERROR: ${run.error}`);
        continue;
      }
      const id = run.promptId.padEnd(11);
      const ttft = run.ttftMs.toFixed(0).padStart(9);
      const total = run.totalMs.toFixed(0).padStart(10);
      const toks = String(run.outputTokens).padStart(6);
      const tps = run.tokensPerSec.toFixed(1).padStart(5);
      console.log(`  ${id} | ${ttft} | ${total} | ${toks} | ${tps}`);
    }

    const s = result.stats;
    console.log(`\n  Stats: TTFT median=${s.medianTtftMs.toFixed(0)}ms p95=${s.p95TtftMs.toFixed(0)}ms`);
    console.log(`         Total median=${s.medianTotalMs.toFixed(0)}ms p95=${s.p95TotalMs.toFixed(0)}ms`);
    console.log(`         tok/s median=${s.medianTokPerSec.toFixed(1)}  fail=${(s.failRate * 100).toFixed(0)}%\n`);
  }

  // Summary comparison if multiple models
  if (allResults.length > 1) {
    console.log("  === Model Comparison ===");
    console.log("  Model                     | TTFT med | Total med | tok/s med | Fail%");
    console.log("  --------------------------|----------|-----------|-----------|------");
    for (const r of allResults) {
      const name = r.model.padEnd(25);
      const ttft = r.stats.medianTtftMs.toFixed(0).padStart(8);
      const total = r.stats.medianTotalMs.toFixed(0).padStart(9);
      const tps = r.stats.medianTokPerSec.toFixed(1).padStart(9);
      const fail = (r.stats.failRate * 100).toFixed(0).padStart(5);
      console.log(`  ${name} | ${ttft} | ${total} | ${tps} | ${fail}%`);
    }
    console.log();
  }

  // Save results
  const outPath = `${import.meta.dir}/../../autoresearch/model-speed-${Date.now()}.json`;
  await Bun.write(
    outPath,
    JSON.stringify(
      { date: new Date().toISOString(), endpoint: OLLAMA_URL, results: allResults },
      null,
      2,
    ),
  );
  console.log(`  Results saved: ${outPath}\n`);
}

main().catch(console.error);
