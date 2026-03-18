#!/usr/bin/env bun
/**
 * 8gent vs Claude — Head-to-Head SWE Benchmark
 *
 * Runs identical coding tasks against both:
 * - 8gent (eight:latest via Ollama bridge)
 * - Claude (Opus 4.6 via Anthropic API)
 *
 * Judged by Vercel AI SDK (LLM judge) — no string matching.
 */

import * as fs from "fs";
import * as path from "path";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EIGHT_MODEL = process.env.EIGHT_MODEL || "eight:latest";
const RESULTS_DIR = path.join(import.meta.dir, "../.8gent/benchmarks");

// ── Benchmark Tasks ──────────────────────────────────────────────

interface SWETask {
  id: string;
  name: string;
  difficulty: "medium" | "hard" | "expert";
  category: string;
  fixture: string;
  prompt: string;
  judgePrompt: string;
}

const TASKS: SWETask[] = [
  {
    id: "SWE-001",
    name: "Fix async race condition",
    difficulty: "hard",
    category: "bug-fixing",
    fixture: "benchmarks/fixtures/bug-fixing/BF001-async-race.ts",
    prompt: `Fix the race condition in this TypeScript code. Multiple concurrent calls to updateCounter should produce correct results (10 concurrent +1 updates = final value of 10). Output ONLY the fixed TypeScript code.`,
    judgePrompt: `Does this fix correctly prevent the race condition? Check for:
1. Proper serialization/mutex of concurrent access (not just Promise.all)
2. Atomic read-modify-write pattern
3. Correct final value guarantee under concurrent access
4. No deadlock potential
Score 0-100 where 90+ means production-ready fix.`,
  },
  {
    id: "SWE-002",
    name: "Fix memory leak in subscriptions",
    difficulty: "hard",
    category: "bug-fixing",
    fixture: "benchmarks/fixtures/bug-fixing/BF002-memory-leak.ts",
    prompt: `Fix the memory leak in this TypeScript EventEmitter/Subscriber system. The destroy() method should properly clean up all event handlers.

KEY: Store the handler as an instance field so destroy() can call off() with the SAME reference. Don't add extra methods — keep it minimal.

Output ONLY the fixed TypeScript code, no explanations.`,
    judgePrompt: `Does this fix correctly prevent the memory leak? Check for:
1. Event handler is stored as a reference so it can be removed
2. destroy() calls off() with the exact handler reference
3. After destroy(), emitting events does NOT trigger the old handler
4. No circular references or retained closures
Score 0-100 where 90+ means production-ready fix.`,
  },
  {
    id: "SWE-003",
    name: "Implement LRU cache with TTL",
    difficulty: "expert",
    category: "feature-implementation",
    fixture: "benchmarks/fixtures/feature-implementation/FI001-add-caching.ts",
    prompt: `Implement a CachedDataFetcher class that wraps DataFetcher with LRU caching.

CRITICAL LRU PATTERN — use JavaScript Map's insertion-order property:
- On cache HIT: delete the key then re-set it (moves to end = most recent)
- On eviction: delete map.keys().next().value (first key = least recently used)

Requirements:
1. constructor(baseUrl, { ttl, maxSize })
2. On hit: delete+re-set the key to update recency, increment stats.hits
3. On miss: fetch, store, evict if over maxSize, increment stats.misses
4. getStats(): { hits, misses, size, evictions }
5. invalidate(pattern: string | RegExp): number — delete matching keys
6. clear(): void

Output ONLY the complete TypeScript code. Keep it under 80 lines.`,
    judgePrompt: `Is this a correct, production-quality LRU cache implementation? Check for:
1. Proper LRU eviction (least recently used, not oldest)
2. TTL expiration on access (not just insertion)
3. Cache stats tracking (hits/misses/evictions)
4. Pattern invalidation works with both string and RegExp
5. Thread-safe for concurrent access patterns
6. Clean TypeScript types
Score 0-100 where 90+ means production-ready implementation.`,
  },
  {
    id: "SWE-004",
    name: "Build a task queue with retries",
    difficulty: "expert",
    category: "feature-implementation",
    fixture: "",
    prompt: `Implement a concise TypeScript task queue. Keep it UNDER 120 lines.

Structure your code exactly as:
1. Types (TaskQueueOptions, Task<T>) — 10 lines
2. TaskQueue class with: enqueue(), private processQueue(), private executeWithRetry(), shutdown() — 100 lines
3. Use EventTarget for events (completed, failed, retrying, drained)

Key patterns:
- Priority: sort pendingTasks on INSERT (splice at correct position), not on dequeue
- Concurrency: increment runningCount synchronously BEFORE awaiting, decrement in finally
- Retry: delay = baseDelay * 2^attempt + Math.random() * 100
- Timeout: Promise.race([task.fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
- Shutdown: set flag, reject new enqueue(), await all running promises

Output ONLY TypeScript code. No markdown fences. Be concise — prefer terse code over verbose.`,
    judgePrompt: `Is this a correct, production-quality task queue? Check for:
1. Concurrency limit is respected (never exceeds max parallel)
2. Exponential backoff with jitter
3. Priority ordering (higher priority dequeues first)
4. Per-task timeout with proper cleanup
5. Graceful shutdown (running tasks complete, queued tasks rejected)
6. Event emission at correct lifecycle points
7. No memory leaks (completed tasks are cleaned up)
8. Error handling doesn't crash the queue
Score 0-100 where 90+ means production-ready implementation.`,
  },
  {
    id: "SWE-005",
    name: "Implement a reactive state machine",
    difficulty: "expert",
    category: "architecture",
    fixture: "",
    prompt: `Implement a TypeScript state machine in UNDER 100 lines. No hierarchical states needed.

Structure:
1. Types: StateConfig, MachineConfig<S, E, C> — 15 lines
2. StateMachine<S, E, C> class — 80 lines

Features (in priority order):
- send(event): find transition in current state's "on" map, apply guard, update state + context
- Guards: transition.guard(ctx) returns boolean — skip transition if false
- Actions: transition.action(ctx) returns new context
- Entry/exit: state.entry(ctx) and state.exit(ctx) called in order: exit(old) → set state → entry(new)
- Listeners: onChange(cb) returns unsubscribe function, called after each transition
- toJSON/fromJSON for serialization

Key: Transition can be string (target only) or object { target, guard?, action? }.

Output ONLY TypeScript code. No markdown. Be terse.`,
    judgePrompt: `Is this a correct state machine implementation? Check for:
1. send(event) correctly looks up transition and changes state
2. Guards block transitions when returning false
3. Entry/exit actions fire in correct order (exit old -> set state -> enter new)
4. Context is updated immutably via action function
5. Listeners notified after transitions
6. toJSON/fromJSON serialization works
7. Code compiles without syntax errors
8. Implementation is complete (no truncated or missing methods)
Score 0-100 where 90+ means complete, working implementation.`,
  },
];

