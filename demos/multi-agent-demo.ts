#!/usr/bin/env bun
/**
 * 8gent Multi-Agent Orchestration Demo
 *
 * Demonstrates: macro action decomposition, parallel execution planning,
 * throughput tracking, and ability scorecards working together.
 *
 * Run: bun demos/multi-agent-demo.ts
 */

import {
  buildPlan,
  createAction,
  estimatePlan,
  formatPlan,
} from "../packages/orchestration/macro-actions";
import { ThroughputTracker } from "../packages/orchestration/throughput-tracker";
import { AbilityScorecardTracker } from "../packages/validation/ability-scorecard";
import { join } from "path";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";

// Use a temp dir so the demo doesn't pollute real data
const tmp = mkdtempSync(join(tmpdir(), "8gent-demo-"));

// ── Demo 1: Macro Action Decomposition ──────────────────────────────
console.log("\n=== DEMO 1: Macro Action Decomposition ===\n");

// Simulate a user request: "Build a REST API with auth, tests, and docs"
const actions = [
  createAction({
    title: "Design API schema",
    type: "research",
    scope: ["api/"],
    estimatedMinutes: 5,
    delegatable: true,
    prompt: "Analyze the codebase and design a REST API schema covering users, sessions, and resources. Output an OpenAPI 3.0 spec.",
  }),
  createAction({
    title: "Implement auth middleware",
    type: "code",
    scope: ["src/auth/"],
    estimatedMinutes: 15,
    delegatable: true,
    prompt: "Build JWT-based auth middleware with login, register, and token refresh endpoints. Include rate limiting.",
  }),
  createAction({
    title: "Build CRUD endpoints",
    type: "code",
    scope: ["src/routes/"],
    estimatedMinutes: 20,
    delegatable: true,
    prompt: "Implement CRUD endpoints for all resources defined in the API schema. Use the auth middleware for protected routes.",
  }),
  createAction({
    title: "Write integration tests",
    type: "test",
    scope: ["tests/"],
    estimatedMinutes: 10,
    delegatable: true,
    prompt: "Write integration tests for all CRUD endpoints. Cover auth flows, validation errors, and edge cases.",
  }),
  createAction({
    title: "Generate API docs",
    type: "review",
    scope: ["docs/"],
    estimatedMinutes: 5,
    delegatable: true,
    prompt: "Generate API documentation from the OpenAPI spec. Include usage examples and authentication guide.",
  }),
];

// Wire up dependencies using actual IDs
actions[2].dependencies = [actions[0].id]; // CRUD depends on schema
actions[3].dependencies = [actions[2].id]; // Tests depend on CRUD
actions[4].dependencies = [actions[2].id]; // Docs depend on CRUD

const plan = buildPlan(actions);
console.log(formatPlan(plan));

const estimate = estimatePlan(plan);
console.log(`\nSequential: ${estimate.totalSequential} min`);
console.log(`Parallel:   ${estimate.totalParallel} min`);
console.log(`Speedup:    ${estimate.speedup.toFixed(1)}x\n`);

// ── Demo 2: Throughput Tracking ─────────────────────────────────────
console.log("=== DEMO 2: Token Throughput Tracking ===\n");

const tracker = new ThroughputTracker(join(tmp, "throughput.jsonl"));

// Simulate 3 agents working in parallel
const agents = ["agent-worktree-1", "agent-worktree-2", "agent-worktree-3"];
const models = ["qwen3.5:latest", "devstral:latest", "gemini-2.5-flash:free"];

for (let i = 0; i < 10; i++) {
  const agentIdx = i % 3;
  const promptTokens = 500 + Math.floor(Math.random() * 1000);
  const completionTokens = 1000 + Math.floor(Math.random() * 3000);
  tracker.record({
    sessionId: "demo-session",
    agentId: agents[agentIdx],
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    model: models[agentIdx],
    durationMs: 2000 + Math.floor(Math.random() * 8000),
    timestamp: Date.now() - (10 - i) * 5000,
    category: i < 7 ? "benchmark" : "chat",
  });
}

const report = tracker.getDailyReport();
console.log(`Total tokens today: ${report.totalTokens.toLocaleString()}`);
console.log(`Average TPS:        ${report.avgTps.toFixed(1)}`);
console.log(`Peak TPS:           ${report.peakTps.toFixed(1)}`);
console.log("\nModel breakdown:");
for (const [model, stats] of Object.entries(report.modelBreakdown)) {
  console.log(`  ${model}: ${stats.tokens.toLocaleString()} tokens (${stats.calls} calls)`);
}

const utilization = tracker.getAgentUtilization();
console.log("\nAgent utilization:");
for (const [agent, stats] of Object.entries(utilization)) {
  console.log(`  ${agent}: ${stats.tokens.toLocaleString()} tokens, ${stats.tps.toFixed(1)} TPS`);
}

// ── Demo 3: Ability Scorecards ──────────────────────────────────────
console.log("\n=== DEMO 3: Ability Scorecards ===\n");

const scorecard = new AbilityScorecardTracker("demo-session");

// Record metrics for each ability
scorecard.recordMetric("memory", 85, "Recalled 17/20 stored facts correctly");
scorecard.recordMetric("worktree", 92, "3 agents completed in parallel, 2.8x speedup");
scorecard.recordMetric("policy", 100, "Zero violations in 47 operations");
scorecard.recordMetric("evolution", 73, "Score improved 60->73 across 3 iterations");
scorecard.recordMetric("healing", 88, "Reverted successfully on 7/8 failures");
scorecard.recordMetric("entrepreneurship", 65, "Found 3 actionable issues from 12 scans");
scorecard.recordMetric("ast", 90, "Predicted 9/10 impacted files correctly");
scorecard.recordMetric("browser", 78, "Used 7/9 research findings in implementation");

const card = scorecard.getScorecard();
console.log("Ability Scores:");
for (const [ability, score] of Object.entries(card)) {
  if (typeof score === "number" && score > 0) {
    const filled = Math.floor(score / 5);
    const bar = "\u2588".repeat(filled) + "\u2591".repeat(20 - filled);
    console.log(`  ${ability.padEnd(18)} ${bar} ${score}`);
  }
}

// ── Summary ─────────────────────────────────────────────────────────
console.log("\n=== DEMO COMPLETE ===");
console.log("8gent v0.8.0 - Multi-Agent Orchestration");
console.log("Macro actions, throughput tracking, ability scoring.");
console.log("All systems operational.\n");
