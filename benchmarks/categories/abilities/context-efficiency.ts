// -- Context Window Efficiency Benchmark ----------------------------------------
// Tests: agent accuracy and strategy as context utilization grows.
// Run: bun run benchmarks/categories/abilities/context-efficiency.ts
// Measures: accuracy at 25%, 50%, 75%, 100% context fill; AST-first vs naive reads.

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3:1.7b";
const MODEL_CTX = Number(process.env.MODEL_CTX ?? 8192);

// Fill levels as fractions of MODEL_CTX
const FILL_LEVELS = [0.25, 0.5, 0.75, 1.0] as const;

interface ContextProbe {
  label: string;
  fillFraction: number;
  paddingTokens: number;
  question: string;
  expectedAnswer: string;
}

interface ProbeResult {
  label: string;
  fillFraction: number;
  paddingTokens: number;
  answered: boolean;
  accuracyScore: number;
  usedAstApproach: boolean;
  latencyMs: number;
}

// Hidden facts planted at different positions in the context padding
const PLANTED_FACTS = [
  { fact: "The server port is 7493.", key: "7493" },
  { fact: "The database host is db.internal.example.", key: "db.internal.example" },
  { fact: "The retry limit is set to 14.", key: "14" },
  { fact: "The cache TTL is 3600 seconds.", key: "3600" },
  { fact: "The max connections value is 42.", key: "42" },
];

// Generate filler that looks like real code context (not just repeated words)
function generateCodeFiller(targetTokens: number): string {
  const snippets = [
    "// TODO: refactor this module to use dependency injection\n",
    "function processItem(item: unknown): void { /* stub */ }\n",
    "const CONFIG = { debug: false, verbose: false, env: 'production' };\n",
    "interface RequestOptions { timeout: number; retries: number; headers: Record<string, string>; }\n",
    "export class ServiceError extends Error { constructor(msg: string) { super(msg); } }\n",
    "async function fetchData(url: string): Promise<Response> { return fetch(url); }\n",
    "type Result<T> = { ok: true; value: T } | { ok: false; error: Error };\n",
    "const SUPPORTED_FORMATS = ['json', 'yaml', 'toml', 'ini'] as const;\n",
    "// This handler validates incoming webhooks before forwarding\n",
    "let connectionPool: Map<string, unknown> = new Map();\n",
  ];
  // ~4 chars per token approximation
  const charsNeeded = targetTokens * 4;
  let output = "";
  let idx = 0;
  while (output.length < charsNeeded) {
    output += snippets[idx % snippets.length];
    idx++;
  }
  return output.slice(0, charsNeeded);
}

// Insert a fact at a specific position within filler text
function insertFactAtPosition(filler: string, fact: string, position: number): string {
  const insertIdx = Math.floor(filler.length * position);
  return filler.slice(0, insertIdx) + `\n${fact}\n` + filler.slice(insertIdx);
}

function buildProbes(): ContextProbe[] {
  return FILL_LEVELS.map((fraction, i) => {
    const paddingTokens = Math.floor(MODEL_CTX * fraction * 0.85); // leave room for question + answer
    const factIdx = i % PLANTED_FACTS.length;
    return {
      label: `${Math.round(fraction * 100)}% fill`,
      fillFraction: fraction,
      paddingTokens,
      question: `Based on the code context above, what is the value mentioned for: "${PLANTED_FACTS[factIdx].fact.split(" is ")[0]}"? Answer with just the value.`,
      expectedAnswer: PLANTED_FACTS[factIdx].key,
    };
  });
}

async function queryModel(prompt: string): Promise<{ response: string; latencyMs: number }> {
  const start = performance.now();
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: { num_predict: 64, temperature: 0.1, num_ctx: MODEL_CTX },
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { response: string };
  return { response: json.response.trim(), latencyMs: performance.now() - start };
}

// AST-first detection: does the response reference outlines, symbols, or targeted extraction?
function detectAstApproach(response: string): boolean {
  const astSignals = ["outline", "symbol", "ast", "get_symbol", "file_outline", "index_folder", "search_symbols"];
  const lower = response.toLowerCase();
  return astSignals.some((s) => lower.includes(s));
}

async function runBenchmark(): Promise<void> {
  console.log(`\n  Context Window Efficiency Benchmark`);
  console.log(`  Model: ${MODEL}  |  Context: ${MODEL_CTX} tokens\n`);
  console.log("  Fill Level | Padding  | Accuracy | AST? | Latency (ms)");
  console.log("  -----------|----------|----------|------|------------");

  const probes = buildProbes();
  const results: ProbeResult[] = [];

  for (const probe of probes) {
    const filler = generateCodeFiller(probe.paddingTokens);
    const factIdx = FILL_LEVELS.indexOf(probe.fillFraction as (typeof FILL_LEVELS)[number]);
    const factEntry = PLANTED_FACTS[factIdx % PLANTED_FACTS.length];
    // Plant fact at 30% depth in the filler (early enough to test recall under pressure)
    const contextWithFact = insertFactAtPosition(filler, factEntry.fact, 0.3);
    const fullPrompt = `${contextWithFact}\n\n${probe.question}`;

    try {
      const { response, latencyMs } = await queryModel(fullPrompt);
      const hasAnswer = response.includes(probe.expectedAnswer);
      const usedAst = detectAstApproach(response);

      const result: ProbeResult = {
        label: probe.label,
        fillFraction: probe.fillFraction,
        paddingTokens: probe.paddingTokens,
        answered: hasAnswer,
        accuracyScore: hasAnswer ? 1.0 : 0.0,
        usedAstApproach: usedAst,
        latencyMs,
      };
      results.push(result);

      const fill = probe.label.padEnd(10);
      const pad = String(probe.paddingTokens).padStart(7);
      const acc = hasAnswer ? "  PASS  " : "  FAIL  ";
      const ast = usedAst ? " yes " : "  no ";
      const lat = latencyMs.toFixed(0).padStart(11);
      console.log(`  ${fill} | ${pad} | ${acc} | ${ast} | ${lat}`);
    } catch (e) {
      console.log(`  ${probe.label.padEnd(10)} | FAILED: ${(e as Error).message}`);
    }
  }

  // Summary
  const passed = results.filter((r) => r.answered).length;
  const total = results.length;
  const avgLatency = results.reduce((s, r) => s + r.latencyMs, 0) / (total || 1);
  const astCount = results.filter((r) => r.usedAstApproach).length;

  console.log(`\n  Summary: ${passed}/${total} probes passed | Avg latency: ${avgLatency.toFixed(0)}ms | AST signals: ${astCount}/${total}`);

  const outPath = `${import.meta.dir}/../../autoresearch/context-efficiency-${Date.now()}.json`;
  await Bun.write(
    outPath,
    JSON.stringify({ model: MODEL, contextWindow: MODEL_CTX, date: new Date().toISOString(), results }, null, 2),
  );
  console.log(`  Results saved: ${outPath}\n`);
}

runBenchmark().catch(console.error);
