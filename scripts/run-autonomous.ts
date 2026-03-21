#!/usr/bin/env bun
/**
 * Run Eight autonomously on a real task.
 *
 * Usage:
 *   bun scripts/run-autonomous.ts --task "Add a health check endpoint" --repo ~/my-project
 *   bun scripts/run-autonomous.ts --issue 42 --repo ~/8gent-code
 *   bun scripts/run-autonomous.ts --dry-run --task "Refactor auth middleware"
 */

import { executeTask, type Task } from "../packages/executor/autonomous";

const args = process.argv.slice(2);
const taskTitle = args.find((_, i, a) => a[i - 1] === "--task") || "Test autonomous execution";
const taskDesc = args.find((_, i, a) => a[i - 1] === "--desc") || taskTitle;
const repoPath = args.find((_, i, a) => a[i - 1] === "--repo") || process.cwd();
const dryRun = args.includes("--dry-run");
const model = args.find((_, i, a) => a[i - 1] === "--model") || "devstral:latest";

const task: Task = {
  id: `auto-${Date.now()}`,
  title: taskTitle,
  description: taskDesc,
  source: "user",
  priority: "medium",
};

console.log(`Eight - Autonomous Execution`);
console.log(`Task: ${task.title}`);
console.log(`Repo: ${repoPath}`);
console.log(`Model: ${model}`);
console.log(`Dry run: ${dryRun}`);
console.log(`---`);

const result = await executeTask(task, repoPath, { dryRun, model });

console.log(`\n---`);
console.log(`Success: ${result.success}`);
console.log(`Attempts: ${result.attempts}`);
console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
console.log(`Files: ${result.filesChanged.join(", ") || "none"}`);
console.log(`Tests: ${result.testsPassed} passed, ${result.testsFailed} failed`);

if (result.branch) console.log(`Branch: ${result.branch}`);
if (result.prUrl) console.log(`PR: ${result.prUrl}`);
if (result.error) console.log(`Error: ${result.error}`);

// Send result to Telegram
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (TOKEN && CHAT_ID) {
  const icon = result.success ? "Done" : "Failed";
  const msg = `Eight Autonomous - ${icon}\n\nTask: ${task.title}\nAttempts: ${result.attempts}\nDuration: ${(result.durationMs / 1000).toFixed(1)}s\nFiles: ${result.filesChanged.join(", ") || "none"}\n${result.branch ? `Branch: ${result.branch}` : ""}${result.prUrl ? `\nPR: ${result.prUrl}` : ""}${result.error ? `\nError: ${result.error}` : ""}`;

  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text: msg }),
  }).catch(() => {});
}
