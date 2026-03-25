#!/usr/bin/env bun
/**
 * Utility Factory - Autonomous utility generator and PR creator.
 *
 * Reads specs from scripts/utility-queue.json, calls Ollama to generate
 * each utility, writes it to packages/tools/, creates a quarantine doc,
 * commits to a branch, and opens a PR via gh.
 *
 * Usage:
 *   bun run scripts/utility-factory.ts
 *   bun run scripts/utility-factory.ts --count 50
 *   bun run scripts/utility-factory.ts --dry-run
 */

import * as fs from "fs";
import * as path from "path";
import { execSync, spawnSync } from "child_process";

// ============================================
// Config
// ============================================

const OLLAMA_URL = "http://localhost:11434";
const OLLAMA_MODEL = "eight-1-q-14b:latest";
const RATE_LIMIT_MS = 5000;
const TELEGRAM_NOTIFY_EVERY = 25;
const TELEGRAM_CHAT_ID = "5486040131";

const ROOT = path.resolve(import.meta.dir, "..");
const QUEUE_FILE = path.join(ROOT, "scripts", "utility-queue.json");
const LOG_FILE = path.join(ROOT, "scripts", "factory-log.json");
const TOOLS_DIR = path.join(ROOT, "packages", "tools");
const QUARANTINE_DIR = path.join(ROOT, "quarantine");

// ============================================
// Types
// ============================================

interface UtilitySpec {
  name: string;
  description: string;
  requirements: string[];
  maxLines?: number;
}

interface FactoryLogEntry {
  name: string;
  status: "ok" | "skipped" | "error";
  branch?: string;
  pr?: string;
  error?: string;
  timestamp: string;
}

// ============================================
// Args
// ============================================

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const countArg = args.find((a) => a.startsWith("--count=")) ?? args[args.indexOf("--count") + 1];
const maxCount = countArg ? parseInt(String(countArg).replace("--count=", ""), 10) : Infinity;

// ============================================
// Load / save log
// ============================================

function loadLog(): FactoryLogEntry[] {
  try {
    if (fs.existsSync(LOG_FILE)) {
      return JSON.parse(fs.readFileSync(LOG_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function appendLog(entry: FactoryLogEntry, log: FactoryLogEntry[]): void {
  log.push(entry);
  if (!isDryRun) {
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2), "utf-8");
  }
}

// ============================================
// Branch existence check
// ============================================

function branchExists(branchName: string): boolean {
  const result = spawnSync("git", ["branch", "--list", branchName], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  return result.stdout.trim().length > 0;
}

function remoteBranchExists(branchName: string): boolean {
  const result = spawnSync(
    "git",
    ["ls-remote", "--heads", "origin", branchName],
    { cwd: ROOT, encoding: "utf-8" }
  );
  return result.stdout.trim().length > 0;
}

// ============================================
// Ollama call
// ============================================

async function generateUtility(spec: UtilitySpec): Promise<string> {
  const maxLines = spec.maxLines ?? 150;
  const reqList = spec.requirements.map((r) => `- ${r}`).join("\n");

  const prompt = `You are a TypeScript utility author. Write a self-contained TypeScript utility for: ${spec.description}

Requirements:
${reqList}

Rules:
- TypeScript only, zero external dependencies
- Under ${maxLines} lines
- Export all public functions/classes
- Include JSDoc on exports
- No em dashes in comments

Output ONLY the TypeScript code inside a fenced code block like:
\`\`\`typescript
// code here
\`\`\``;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
    signal: controller.signal,
  });
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as { message?: { content?: string } };
  const text = data.message?.content ?? "";

  const match = text.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
  if (match) return match[1].trim();

  // If no fenced block, return raw text - still usable
  return text.trim();
}

// ============================================
// Quarantine doc generator
// ============================================

function generateQuarantineDoc(spec: UtilitySpec): string {
  const reqList = spec.requirements.map((r) => `- ${r}`).join("\n");
  return `# ${spec.name}

${spec.description}

## Requirements
${reqList}

## Status

Quarantine - pending review.

## Location

\`packages/tools/${spec.name}.ts\`
`;
}

// ============================================
// Telegram notification
// ============================================

function getTelegramToken(): string | null {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try {
    const envPath = path.join(process.env.HOME ?? "", ".claude", ".env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      const match = content.match(/TELEGRAM_BOT_TOKEN=(\S+)/);
      if (match) return match[1];
    }
  } catch {}
  return null;
}

async function sendTelegram(message: string): Promise<void> {
  const token = getTelegramToken();
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "Markdown" }),
    });
  } catch {}
}

