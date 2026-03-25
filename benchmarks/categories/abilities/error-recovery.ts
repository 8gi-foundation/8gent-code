// -- Error Recovery Benchmark --------------------------------------------------
// Tests: packages/validation/healing.ts + packages/validation/checkpoint.ts
// Validates that the agent can recover from tool failures, retry with
// alternative approaches, report errors clearly, and use the
// checkpoint-verify-revert loop to maintain workspace integrity.
//
// Run: bun run benchmarks/categories/abilities/error-recovery.ts

import { SelfHealer } from "../../../packages/validation/healing.js";
import type { VerifyCheck } from "../../../packages/validation/healing.js";
import {
  createCheckpoint,
  restoreCheckpoint,
  dropCheckpoint,
} from "../../../packages/validation/checkpoint.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "err-recovery-"));
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@8gent.dev"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "test"], { cwd: dir });
  writeFileSync(join(dir, "main.ts"), "export const value = 1;\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

// ── Test 1: Recover from a failed tool call ─────────────────────────────────

async function testToolCallRecovery(): Promise<{
  passed: boolean;
  detail: string;
}> {
  const dir = makeTmpGitRepo();
  try {
    const healer = new SelfHealer({ cwd: dir, maxAttempts: 3 });

    let attempt = 0;
    const result = await healer.healingLoop(
      async () => {
        attempt++;
        if (attempt < 3) {
          // Simulate a tool that fails on first two attempts
          writeFileSync(join(dir, "main.ts"), "BROKEN SYNTAX {{{\n");
        } else {
          // Third attempt succeeds with valid code
          writeFileSync(join(dir, "main.ts"), "export const value = 42;\n");
        }
      },
      [
        {
          name: "syntax-check",
          command: `bun -e "import('${join(dir, "main.ts").replace(/'/g, "\\'")}')"`,
          timeoutMs: 10_000,
        },
      ],
    );

    const passed = result.success && result.attempts >= 2;
    return {
      passed,
      detail: passed
        ? `Recovered after ${result.attempts} attempts`
        : `Expected recovery - got success=${result.success}, attempts=${result.attempts}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Test 2: Retry with a different approach ─────────────────────────────────

async function testAlternativeApproach(): Promise<{
  passed: boolean;
  detail: string;
}> {
  const dir = makeTmpGitRepo();
  try {
    const strategies = ["JSON.parse('{')", "JSON.parse('{}')", "done"];
    let strategyIndex = 0;

    const healer = new SelfHealer({ cwd: dir, maxAttempts: 3 });
    const result = await healer.healingLoop(
      async () => {
        const code = strategies[Math.min(strategyIndex++, strategies.length - 1)];
        writeFileSync(join(dir, "runner.ts"), `${code}\n`);
      },
      [
        {
          name: "run-strategy",
          command: `bun ${join(dir, "runner.ts")}`,
          timeoutMs: 10_000,
        },
      ],
    );

    const passed = result.success && strategyIndex >= 2;
    return {
      passed,
      detail: passed
        ? `Switched strategy at attempt ${strategyIndex}`
        : `Failed - success=${result.success}, strategyIndex=${strategyIndex}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Test 3: Clear error reporting ───────────────────────────────────────────

async function testErrorReporting(): Promise<{
  passed: boolean;
  detail: string;
}> {
  const dir = makeTmpGitRepo();
  try {
    const healer = new SelfHealer({ cwd: dir, maxAttempts: 1 });
    const result = await healer.healingLoop(
      async () => {
        writeFileSync(join(dir, "bad.ts"), "throw new Error('deliberate');\n");
      },
      [{ name: "run-bad", command: `bun ${join(dir, "bad.ts")}`, timeoutMs: 10_000 }],
    );

    const hasLog = result.failureLog.length > 0;
    const hasError = result.failureLog.some((f) => f.error?.length > 0);
    const passed = !result.success && hasLog && hasError;
    return {
      passed,
      detail: passed
        ? `Failure logged with ${result.failureLog.length} entries, error output captured`
        : `Missing error info - log=${hasLog}, error=${hasError}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Test 4: Checkpoint-verify-revert loop ───────────────────────────────────

async function testCheckpointRevert(): Promise<{
  passed: boolean;
  detail: string;
}> {
  const dir = makeTmpGitRepo();
  try {
    const original = readFileSync(join(dir, "main.ts"), "utf-8");

    // Create checkpoint
    const cp = createCheckpoint(dir, "error-recovery-test");

    // Make a destructive change
    writeFileSync(join(dir, "main.ts"), "CORRUPTED FILE CONTENT\n");
    const corrupted = readFileSync(join(dir, "main.ts"), "utf-8");

    // Verify the file is actually changed
    if (corrupted === original) {
      return { passed: false, detail: "File was not modified before revert" };
    }

    // Revert to checkpoint
    restoreCheckpoint(dir, cp);
    const restored = readFileSync(join(dir, "main.ts"), "utf-8");

    const passed = restored.trim() === original.trim();
    return {
      passed,
      detail: passed
        ? "Checkpoint restored workspace to clean state"
        : `Restore failed - expected "${original.trim()}", got "${restored.trim()}"`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Runner ──────────────────────────────────────────────────────────────────

const tests = [
  { name: "Tool call recovery", fn: testToolCallRecovery },
  { name: "Alternative approach retry", fn: testAlternativeApproach },
  { name: "Clear error reporting", fn: testErrorReporting },
  { name: "Checkpoint-verify-revert", fn: testCheckpointRevert },
];

async function main() {
  console.log("Error Recovery Benchmark (AB007)\n");
  let passed = 0;

  for (const t of tests) {
    try {
      const result = await t.fn();
      const icon = result.passed ? "PASS" : "FAIL";
      console.log(`  [${icon}] ${t.name} - ${result.detail}`);
      if (result.passed) passed++;
    } catch (err) {
      console.log(`  [ERR]  ${t.name} - ${(err as Error).message}`);
    }
  }

  console.log(`\nResult: ${passed}/${tests.length} passed`);
  process.exit(passed === tests.length ? 0 : 1);
}

main();

// ── Benchmark descriptor (for harness integration) ──────────────────────────

export const benchmark = {
  id: "AB007",
  name: "Error Recovery: Checkpoint-Heal-Retry",
  ability: "healing",
  difficulty: "hard" as const,

  prompt: `This benchmark tests error recovery capabilities.

The agent must demonstrate four behaviors:

1. Recover from a failed tool call by retrying (up to 3 attempts).
2. Switch to a different strategy when the first approach fails.
3. Report errors clearly with captured output in the failure log.
4. Use the checkpoint-verify-revert loop to restore workspace state
   after a destructive change.

Run: bun run benchmarks/categories/abilities/error-recovery.ts`,

  successCriteria: [
    "Agent retries after first tool call failure",
    "Agent switches strategy when initial approach fails",
    "Failure log contains captured output from failed checks",
    "Checkpoint restores workspace to pre-change state",
  ],

  scoring: [
    { metric: "tool_call_recovery", weight: 0.25 },
    { metric: "alternative_strategy_used", weight: 0.25 },
    { metric: "error_reporting_quality", weight: 0.25 },
    { metric: "checkpoint_revert_integrity", weight: 0.25 },
  ],

  timeLimit: 90,
};

export default benchmark;