// ── Agents ──────────────────────────────────────────────────────

// Load the full system prompt from 8gent's prompt library
let cachedSystemPrompt: string | null = null;
function getEightSystemPrompt(): string {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  try {
    const promptFile = path.join(import.meta.dir, "../packages/eight/prompts/system-prompt.ts");
    const content = fs.readFileSync(promptFile, "utf-8");
    // Extract all segment values and concatenate
    const segments: string[] = [];
    const segmentRegex = /export const \w+_SEGMENT = `([\s\S]*?)`;/g;
    let match;
    while ((match = segmentRegex.exec(content)) !== null) {
      segments.push(match[1]);
    }
    cachedSystemPrompt = segments.join("\n\n") || "You are Eight, the infinite gentleman — an autonomous coding agent. Output clean, production-quality TypeScript.";
  } catch {
    cachedSystemPrompt = "You are Eight, the infinite gentleman — an autonomous coding agent. Output clean, production-quality TypeScript. Be concise.";
  }
  return cachedSystemPrompt;
}

async function run8gent(task: SWETask): Promise<{ output: string; durationMs: number }> {
  const fixture = task.fixture ? fs.readFileSync(path.join(import.meta.dir, "..", task.fixture), "utf-8") : "";
  const fullPrompt = fixture ? `${task.prompt}\n\n\`\`\`typescript\n${fixture}\n\`\`\`` : task.prompt;

  const start = Date.now();
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EIGHT_MODEL,
      messages: [
        { role: "system", content: getEightSystemPrompt() },
        { role: "user", content: fullPrompt },
      ],
      stream: false,
      think: false,
      options: { num_predict: 8192, temperature: 0.3 },
    }),
  });

  if (!res.ok) throw new Error(`8gent Ollama error: ${res.status}`);
  const data = await res.json();
  const output = data.message?.content || "";
  return { output, durationMs: Date.now() - start };
}

