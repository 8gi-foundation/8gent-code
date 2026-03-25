#!/usr/bin/env bun
// -- Model Quality Comparison Benchmark ----------------------------------------
// Runs the same prompts across local models, measures response time, token count,
// and quality (via LLM judge). Outputs a comparison table to help decide which
// model to use for which task type.
//
// Run: bun run benchmarks/categories/abilities/model-quality.ts
// Env: OLLAMA_URL (default http://localhost:11434)
//      JUDGE_MODEL (default qwen3.5:latest)

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "qwen3.5:latest";

const MODELS = ["qwen3.5:latest", "eight:latest", "devstral:latest"];

interface TaskPrompt {
  id: string;
  taskType: string;
  prompt: string;
  judgeCriteria: string;
}

const TASKS: TaskPrompt[] = [
  {
    id: "MQ-CODE",
    taskType: "code-generation",
    prompt:
      "Write a TypeScript function `debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T` that delays invocation until `ms` after the last call. Include JSDoc. Output ONLY code.",
    judgeCriteria:
      "Correct generic signature, proper clearTimeout/setTimeout pattern, returns wrapped function with same type, has JSDoc, compiles without errors.",
  },
  {
    id: "MQ-DEBUG",
    taskType: "bug-fixing",
    prompt: `Fix this TypeScript. The reduce should sum numbers but returns NaN for empty arrays:
\`\`\`typescript
function sum(nums: number[]): number {
  return nums.reduce((a, b) => a + b);
}
\`\`\`
Output ONLY the fixed code.`,
    judgeCriteria:
      "Provides initial value 0 to reduce, handles empty array returning 0, preserves type signature, minimal change.",
  },
  {
    id: "MQ-EXPLAIN",
    taskType: "explanation",
    prompt:
      "Explain the difference between `interface` and `type` in TypeScript in under 100 words. Be precise and mention declaration merging.",
    judgeCriteria:
      "Mentions declaration merging (interface can, type cannot), mentions union/intersection for type, accurate, concise, under 100 words.",
  },
  {
    id: "MQ-ARCH",
    taskType: "architecture",
    prompt:
      "Design a minimal pub/sub event system in TypeScript. Under 40 lines. Typed events via generics. Output ONLY code.",
    judgeCriteria:
      "Generic event map type, on/off/emit methods, proper listener cleanup in off, type-safe event names and payloads, compiles, under 40 lines.",
  },
];

interface ModelResult {
  model: string;
  taskId: string;
  taskType: string;
  durationMs: number;
  outputTokens: number;
  qualityScore: number;
  output: string;
}

async function generate(
  model: string,
  prompt: string,
): Promise<{ output: string; durationMs: number; outputTokens: number }> {
  const start = performance.now();
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      think: false,
      options: { num_predict: 1024, temperature: 0.3 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const output: string = data.message?.content ?? "";
  const outputTokens: number = data.eval_count ?? Math.ceil(output.length / 4);
  return { output, durationMs: performance.now() - start, outputTokens };
}

async function judgeQuality(
  task: TaskPrompt,
  output: string,
): Promise<number> {
  const prompt = `Rate this output 0-100 for the task "${task.taskType}".
Criteria: ${task.judgeCriteria}

Output to judge:
\`\`\`
${output.substring(0, 2000)}
\`\`\`

Respond with ONLY a JSON object: {"score": <number>, "reason": "<one sentence>"}`;

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      think: false,
      options: { num_predict: 100, temperature: 0.1 },
    }),
  });
  if (!res.ok) return 50;
  const data = await res.json();
  const raw: string = data.message?.content ?? "";
  try {
    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) return 50;
    return Math.min(100, Math.max(0, JSON.parse(match[0]).score ?? 50));
  } catch {
    return 50;
  }
}

async function main(): Promise<void> {
  console.log("\n  Model Quality Comparison Benchmark");
  console.log(`  Judge: ${JUDGE_MODEL}  |  Models: ${MODELS.join(", ")}\n`);

  const results: ModelResult[] = [];

  for (const task of TASKS) {
    console.log(`  --- ${task.id}: ${task.taskType} ---`);
    for (const model of MODELS) {
      try {
        const { output, durationMs, outputTokens } = await generate(model, task.prompt);
        const qualityScore = await judgeQuality(task, output);
        results.push({ model, taskId: task.id, taskType: task.taskType, durationMs, outputTokens, qualityScore, output });
        const dur = durationMs.toFixed(0).padStart(6);
        const toks = String(outputTokens).padStart(5);
        const score = String(qualityScore).padStart(3);
        console.log(`    ${model.padEnd(20)} | ${dur}ms | ${toks} tok | quality: ${score}/100`);
      } catch (e) {
        console.log(`    ${model.padEnd(20)} | FAILED: ${(e as Error).message}`);
      }
    }
  }

  // -- Summary table --
  console.log("\n  ══════════════════════════════════════════════════════════════════");
  console.log("  MODEL COMPARISON SUMMARY");
  console.log("  ══════════════════════════════════════════════════════════════════");
  console.log("  Model                | Avg ms | Avg tok | Avg Quality | Best For");
  console.log("  ---------------------|--------|---------|-------------|----------");

  for (const model of MODELS) {
    const mr = results.filter((r) => r.model === model);
    if (mr.length === 0) continue;
    const avgMs = (mr.reduce((s, r) => s + r.durationMs, 0) / mr.length).toFixed(0).padStart(6);
    const avgTok = (mr.reduce((s, r) => s + r.outputTokens, 0) / mr.length).toFixed(0).padStart(7);
    const avgQ = (mr.reduce((s, r) => s + r.qualityScore, 0) / mr.length).toFixed(1).padStart(11);
    const bestTask = mr.sort((a, b) => b.qualityScore - a.qualityScore)[0]?.taskType ?? "-";
    console.log(`  ${model.padEnd(22)}| ${avgMs} | ${avgTok} | ${avgQ} | ${bestTask}`);
  }

  // Per-task winners
  console.log("\n  Task Winners:");
  for (const task of TASKS) {
    const tr = results.filter((r) => r.taskId === task.id).sort((a, b) => b.qualityScore - a.qualityScore);
    const winner = tr[0];
    if (winner) {
      console.log(`    ${task.taskType.padEnd(18)} -> ${winner.model} (${winner.qualityScore}/100, ${winner.durationMs.toFixed(0)}ms)`);
    }
  }

  // Save results
  const outPath = `${import.meta.dir}/../../results/model-quality-${Date.now()}.json`;
  await Bun.write(outPath, JSON.stringify({ date: new Date().toISOString(), judge: JUDGE_MODEL, models: MODELS, results }, null, 2));
  console.log(`\n  Results saved: ${outPath}\n`);
}

main().catch(console.error);
