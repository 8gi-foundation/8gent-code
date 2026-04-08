/**
 * Telegram Daily Digest - Morning summary of 8gent project activity.
 *
 * Aggregates git commits (last 24h), open PRs, benchmark scores, and daemon uptime.
 * Sends a formatted digest via Telegram bot API.
 *
 * Usage: bun run packages/proactive/telegram-digest.ts
 * Env:   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in ~/.claude/.env
 */

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const TELEGRAM_API = "https://api.telegram.org/bot";
const REPO_ROOT = join(import.meta.dir, "../..");

// ---------------------------------------------------------------------------
// Env loading
// ---------------------------------------------------------------------------

function loadEnv(): { token: string; chatId: string } {
  const envPath = join(process.env.HOME || "~", ".claude/.env");
  if (!existsSync(envPath)) {
    throw new Error(`Missing env file: ${envPath}`);
  }
  const raw = readFileSync(envPath, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match) vars[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  const token = vars.TELEGRAM_BOT_TOKEN;
  const chatId = vars.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required in ~/.claude/.env");
  }
  return { token, chatId };
}

// ---------------------------------------------------------------------------
// Git activity (last 24h)
// ---------------------------------------------------------------------------

interface GitDigest {
  commitCount: number;
  filesChanged: number;
  authors: Map<string, number>;
  topMessages: string[];
}

function getGitDigest(): GitDigest {
  const since = "--since='24 hours ago'";
  const opts = { cwd: REPO_ROOT, encoding: "utf-8" as const };

  let commitCount = 0;
  let filesChanged = 0;
  const authors = new Map<string, number>();
  const topMessages: string[] = [];

  try {
    const log = execSync(`git log ${since} --pretty=format:"%an|||%s" --no-merges`, opts).trim();
    if (!log) return { commitCount: 0, filesChanged: 0, authors, topMessages };

    const lines = log.split("\n").filter(Boolean);
    commitCount = lines.length;

    for (const line of lines) {
      const [author, msg] = line.split("|||");
      if (author) authors.set(author, (authors.get(author) || 0) + 1);
      if (msg && topMessages.length < 5) topMessages.push(msg);
    }

    const diffStat = execSync(`git diff --stat HEAD~${Math.min(commitCount, 50)} HEAD --shortstat`, opts).trim();
    const filesMatch = diffStat.match(/(\d+) files? changed/);
    if (filesMatch) filesChanged = parseInt(filesMatch[1], 10);
  } catch {
    // No commits or git error - return defaults
  }

  return { commitCount, filesChanged, authors, topMessages };
}

// ---------------------------------------------------------------------------
// GitHub PRs (via gh CLI)
// ---------------------------------------------------------------------------

interface PrDigest {
  open: number;
  merged24h: number;
}

function getPrDigest(): PrDigest {
  try {
    const opts = { cwd: REPO_ROOT, encoding: "utf-8" as const };
    const openRaw = execSync("gh pr list --state open --json number --jq 'length'", opts).trim();
    const mergedRaw = execSync(
      "gh pr list --state merged --json mergedAt --jq '[.[] | select(.mergedAt > (now - 86400 | todate))] | length'",
      opts
    ).trim();
    return {
      open: parseInt(openRaw, 10) || 0,
      merged24h: parseInt(mergedRaw, 10) || 0,
    };
  } catch {
    return { open: 0, merged24h: 0 };
  }
}

// ---------------------------------------------------------------------------
// Benchmark scores (from autoresearch report)
// ---------------------------------------------------------------------------

function getBenchmarkSummary(): string {
  const reportPath = join(REPO_ROOT, "benchmarks/autoresearch/autoresearch-report.json");
  try {
    if (!existsSync(reportPath)) return "No benchmark report found";
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    if (report.overallScore != null) {
      return `Overall: ${(report.overallScore * 100).toFixed(1)}%`;
    }
    if (report.results && Array.isArray(report.results)) {
      return `${report.results.length} benchmarks recorded`;
    }
    return "Report exists, no summary score";
  } catch {
    return "Could not parse benchmark report";
  }
}

// ---------------------------------------------------------------------------
// Daemon uptime
// ---------------------------------------------------------------------------

function getDaemonUptime(): string {
  try {
    const res = execSync("curl -sf --max-time 3 https://eight-vessel.fly.dev/health", {
      encoding: "utf-8",
    }).trim();
    const data = JSON.parse(res);
    if (data.uptime) return `Up ${Math.floor(data.uptime / 3600)}h ${Math.floor((data.uptime % 3600) / 60)}m`;
    return "Online";
  } catch {
    return "Offline or unreachable";
  }
}

// ---------------------------------------------------------------------------
// Format message
// ---------------------------------------------------------------------------

function formatDigest(git: GitDigest, prs: PrDigest, benchmark: string, daemon: string): string {
  const now = new Date().toLocaleDateString("en-IE", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const authorList = [...git.authors.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `  ${name}: ${count}`)
    .join("\n");

  const commitList = git.topMessages.map((m) => `  - ${m}`).join("\n");

  return [
    `*8gent Daily Digest*`,
    `${now}`,
    ``,
    `*Git Activity (24h)*`,
    `Commits: ${git.commitCount}`,
    `Files changed: ${git.filesChanged}`,
    git.authors.size > 0 ? `Contributors:\n${authorList}` : "",
    git.topMessages.length > 0 ? `Recent:\n${commitList}` : "",
    ``,
    `*Pull Requests*`,
    `Open: ${prs.open}`,
    `Merged (24h): ${prs.merged24h}`,
    ``,
    `*Benchmarks*`,
    benchmark,
    ``,
    `*Daemon (Vessel)*`,
    daemon,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API ${res.status}: ${body}`);
  }
  console.log("Digest sent successfully.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { token, chatId } = loadEnv();

  console.log("Collecting git activity...");
  const git = getGitDigest();

  console.log("Checking PRs...");
  const prs = getPrDigest();

  console.log("Reading benchmarks...");
  const benchmark = getBenchmarkSummary();

  console.log("Checking daemon...");
  const daemon = getDaemonUptime();

  const message = formatDigest(git, prs, benchmark, daemon);
  console.log("\n--- Preview ---\n");
  console.log(message);
  console.log("\n--- Sending ---\n");

  await sendTelegram(token, chatId, message);
}

main().catch((err) => {
  console.error("Digest failed:", err.message);
  process.exit(1);
});