async function sendTelegramVoice(audioPath: string): Promise<void> {
  const token = getTelegramToken();
  if (!token) return;
  try {
    const form = new FormData();
    form.append("chat_id", TELEGRAM_CHAT_ID);
    form.append("voice", new Blob([fs.readFileSync(audioPath)], { type: "audio/ogg" }), "voice.ogg");
    await fetch(`https://api.telegram.org/bot${token}/sendVoice`, { method: "POST", body: form });
  } catch {}
}

function generatePitch(spec: UtilitySpec): string {
  const categories: Record<string, string> = {
    string: "any developer working with text",
    data: "agents that need fast in-memory data structures",
    async: "concurrent workflows and agent orchestration",
    fs: "file system operations in autonomous agents",
    net: "network-aware agents and API integrations",
    crypto: "security, hashing, and identity in agent systems",
    date: "time-aware agents and scheduling",
    math: "analytics, scoring, and numerical reasoning",
    cli: "terminal-based agent interfaces",
    test: "self-validating agents that test their own output",
    parse: "agents that read and transform structured data",
    encoding: "data transport between agents and services",
  };
  const category = spec.requirements[0]?.toLowerCase().includes("string") ? "string"
    : spec.requirements[0]?.toLowerCase().includes("async") ? "async"
    : spec.requirements[0]?.toLowerCase().includes("file") ? "fs"
    : spec.requirements[0]?.toLowerCase().includes("parse") ? "parse"
    : "data";
  const audience = categories[category] ?? "autonomous coding agents";
  return `New ability obtained: *${spec.name}*

${spec.description}

*Who it's for:* ${audience}
*Job to be done:* ${spec.requirements.slice(0, 2).join(". ")}
*Why it matters:* Every ability Eight obtains makes it more autonomous. This one means Eight no longer needs external dependencies for this task - it can do it itself, in under ${spec.maxLines ?? 150} lines, zero deps.`;
}

async function sendPRNotification(spec: UtilitySpec, prUrl: string): Promise<void> {
  const msg = generatePitch(spec) + `\n\n${prUrl}`;
  await sendTelegram(msg);

  // Generate voice pitch via macOS say
  try {
    const voiceText = `New ability: ${spec.name}. ${spec.description}. Eight can now do this autonomously with zero dependencies.`;
    const aiffPath = `/tmp/8gent-voice-${spec.name}.aiff`;
    const oggPath = `/tmp/8gent-voice-${spec.name}.ogg`;
    execSync(`say -v Ava -o "${aiffPath}" "${voiceText.replace(/"/g, '\\"')}"`, { stdio: "pipe" });
    execSync(`ffmpeg -y -i "${aiffPath}" -c:a libopus "${oggPath}" 2>/dev/null`, { stdio: "pipe" });
    if (fs.existsSync(oggPath)) {
      await sendTelegramVoice(oggPath);
      fs.unlinkSync(aiffPath);
      fs.unlinkSync(oggPath);
    }
  } catch {
    // Voice is optional - continue without it
  }
}

// ============================================
// Sleep
// ============================================

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============================================
// Main
// ============================================