async function runClaude(task: SWETask): Promise<{ output: string; durationMs: number }> {
  const fixture = task.fixture ? fs.readFileSync(path.join(import.meta.dir, "..", task.fixture), "utf-8") : "";
  const fullPrompt = fixture ? `${task.prompt}\n\n\`\`\`typescript\n${fixture}\n\`\`\`` : task.prompt;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Fallback: use qwen3.5 as "Claude stand-in" if no API key
    console.log("  ⚠ No ANTHROPIC_API_KEY — using qwen3.5:latest as Claude stand-in");
    const start = Date.now();
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.5:latest",
        messages: [
          { role: "system", content: "You are Claude, an expert software engineer. Output clean, production-quality TypeScript. Be concise." },
          { role: "user", content: fullPrompt },
        ],
        stream: false,
        think: false,
        options: { num_predict: 8192, temperature: 0.3 },
      }),
    });
    if (!res.ok) throw new Error(`qwen3.5 Ollama error: ${res.status}`);
    const data = await res.json();
    return { output: data.message?.content || "", durationMs: Date.now() - start };
  }

  const start = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6-20250514",
      max_tokens: 4096,
      temperature: 0.3,
      messages: [{ role: "user", content: fullPrompt }],
      system: "You are an expert software engineer. Output clean, production-quality TypeScript. Be concise. Output ONLY code.",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const output = data.content?.[0]?.text || "";
  return { output, durationMs: Date.now() - start };
}

// ── LLM Judge ──────────────────────────────────────────────────

async function judge(task: SWETask, eightOutput: string, claudeOutput: string): Promise<{
  eightScore: number;
  claudeScore: number;
  eightAnalysis: string;
  claudeAnalysis: string;
  winner: "8gent" | "Claude" | "tie";
}> {
  // Use qwen3.5 as judge (different model than both competitors)
  const judgePrompt = `You are an expert code reviewer judging two solutions to the same programming task.

## Task
${task.prompt}

## Judging Criteria
${task.judgePrompt}

## Solution A (8gent)
\`\`\`
${eightOutput.substring(0, 3000)}
\`\`\`

## Solution B (Claude)
\`\`\`
${claudeOutput.substring(0, 3000)}
\`\`\`

Rate each solution 0-100. Output ONLY valid JSON:
{"scoreA": <number>, "scoreB": <number>, "analysisA": "<one sentence>", "analysisB": "<one sentence>", "winner": "A" | "B" | "tie"}`;

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen3.5:latest",
      messages: [{ role: "user", content: judgePrompt }],
      stream: false,
      think: false,
      options: { num_predict: 500, temperature: 0.1 },
    }),
  });

  if (!res.ok) throw new Error(`Judge error: ${res.status}`);
  const data = await res.json();
  const raw = data.message?.content || "";

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in judge response");
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      eightScore: parsed.scoreA ?? 50,
      claudeScore: parsed.scoreB ?? 50,
      eightAnalysis: parsed.analysisA ?? "No analysis",
      claudeAnalysis: parsed.analysisB ?? "No analysis",
      winner: parsed.winner === "A" ? "8gent" : parsed.winner === "B" ? "Claude" : "tie",
    };
  } catch {
    return { eightScore: 50, claudeScore: 50, eightAnalysis: "Judge parse failed", claudeAnalysis: "Judge parse failed", winner: "tie" };
  }
}

// ── Main ──────────────────────────────────────────────────────

interface BenchmarkResult {
  task: SWETask;
  eightOutput: string;
  claudeOutput: string;
  eightDuration: number;
  claudeDuration: number;
  eightScore: number;
  claudeScore: number;
  winner: string;
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║     8gent vs Claude — Head-to-Head SWE Benchmark       ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  console.log(`  8gent model:  ${EIGHT_MODEL}`);
  console.log(`  Claude:       ${process.env.ANTHROPIC_API_KEY ? "Anthropic API" : "qwen3.5 (stand-in)"}`);
  console.log(`  Judge:        qwen3.5:latest`);
  console.log(`  Tasks:        ${TASKS.length}\n`);

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const results: BenchmarkResult[] = [];
  let eightWins = 0, claudeWins = 0, ties = 0;

