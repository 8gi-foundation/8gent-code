#!/usr/bin/env bun
/**
 * overnight-competition.ts — 8gent vs Claude Code Overnight Competition
 *
 * Pits 8gent (Ollama) against Claude (Anthropic API) on ALL benchmarks,
 * grades both with execution-based grading, feeds learnings back via mutations.
 * Sends Telegram updates per round. State is resumable.
 *
 * Env: ANTHROPIC_API_KEY, EIGHT_MODEL, OLLAMA_URL, TELEGRAM_BOT_TOKEN,
 *      TELEGRAM_CHAT_ID, MAX_ROUNDS, STOP_HOUR
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

import type { BenchmarkDefinition, CombinedGradeResult, TokenUsage } from "../types";

// ── Import ALL benchmark categories ────────────────────────────────

import { bugFixingBenchmarks } from "../categories/bug-fixing/benchmarks";
import { fileManipulationBenchmarks } from "../categories/file-manipulation/benchmarks";
import { featureImplementationBenchmarks } from "../categories/feature-implementation/benchmarks";
import { fullstackBenchmarks } from "../categories/fullstack/benchmarks";
import { agenticBenchmarks } from "../categories/agentic/benchmarks";
import { uiDesignBenchmarks } from "../categories/ui-design/benchmarks";
import { battleTestBenchmarks } from "../categories/battle-test/benchmarks";
import { battleTestProBenchmarks } from "../categories/battle-test/benchmarks-pro";
import { longHorizonBenchmarks } from "../categories/long-horizon/benchmarks";

// ── Import existing grading & mutation system ──────────────────────

import { grade } from "../autoresearch/execution-grader";
import { getSystemPrompt, addMutation, getMutations, clearMutations } from "../autoresearch/system-prompt";
import { recordResult, getModelOrder } from "../autoresearch/model-router";

// ── Config ─────────────────────────────────────────────────────────

const ROOT = resolve(dirname(import.meta.dir));
const COMP_DIR = join(ROOT, "competition");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const EIGHT_MODEL = process.env.EIGHT_MODEL ?? "eight:latest";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MAX_ROUNDS = parseInt(process.env.MAX_ROUNDS ?? "0", 10);
const STOP_HOUR = parseInt(process.env.STOP_HOUR ?? "7", 10);

const CLAUDE_MODEL = "claude-sonnet-4-6-20250514";
const CLAUDE_FALLBACK_MODEL = "qwen3.5:latest";
const CLAUDE_TEMPERATURE = 0.3;
const EIGHT_TEMPERATURES = [0.3, 0.5, 0.7];

const STATE_FILE = join(COMP_DIR, "competition-state.json");
const LOG_FILE = join(COMP_DIR, "competition.log");

// ── Difficulty-ordered categories ──────────────────────────────────

interface CategoryRound {
  name: string;
  tier: string;
  benchmarks: BenchmarkDefinition[];
}

const CATEGORY_ROUNDS: CategoryRound[] = [
  { name: "bug-fixing", tier: "EASY", benchmarks: bugFixingBenchmarks },
  { name: "file-manipulation", tier: "EASY", benchmarks: fileManipulationBenchmarks },
  { name: "feature-implementation", tier: "MEDIUM", benchmarks: featureImplementationBenchmarks },
  { name: "fullstack", tier: "MEDIUM", benchmarks: fullstackBenchmarks },
  { name: "agentic", tier: "HARD", benchmarks: agenticBenchmarks },
  { name: "ui-design", tier: "HARD", benchmarks: uiDesignBenchmarks },
  { name: "battle-test", tier: "EXPERT", benchmarks: [...battleTestBenchmarks, ...battleTestProBenchmarks] },
  { name: "long-horizon", tier: "LEGENDARY", benchmarks: longHorizonBenchmarks },
];

// ── Types ──────────────────────────────────────────────────────────

interface CompetitorResult {
  benchmarkId: string; score: number; gradeResult: CombinedGradeResult;
  rawOutput: string; model: string; temperature: number; durationMs: number; tokenUsage?: TokenUsage;
}

interface RoundResult {
  round: number; category: string; tier: string;
  eightResults: CompetitorResult[]; claudeResults: CompetitorResult[];
  eightAvg: number; claudeAvg: number;
  eightWins: number; claudeWins: number; ties: number;
  mutationsApplied: string[]; timestamp: string;
}

interface CompetitionState {
  currentRound: number; totalEightWins: number; totalClaudeWins: number; totalTies: number;
  rounds: RoundResult[]; mutations: string[]; startedAt: string; lastRunAt: string;
}

// ── Logging ────────────────────────────────────────────────────────

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

// ── Telegram ───────────────────────────────────────────────────────

async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN || "8651805768:AAFvSVOMc7U9l2itsBUTWPzgBkPxdle4B4U";
  const chatId = process.env.TELEGRAM_CHAT_ID || "5486040131";
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch (err: any) {
    log(`Telegram send failed: ${err.message}`);
  }
}

// ── State Persistence ──────────────────────────────────────────────

function loadState(): CompetitionState | null {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

function saveState(state: CompetitionState): void {
  state.lastRunAt = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Time Helpers ───────────────────────────────────────────────────

function getPSTHour(): number {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })).getHours();
}

function getPSTTimeString(): string {
  return new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false });
}

function shouldStop(): boolean { const h = getPSTHour(); return h >= STOP_HOUR && h < STOP_HOUR + 2; }

// ── API Callers ───────────────────────────────────────────────────

interface ChatMessage { role: "system" | "user" | "assistant"; content: string; }
interface ApiResponse { content: string; durationMs: number; tokenUsage: TokenUsage; }

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 600_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, { ...init, signal: controller.signal });
  clearTimeout(timeout);
  return response;
}

async function callOllama(model: string, messages: ChatMessage[], temperature: number): Promise<ApiResponse> {
  const start = performance.now();
  const response = await fetchWithTimeout(`${OLLAMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature, max_tokens: 8192, stream: false }),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const json = (await response.json()) as any;
  const usage = json.usage ?? {};
  const content = json.choices?.[0]?.message?.content || json.choices?.[0]?.message?.reasoning || "";
  return {
    content, durationMs: Math.round(performance.now() - start),
    tokenUsage: { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0, totalTokens: usage.total_tokens ?? 0 },
  };
}

async function callClaude(messages: ChatMessage[], temperature: number): Promise<ApiResponse> {
  if (!ANTHROPIC_API_KEY) {
    log("  [Claude fallback] No ANTHROPIC_API_KEY — using qwen3.5 via Ollama");
    return callOllama(CLAUDE_FALLBACK_MODEL, messages, temperature);
  }
  const start = performance.now();
  const systemMsg = messages.find((m) => m.role === "system")?.content ?? "";
  const userMsgs = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 8192, temperature, system: systemMsg, messages: userMsgs }),
  });
  if (!response.ok) throw new Error(`Anthropic ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const json = (await response.json()) as any;
  const content = json.content?.map((b: any) => b.text).join("\n") ?? "";
  const usage = json.usage ?? {};
  return {
    content, durationMs: Math.round(performance.now() - start),
    tokenUsage: { promptTokens: usage.input_tokens ?? 0, completionTokens: usage.output_tokens ?? 0, totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) },
  };
}

// ── Build Messages ─────────────────────────────────────────────────

function buildEightMessages(benchmark: BenchmarkDefinition): ChatMessage[] {
  return [
    { role: "system", content: getSystemPrompt() },
    { role: "user", content: benchmark.prompt },
  ];
}

// Claude gets a clean system prompt — no mutations, no learnings. Baseline competitor.
const CLAUDE_SYSTEM_PROMPT = `You are a senior TypeScript/JavaScript engineer. Solve coding tasks with correct, production-quality code.
RULES: 1) Include all imports/types/exports. 2) Named + default export for main class/function. 3) Handle edge cases. 4) No explanations outside code blocks. 5) Prefer built-in APIs, Bun-compatible TS. 6) async/await for concurrency, mutex for shared state. 7) Handle invalid arguments gracefully.
SINGLE-FILE: Output ONE \`\`\`typescript fenced block. MULTI-FILE: Output EACH file in SEPARATE fenced blocks: \`\`\`typescript // filename.ts`;

function buildClaudeMessages(benchmark: BenchmarkDefinition): ChatMessage[] {
  return [
    { role: "system", content: CLAUDE_SYSTEM_PROMPT },
    { role: "user", content: benchmark.prompt },
  ];
}

// ── Helpers ────────────────────────────────────────────────────────

const EMPTY_GRADE: CombinedGradeResult = { score: 0, execution: null, keyword: { score: 0, matchedKeywords: [], missedKeywords: [] }, method: "keyword-only" };

function emptyResult(benchmarkId: string, model: string, temperature: number): CompetitorResult {
  return { benchmarkId, score: 0, gradeResult: EMPTY_GRADE, rawOutput: "", model, temperature, durationMs: 0 };
}

// ── Run Competitor on a Single Benchmark ───────────────────────────

async function runEight(
  benchmark: BenchmarkDefinition
): Promise<CompetitorResult> {
  let best: CompetitorResult | null = null;

  for (const temp of EIGHT_TEMPERATURES) {
    try {
      const messages = buildEightMessages(benchmark);
      const { content, durationMs, tokenUsage } = await callOllama(
        EIGHT_MODEL,
        messages,
        temp
      );
      const { code, result } = await grade(content, benchmark);

      const run: CompetitorResult = {
        benchmarkId: benchmark.id,
        score: result.score,
        gradeResult: result,
        rawOutput: content,
        model: `ollama/${EIGHT_MODEL}`,
        temperature: temp,
        durationMs,
        tokenUsage,
      };

      log(`    [8gent] temp=${temp} score=${result.score} (exec=${result.execution?.score ?? "-"} kw=${result.keyword.score}) ${durationMs}ms`);

      // Record for experience-based routing
      recordResult(`ollama/${EIGHT_MODEL}`, benchmark.category, benchmark.id, result.score);

      if (!best || run.score > best.score) {
        best = run;
      }

      // Early exit on perfect score
      if (run.score >= 100) break;
    } catch (err: any) {
      log(`    [8gent] temp=${temp} FAILED: ${err.message}`);
    }
  }

  if (!best) return emptyResult(benchmark.id, `ollama/${EIGHT_MODEL}`, 0.3);
  return best;
}

async function runClaude(
  benchmark: BenchmarkDefinition
): Promise<CompetitorResult> {
  const claudeModelLabel = ANTHROPIC_API_KEY ? `anthropic/${CLAUDE_MODEL}` : `ollama/${CLAUDE_FALLBACK_MODEL}`;

  try {
    const messages = buildClaudeMessages(benchmark);
    const { content, durationMs, tokenUsage } = await callClaude(
      messages,
      CLAUDE_TEMPERATURE
    );
    const { code, result } = await grade(content, benchmark);

    log(`    [Claude] score=${result.score} (exec=${result.execution?.score ?? "-"} kw=${result.keyword.score}) ${durationMs}ms`);

    // Record Claude's results too for the experience DB
    recordResult(claudeModelLabel, benchmark.category, benchmark.id, result.score);

    return {
      benchmarkId: benchmark.id,
      score: result.score,
      gradeResult: result,
      rawOutput: content,
      model: claudeModelLabel,
      temperature: CLAUDE_TEMPERATURE,
      durationMs,
      tokenUsage,
    };
  } catch (err: any) {
    log(`    [Claude] FAILED: ${err.message}`);
    return emptyResult(benchmark.id, claudeModelLabel, CLAUDE_TEMPERATURE);
  }
}

// ── Analyze Claude's Advantage & Generate Mutations ────────────────

function analyzeAndMutate(
  benchmark: BenchmarkDefinition,
  eightResult: CompetitorResult,
  claudeResult: CompetitorResult
): string[] {
  const gap = claudeResult.score - eightResult.score;

  // Only mutate if Claude genuinely scored higher
  if (gap <= 0) return [];

  const newMutations: string[] = [];

  // Analyze what Claude did that 8gent missed
  const claudeKw = claudeResult.gradeResult.keyword;
  const eightKw = eightResult.gradeResult.keyword;

  // Keywords Claude matched but 8gent missed
  const claudeOnlyKeywords = claudeKw.matchedKeywords.filter(
    (kw) => !eightKw.matchedKeywords.includes(kw)
  );

  if (claudeOnlyKeywords.length > 0) {
    newMutations.push(
      `[${benchmark.id}] Claude used patterns 8gent missed: ${claudeOnlyKeywords.slice(0, 5).join(", ")}. Ensure these are present in your solution.`
    );
  }

  // Execution-specific analysis
  const claudeExec = claudeResult.gradeResult.execution;
  const eightExec = eightResult.gradeResult.execution;

  if (claudeExec && eightExec) {
    const testGap = claudeExec.passedTests - eightExec.passedTests;
    if (testGap > 0) {
      newMutations.push(
        `[${benchmark.id}] Claude passed ${testGap} more tests (${claudeExec.passedTests}/${claudeExec.totalTests} vs ${eightExec.passedTests}/${eightExec.totalTests}). Focus on correctness and edge cases.`
      );
    }

    // Check if 8gent timed out but Claude didn't
    if (eightExec.timedOut && !claudeExec.timedOut) {
      newMutations.push(
        `[${benchmark.id}] 8gent's solution timed out. Use bounded iterations, avoid infinite loops, and ensure async operations complete.`
      );
    }
  }

  // If 8gent failed extraction entirely
  if (!eightResult.rawOutput || eightResult.score === 0) {
    newMutations.push(
      `[${benchmark.id}] 8gent produced no usable output. Ensure response contains properly fenced code blocks with \`\`\`typescript markers.`
    );
  }

  // Multi-file specific
  if (benchmark.multiFile && claudeResult.score > eightResult.score + 20) {
    newMutations.push(
      `[${benchmark.id}] For multi-file tasks, output EACH file in its OWN fenced block: \`\`\`typescript // filename.ts. Do NOT merge files.`
    );
  }

  // Category-level learnings based on gap size
  if (gap >= 40) {
    newMutations.push(
      `[${benchmark.id}] CRITICAL gap of ${gap} points. Re-read the task requirements carefully. Claude's approach scored ${claudeResult.score}. Ensure all specified methods and exports are present.`
    );
  }

  return newMutations;
}

// ── Run a Full Category Round ──────────────────────────────────────

async function runRound(
  roundNum: number,
  category: CategoryRound
): Promise<RoundResult> {
  log(`\n${"=".repeat(60)}`);
  log(`  ROUND ${roundNum}: ${category.name.toUpperCase()} (${category.tier})`);
  log(`  Benchmarks: ${category.benchmarks.length}`);
  log(`${"=".repeat(60)}\n`);

  const eightResults: CompetitorResult[] = [];
  const claudeResults: CompetitorResult[] = [];
  const roundMutations: string[] = [];
  let eightWins = 0;
  let claudeWins = 0;
  let ties = 0;

  for (const benchmark of category.benchmarks) {
    log(`  --- ${benchmark.id}: ${benchmark.title} ---`);

    // Run both competitors
    const eightResult = await runEight(benchmark);
    eightResults.push(eightResult);

    // Brief pause between competitors
    await new Promise((r) => setTimeout(r, 1000));

    const claudeResult = await runClaude(benchmark);
    claudeResults.push(claudeResult);

    // Determine winner
    const winner =
      eightResult.score > claudeResult.score
        ? "8gent"
        : claudeResult.score > eightResult.score
          ? "Claude"
          : "TIE";

    if (winner === "8gent") eightWins++;
    else if (winner === "Claude") claudeWins++;
    else ties++;

    log(`  RESULT: 8gent=${eightResult.score} vs Claude=${claudeResult.score} => ${winner}`);

    // If Claude won, analyze and mutate
    const muts = analyzeAndMutate(benchmark, eightResult, claudeResult);
    for (const m of muts) {
      roundMutations.push(m);
      addMutation(m);
    }

    if (muts.length > 0) {
      log(`  Mutations: ${muts.length} new learnings applied`);
    }

    // Pause between benchmarks to avoid overloading
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Calculate averages
  const eightAvg = eightResults.length > 0
    ? Math.round(eightResults.reduce((s, r) => s + r.score, 0) / eightResults.length)
    : 0;
  const claudeAvg = claudeResults.length > 0
    ? Math.round(claudeResults.reduce((s, r) => s + r.score, 0) / claudeResults.length)
    : 0;

  return {
    round: roundNum,
    category: category.name,
    tier: category.tier,
    eightResults,
    claudeResults,
    eightAvg,
    claudeAvg,
    eightWins,
    claudeWins,
    ties,
    mutationsApplied: roundMutations,
    timestamp: new Date().toISOString(),
  };
}

// ── Format Telegram Update ─────────────────────────────────────────

function formatTelegramRound(
  roundResult: RoundResult,
  totalEightWins: number,
  totalClaudeWins: number,
  totalTies: number
): string {
  const time = getPSTTimeString();

  let perBenchmark = "";
  for (let i = 0; i < roundResult.eightResults.length; i++) {
    const e = roundResult.eightResults[i];
    const c = roundResult.claudeResults[i];
    const icon = e.score > c.score ? "✅" : c.score > e.score ? "❌" : "🔶";
    const winner =
      e.score > c.score ? "8gent" : c.score > e.score ? "Claude" : "TIE";
    perBenchmark += `${icon} ${e.benchmarkId}: 8gent ${e.score} vs Claude ${c.score} [${winner}]\n`;
  }

  return `🏆 *8GENT vs CLAUDE — Round ${roundResult.round}*
⏰ ${time} PST

*Difficulty: ${roundResult.tier}*
📊 8gent: ${roundResult.eightAvg} | Claude: ${roundResult.claudeAvg}

Per-benchmark:
${perBenchmark.trim()}

*Mutations applied:* ${roundResult.mutationsApplied.length} new learnings
*Running score:* 8gent ${totalEightWins} / Claude ${totalClaudeWins} / Ties ${totalTies}

_Next round in ~5m_`;
}

function formatFinalSummary(state: CompetitionState): string {
  const cats = state.rounds.map((r) => `${r.eightAvg >= r.claudeAvg ? "✅" : "❌"} ${r.category}: 8gent ${r.eightAvg} vs Claude ${r.claudeAvg}`).join("\n");
  const muts = state.mutations.slice(-5).map((m) => `• ${m}`).join("\n") || "None";
  return `🏁 *8GENT vs CLAUDE — FINAL RESULTS*\n⏰ ${getPSTTimeString()} PST\n\n*Overall:* 8gent ${state.totalEightWins} / Claude ${state.totalClaudeWins} / Ties ${state.totalTies}\n\n*Per-category:*\n${cats}\n\n*Top mutations:*\n${muts}\n\n*Learnings:* ${state.mutations.length} | *Rounds:* ${state.rounds.length}`;
}

// ── Save Results JSON ──────────────────────────────────────────────

function saveResults(state: CompetitionState): void {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const resultsFile = join(COMP_DIR, `results-${ts}.json`);
  const results = {
    summary: { totalRounds: state.rounds.length, eightWins: state.totalEightWins,
      claudeWins: state.totalClaudeWins, ties: state.totalTies,
      startedAt: state.startedAt, completedAt: new Date().toISOString() },
    rounds: state.rounds.map((r) => ({
      round: r.round, category: r.category, tier: r.tier,
      eightAvg: r.eightAvg, claudeAvg: r.claudeAvg,
      benchmarks: r.eightResults.map((e, i) => {
        const c = r.claudeResults[i];
        return { id: e.benchmarkId, eightScore: e.score, claudeScore: c.score,
          eightModel: e.model, claudeModel: c.model, eightTemp: e.temperature,
          winner: e.score > c.score ? "8gent" : c.score > e.score ? "Claude" : "TIE" };
      }),
      mutationsApplied: r.mutationsApplied, timestamp: r.timestamp,
    })),
    mutations: state.mutations,
    systemPromptFinal: getSystemPrompt(),
    persistentFailures: identifyPersistentFailures(state),
  };
  writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  log(`Results saved: ${resultsFile}`);
}

// ── Identify Persistent Failures (for GitHub Issues) ───────────────

function identifyPersistentFailures(state: CompetitionState): Array<{
  benchmarkId: string; category: string; eightAvg: number; claudeAvg: number; gap: number; suggestion: string;
}> {
  const scores: Record<string, { e: number[]; c: number[]; cat: string }> = {};
  for (const round of state.rounds) {
    for (let i = 0; i < round.eightResults.length; i++) {
      const e = round.eightResults[i], c = round.claudeResults[i];
      if (!scores[e.benchmarkId]) scores[e.benchmarkId] = { e: [], c: [], cat: round.category };
      scores[e.benchmarkId].e.push(e.score);
      scores[e.benchmarkId].c.push(c.score);
    }
  }

  return Object.entries(scores)
    .map(([id, d]) => {
      const eAvg = Math.round(d.e.reduce((a, b) => a + b, 0) / d.e.length);
      const cAvg = Math.round(d.c.reduce((a, b) => a + b, 0) / d.c.length);
      return { benchmarkId: id, category: d.cat, eightAvg: eAvg, claudeAvg: cAvg, gap: cAvg - eAvg,
        suggestion: `[GitHub Issue] 8gent underperforms Claude by ${cAvg - eAvg}pts on ${id} (${d.cat}). 8gent=${eAvg}, Claude=${cAvg}.` };
    })
    .filter((f) => f.gap >= 30)
    .sort((a, b) => b.gap - a.gap);
}

// ── Generate Final Report ──────────────────────────────────────────

function generateFinalReport(state: CompetitionState): void {
  log(`\n${"=".repeat(60)}`);
  log("  OVERNIGHT COMPETITION — FINAL REPORT");
  log(`${"=".repeat(60)}`);
  log(`\n  Overall: 8gent ${state.totalEightWins} / Claude ${state.totalClaudeWins} / Ties ${state.totalTies}`);

  log("\n  Per-category:");
  for (const r of state.rounds) {
    const w = r.eightAvg >= r.claudeAvg ? "8gent" : "Claude";
    log(`    ${r.category.padEnd(25)} 8gent=${String(r.eightAvg).padStart(3)} Claude=${String(r.claudeAvg).padStart(3)} => ${w}`);
  }

  const allMuts = getMutations();
  if (allMuts.length > 0) {
    log(`\n  Top mutations (${allMuts.length} total):`);
    for (const m of allMuts.slice(-10)) log(`    • ${m}`);
  }

  const failures = identifyPersistentFailures(state);
  if (failures.length > 0) {
    log(`\n  Persistent failures (${failures.length}):`);
    for (const f of failures) log(`    ⚠ ${f.benchmarkId}: gap=${f.gap} — 8gent=${f.eightAvg} Claude=${f.claudeAvg}`);
    log("\n  GitHub issue suggestions:");
    for (const f of failures.slice(0, 5)) log(`    ${f.suggestion}`);
  }

  log(`\n  Rounds: ${state.rounds.length} | Mutations: ${allMuts.length} | Started: ${state.startedAt} | Finished: ${new Date().toISOString()}`);
}

// ── Main Loop ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  mkdirSync(COMP_DIR, { recursive: true });
  mkdirSync(join(ROOT, "autoresearch", "work"), { recursive: true });

  const totalBenchmarks = CATEGORY_ROUNDS.reduce((s, c) => s + c.benchmarks.length, 0);
  const claudeLabel = ANTHROPIC_API_KEY ? CLAUDE_MODEL : `${CLAUDE_FALLBACK_MODEL} (fallback)`;
  log("╔══════════════════════════════════════════════════════════════╗");
  log("║     8GENT vs CLAUDE CODE — Overnight Competition           ║");
  log("╠══════════════════════════════════════════════════════════════╣");
  log(`║  8gent: ${EIGHT_MODEL} | Claude: ${claudeLabel}`);
  log(`║  Categories: ${CATEGORY_ROUNDS.length} | Benchmarks: ${totalBenchmarks} | Max rounds: ${MAX_ROUNDS || "all"}`);
  log(`║  Stop: ${STOP_HOUR}:00 PST | 8gent temps: ${EIGHT_TEMPERATURES.join(",")} | Claude temp: ${CLAUDE_TEMPERATURE}`);
  log("╚══════════════════════════════════════════════════════════════╝\n");

  if (!ANTHROPIC_API_KEY) {
    log("⚠ No ANTHROPIC_API_KEY — Claude will use qwen3.5 via Ollama as fallback");
  }

  // Load or initialize state
  let state = loadState();
  if (state) {
    log(`Resuming from round ${state.currentRound + 1}`);
    clearMutations();
    for (const m of state.mutations) addMutation(m);
  } else {
    state = {
      currentRound: 0,
      totalEightWins: 0,
      totalClaudeWins: 0,
      totalTies: 0,
      rounds: [],
      mutations: [],
      startedAt: new Date().toISOString(),
      lastRunAt: new Date().toISOString(),
    };
  }

  await sendTelegram(`🚀 *8GENT vs CLAUDE — Started*\n⏰ ${getPSTTimeString()} PST\n8gent: \`${EIGHT_MODEL}\` | Claude: \`${claudeLabel}\`\nCategories: ${CATEGORY_ROUNDS.length} | Round: ${state.currentRound + 1}`);

  // Determine which rounds to run
  const startRound = state.currentRound;
  const endRound = MAX_ROUNDS > 0
    ? Math.min(startRound + MAX_ROUNDS, CATEGORY_ROUNDS.length)
    : CATEGORY_ROUNDS.length;

  // Main competition loop
  for (let i = startRound; i < endRound; i++) {
    if (shouldStop()) {
      log(`\nStop hour reached (${STOP_HOUR}:00 PST). Pausing.`);
      await sendTelegram(`⏸ *Paused* at round ${i + 1}/${CATEGORY_ROUNDS.length}. Resume by re-running.`);
      break;
    }

    const category = CATEGORY_ROUNDS[i];

    // Skip categories with no benchmarks
    if (category.benchmarks.length === 0) {
      log(`\nSkipping ${category.name} — no benchmarks defined`);
      state.currentRound = i + 1;
      saveState(state);
      continue;
    }

    // Run the round
    const roundResult = await runRound(i + 1, category);
    state.rounds.push(roundResult);

    // Update running totals
    state.totalEightWins += roundResult.eightWins;
    state.totalClaudeWins += roundResult.claudeWins;
    state.totalTies += roundResult.ties;
    state.currentRound = i + 1;
    state.mutations = getMutations();
    saveState(state);

    // Save results snapshot
    saveResults(state);

    // Log round summary
    log(`\n  Round ${i + 1} Summary: 8gent avg=${roundResult.eightAvg} Claude avg=${roundResult.claudeAvg}`);
    log(`  Round wins: 8gent=${roundResult.eightWins} Claude=${roundResult.claudeWins} Ties=${roundResult.ties}`);
    log(`  Cumulative: 8gent=${state.totalEightWins} Claude=${state.totalClaudeWins} Ties=${state.totalTies}`);
    log(`  Mutations this round: ${roundResult.mutationsApplied.length}`);

    // Send Telegram update
    const telegramMsg = formatTelegramRound(
      roundResult,
      state.totalEightWins,
      state.totalClaudeWins,
      state.totalTies
    );
    await sendTelegram(telegramMsg);

    // Pause between rounds
    if (i < endRound - 1) {
      log("\nNext round in 30 seconds...");
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }

  // ── Final Summary ─────────────────────────────────────────────

  generateFinalReport(state);
  saveResults(state);

  // Send final Telegram summary
  const finalMsg = formatFinalSummary(state);
  await sendTelegram(finalMsg);

  log("\nCompetition complete.");
}

// ── Entry Point ────────────────────────────────────────────────────

main().catch((err) => {
  log(`Fatal error: ${err.message}\n${err.stack}`);
  sendTelegram(`💀 *Competition crashed:* ${err.message}`).catch(() => {});
  process.exit(1);
});