async function main() {
  if (!fs.existsSync(QUEUE_FILE)) {
    console.error(`Queue file not found: ${QUEUE_FILE}`);
    process.exit(1);
  }

  const queue: UtilitySpec[] = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
  const log = loadLog();
  const processed = new Set(log.filter((e) => e.status === "ok" || e.status === "skipped").map((e) => e.name));

  const pending = queue.filter((s) => !processed.has(s.name)).slice(0, maxCount);

  if (pending.length === 0) {
    console.log("No pending utilities. Queue complete.");
    return;
  }

  console.log(`Processing ${pending.length} utilities (dry-run: ${isDryRun})`);

  let successCount = 0;
  let errorCount = 0;

  for (const spec of pending) {
    const branch = `quarantine/${spec.name}`;
    console.log(`\n[${spec.name}] Starting...`);

    // Skip if branch/PR already exists
    if (!isDryRun && (branchExists(branch) || remoteBranchExists(branch))) {
      console.log(`[${spec.name}] Branch exists - skipping`);
      appendLog({ name: spec.name, status: "skipped", branch, timestamp: new Date().toISOString() }, log);
      continue;
    }

    if (isDryRun) {
      console.log(`[${spec.name}] DRY RUN - would create branch: ${branch}`);
      appendLog({ name: spec.name, status: "skipped", branch, timestamp: new Date().toISOString() }, log);
      continue;
    }

    try {
      // Generate code
      console.log(`[${spec.name}] Calling Ollama...`);
      const code = await generateUtility(spec);
      const doc = generateQuarantineDoc(spec);

      const toolPath = path.join(TOOLS_DIR, `${spec.name}.ts`);
      const quarantinePath = path.join(QUARANTINE_DIR, `${spec.name}.md`);

      // Create branch from main
      execSync(`git checkout main && git checkout -b ${branch}`, { cwd: ROOT, stdio: "pipe" });

      // Write files
      fs.writeFileSync(toolPath, code, "utf-8");
      fs.writeFileSync(quarantinePath, doc, "utf-8");

      // Commit
      execSync(`git add "${toolPath}" "${quarantinePath}"`, { cwd: ROOT, stdio: "pipe" });
      execSync(
        `git commit -m "feat: ${spec.name} utility\n\n${spec.description}"`,
        { cwd: ROOT, stdio: "pipe" }
      );

      // Push
      execSync(`git push -u origin ${branch}`, { cwd: ROOT, stdio: "pipe" });

      // Create PR
      const prResult = spawnSync(
        "gh",
        [
          "pr", "create",
          "--title", `feat: ${spec.name}`,
          "--body", `## ${spec.name}\n\n${spec.description}\n\nAuto-generated by utility-factory.`,
          "--base", "main",
          "--head", branch,
        ],
        { cwd: ROOT, encoding: "utf-8" }
      );

      const prUrl = prResult.stdout.trim();
      console.log(`[${spec.name}] PR: ${prUrl}`);

      appendLog({ name: spec.name, status: "ok", branch, pr: prUrl, timestamp: new Date().toISOString() }, log);
      successCount++;

      // Rich Telegram notification per PR
      await sendPRNotification(spec, prUrl);

      // Summary every 25
      if (successCount % TELEGRAM_NOTIFY_EVERY === 0) {
        await sendTelegram(
          `Factory checkpoint: ${successCount} PRs created this run. ${errorCount} errors. Keep going.`
        );
      }

      // Return to main before next iteration
      execSync("git checkout main", { cwd: ROOT, stdio: "pipe" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${spec.name}] Error: ${message}`);
      appendLog({ name: spec.name, status: "error", error: message, timestamp: new Date().toISOString() }, log);
      errorCount++;

      // Try to recover to main
      try { execSync("git checkout main", { cwd: ROOT, stdio: "pipe" }); } catch {}
    }

    // Rate limit
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\nDone. Success: ${successCount}, Errors: ${errorCount}`);

  if (successCount > 0) {
    await sendTelegram(
      `Utility factory complete. ${successCount} PRs created, ${errorCount} errors.`
    );
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