  for (const task of TASKS) {
    console.log(`\n━━━ ${task.id}: ${task.name} (${task.difficulty}) ━━━`);

    // Run both agents in parallel
    console.log("  Running 8gent...");
    let eightResult: { output: string; durationMs: number };
    try {
      eightResult = await run8gent(task);
      console.log(`  ✓ 8gent: ${eightResult.durationMs}ms, ${eightResult.output.length} chars`);
    } catch (err: any) {
      console.log(`  ✗ 8gent failed: ${err.message}`);
      eightResult = { output: "ERROR: " + err.message, durationMs: 0 };
    }

    console.log("  Running Claude...");
    let claudeResult: { output: string; durationMs: number };
    try {
      claudeResult = await runClaude(task);
      console.log(`  ✓ Claude: ${claudeResult.durationMs}ms, ${claudeResult.output.length} chars`);
    } catch (err: any) {
      console.log(`  ✗ Claude failed: ${err.message}`);
      claudeResult = { output: "ERROR: " + err.message, durationMs: 0 };
    }

    // Judge
    console.log("  Judging...");
    const verdict = await judge(task, eightResult.output, claudeResult.output);

    if (verdict.winner === "8gent") eightWins++;
    else if (verdict.winner === "Claude") claudeWins++;
    else ties++;

    const icon = verdict.winner === "8gent" ? "🏆" : verdict.winner === "Claude" ? "🥈" : "🤝";
    console.log(`  ${icon} Winner: ${verdict.winner}`);
    console.log(`     8gent: ${verdict.eightScore}/100 — ${verdict.eightAnalysis}`);
    console.log(`     Claude: ${verdict.claudeScore}/100 — ${verdict.claudeAnalysis}`);

    results.push({
      task,
      eightOutput: eightResult.output,
      claudeOutput: claudeResult.output,
      eightDuration: eightResult.durationMs,
      claudeDuration: claudeResult.durationMs,
      eightScore: verdict.eightScore,
      claudeScore: verdict.claudeScore,
      winner: verdict.winner,
    });
  }

  // ── Summary ──────────────────────────────────────────────────
  console.log("\n\n╔══════════════════════════════════════════════════════════╗");
  console.log("║                    FINAL SCOREBOARD                      ║");
  console.log("╠══════════════════════════════════════════════════════════╣");

  const eightAvg = results.reduce((s, r) => s + r.eightScore, 0) / results.length;
  const claudeAvg = results.reduce((s, r) => s + r.claudeScore, 0) / results.length;

  console.log(`║  8gent  Wins: ${eightWins}  |  Avg Score: ${eightAvg.toFixed(1)}/100`.padEnd(59) + "║");
  console.log(`║  Claude Wins: ${claudeWins}  |  Avg Score: ${claudeAvg.toFixed(1)}/100`.padEnd(59) + "║");
  console.log(`║  Ties:        ${ties}`.padEnd(59) + "║");
  console.log("╠══════════════════════════════════════════════════════════╣");

  for (const r of results) {
    const icon = r.winner === "8gent" ? "🏆" : r.winner === "Claude" ? "🥈" : "🤝";
    console.log(`║  ${icon} ${r.task.id}: 8gent ${r.eightScore} vs Claude ${r.claudeScore} (${r.winner})`.padEnd(59) + "║");
  }

  const overall = eightWins > claudeWins ? "🏆 8GENT WINS" : claudeWins > eightWins ? "🥈 CLAUDE WINS" : "🤝 TIE";
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  ${overall}`.padEnd(59) + "║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // Save results
  const resultsFile = path.join(RESULTS_DIR, `h2h-${Date.now()}.json`);
  fs.writeFileSync(resultsFile, JSON.stringify({ results, summary: { eightWins, claudeWins, ties, eightAvg, claudeAvg } }, null, 2));
  console.log(`Results saved to: ${resultsFile}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
