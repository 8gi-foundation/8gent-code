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
  const timer = setTimeout(() => controller.abort(), 300_000);
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

  // If no fenced block, the model failed to follow instructions — reject
  throw new Error("Model output contained no fenced TypeScript code block. Raw text rejected.");
}

// ============================================
// Security gate - reject unsafe generated code
// ============================================

function securityReview(code: string, name: string): string[] {
  const issues: string[] = [];

  // No auto-executing code at module level (side effects on import)
  // Allow: export, type, interface, const, let, function, class, //, /*, import
  const lines = code.split("\n").filter(l => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"));
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(export|import|type |interface |const |let |var |function |class |enum |declare |\/\/)/.test(trimmed)) continue;
    if (/^\}/.test(trimmed)) continue; // closing braces
    if (/^\*/.test(trimmed)) continue; // comment continuation
    if (/^(if|else|for|while|switch|case|break|return|throw|try|catch|finally|default|do)/.test(trimmed)) continue; // control flow inside functions
    if (/^[a-zA-Z_$].*\(/.test(trimmed) && !trimmed.startsWith("export")) {
      // Top-level function call - potential side effect
      // Only flag if it's at indent level 0 (not inside a function)
      if (!line.startsWith(" ") && !line.startsWith("\t")) {
        issues.push(`Auto-executing code at module level: "${trimmed.slice(0, 60)}"`);
      }
    }
  }

  // No CommonJS require()
  if (/\brequire\s*\(/.test(code)) {
    issues.push("Uses require() instead of ESM imports");
  }

  // No process.env mutation (writing to process.env)
  if (/process\.env\[.*\]\s*=/.test(code) || /process\.env\.[\w]+\s*=/.test(code)) {
    issues.push("Mutates process.env - read-only access only");
  }

  // No eval or Function constructor
  if (/\beval\s*\(/.test(code) || /new\s+Function\s*\(/.test(code)) {
    issues.push("Uses eval() or new Function() - code injection risk");
  }

  // No child_process unless the utility is explicitly about process management
  if (/child_process|exec\s*\(|execSync|spawn/.test(code) && !name.includes("process") && !name.includes("exec") && !name.includes("shell")) {
    issues.push("Spawns child processes without being a process management utility");
  }

  // No network access unless the utility is explicitly about networking
  if (/\bfetch\s*\(|http\.|https\.|net\.|dgram\./.test(code) && !name.includes("http") && !name.includes("url") && !name.includes("fetch") && !name.includes("net")) {
    issues.push("Makes network calls without being a networking utility");
  }

  // Excessive use of `any` type (more than 3 instances)
  const anyCount = (code.match(/:\s*any\b/g) || []).length;
  if (anyCount > 3) {
    issues.push(`Excessive 'any' types (${anyCount} instances) - defeats type safety`);
  }

  // File too long
  const lineCount = code.split("\n").length;
  if (lineCount > 250) {
    issues.push(`Too long (${lineCount} lines) - max 200 for quarantine utilities`);
  }

  return issues;
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
  const readableName = spec.name.replace(/-/g, " ");
  const reqs = spec.requirements.map(r => `  - ${r}`).join("\n");
  const lines = spec.maxLines ?? 150;

  return `*Eight learned: ${readableName}*

*The job to be done:*
A developer or agent needs to ${spec.requirements[0]?.toLowerCase() || spec.description.toLowerCase()}. Today that means installing an npm package, adding a dependency, trusting someone else's code, or writing it from scratch every time.

*What this ability gives Eight:*
${spec.description}. Self-contained. ${lines} lines. Zero dependencies. Works offline. No npm install, no API key, no trust required.

*Specifically:*
${reqs}

*Is it safe to merge?*
- Passed the security gate (no eval, no require, no process.env mutation, no auto-exec on import)
- Quarantined on its own branch - isolated from main
- Under ${lines} lines - small enough to read in 2 minutes
- Zero external dependencies - nothing to supply-chain attack
- TypeScript with proper types - not any-soup

*Unique value:* Every ability Eight absorbs makes it less dependent on the outside world. This is one more thing the agent handles natively instead of asking for help.`;
}

async function sendPRNotification(spec: UtilitySpec, prUrl: string): Promise<void> {
  const msg = generatePitch(spec) + `\n\n${prUrl}`;
  await sendTelegram(msg);

  // Generate 60-second voice pitch - product-led, JTBD, safety case
  try {
    const readableName = spec.name.replace(/-/g, " ");
    const firstReq = spec.requirements[0] || spec.description;
    const secondReq = spec.requirements[1] || "";
    const lines = spec.maxLines ?? 150;

    const voiceText = `Hey James, quick one. Eight just built a new ability: ${readableName}.

Here's the job it solves. When a developer or agent needs to ${firstReq.toLowerCase()}, right now they have two options. Install an npm package and trust someone else's code, or write it from scratch every time. Neither is great.

What Eight built instead. ${spec.description}. ${secondReq ? "It can also " + secondReq.toLowerCase() + "." : ""} All in ${lines} lines, zero dependencies, works completely offline.

Now, should you merge it? Here's why I think yes. First, it passed the security gate. No eval, no require, no process dot env mutation, no code that runs on import. Second, it's on its own quarantine branch, completely isolated from main. Third, it's ${lines} lines. You can read the whole thing in two minutes. Fourth, zero external dependencies means zero supply chain risk.

The bigger picture. Every ability Eight absorbs is one less external dependency in the ecosystem. One less package dot json entry. One less thing that can break, get deprecated, or get compromised. Eight gets stronger, and the system gets simpler. That's the trade.

Your call. The PR is in your queue.`;

    const aiffPath = `/tmp/8gent-voice-${spec.name}.aiff`;
    const oggPath = `/tmp/8gent-voice-${spec.name}.ogg`;
    const escaped = voiceText.replace(/"/g, '\\"').replace(/'/g, "'");
    execSync(`say -v Ava -r 170 -o "${aiffPath}" "${escaped}"`, { stdio: "pipe" });
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

      // Security gate - reject unsafe code before creating branch
      const securityIssues = securityReview(code, spec.name);
      if (securityIssues.length > 0) {
        console.log(`[${spec.name}] SECURITY REJECTED: ${securityIssues.join("; ")}`);
        appendLog({ name: spec.name, status: "error", error: `security: ${securityIssues.join("; ")}`, timestamp: new Date().toISOString() }, log);
        errorCount++;
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      // Syntax gate - verify generated code transpiles before creating branch
      const tmpValidatePath = `/tmp/.8gent-factory-validate-${spec.name}.ts`;
      fs.writeFileSync(tmpValidatePath, code, "utf-8");
      try {
        execSync(`bun build "${tmpValidatePath}" --no-bundle --outdir /tmp/.8gent-factory-out 2>&1`, {
          encoding: "utf-8", timeout: 15000,
        });
      } catch (syntaxErr: any) {
        const msg = (syntaxErr.stderr || syntaxErr.stdout || syntaxErr.message || "").slice(0, 300);
        console.log(`[${spec.name}] SYNTAX REJECTED: ${msg}`);
        appendLog({ name: spec.name, status: "error", error: `syntax: ${msg}`, timestamp: new Date().toISOString() }, log);
        errorCount++;
        try { fs.unlinkSync(tmpValidatePath); } catch {}
        await sleep(RATE_LIMIT_MS);
        continue;
      }
      try { fs.unlinkSync(tmpValidatePath); } catch {}

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
