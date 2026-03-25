/**
 * Telegram Command Handler - Structured command dispatch for the Telegram bridge.
 *
 * Each command returns formatted Telegram-friendly text (Markdown).
 * The bridge calls `handleCommand(text)` and sends the result.
 * No side effects - pure text generation from system state.
 *
 * Commands: /status, /prs, /health, /standup, /scan
 */

import { execSync } from "child_process";

// ── Types ────────────────────────────────────────────────────────────

export interface CommandResult {
  text: string;
  parseMode: "Markdown" | "HTML";
}

type CommandHandler = (args: string) => Promise<CommandResult>;

// ── Helpers ──────────────────────────────────────────────────────────

function run(cmd: string, timeoutMs = 10_000): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: timeoutMs }).trim();
  } catch {
    return "";
  }
}

function markdown(text: string): CommandResult {
  return { text, parseMode: "Markdown" };
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ── Command: /status ─────────────────────────────────────────────────

async function statusCommand(_args: string): Promise<CommandResult> {
  let daemonStatus = "unknown";
  let sessions = 0;
  let uptime = 0;
  try {
    const daemonUrl = process.env.DAEMON_URL || "http://localhost:18789";
    const httpUrl = daemonUrl.replace("ws://", "http://").replace("wss://", "https://");
    const res = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json() as { status?: string; sessions?: number; uptime?: number };
    daemonStatus = data.status || "ok";
    sessions = data.sessions || 0;
    uptime = data.uptime || 0;
  } catch {
    daemonStatus = "unreachable";
  }

  let ollamaStatus = "not running";
  let ollamaModels: string[] = [];
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    const data = await res.json() as { models?: Array<{ name: string }> };
    ollamaStatus = "running";
    ollamaModels = (data.models || []).map((m) => m.name).slice(0, 5);
  } catch { /* stays "not running" */ }

  const branch = run("git rev-parse --abbrev-ref HEAD");
  const lastCommit = run("git log -1 --format='%h %s'");
  const uptimeStr = uptime > 0
    ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
    : "n/a";

  const lines = [
    "*Eight System Status*",
    "",
    `Daemon: ${daemonStatus}`,
    `Sessions: ${sessions}`,
    `Uptime: ${uptimeStr}`,
    "",
    `Ollama: ${ollamaStatus}`,
    ollamaModels.length > 0 ? `Models: ${ollamaModels.join(", ")}` : "",
    "",
    `Branch: \`${branch}\``,
    `Last commit: \`${lastCommit}\``,
    "",
    `Checked: ${timestamp()}`,
  ].filter(Boolean);

  return markdown(lines.join("\n"));
}

// ── Command: /prs ────────────────────────────────────────────────────

async function prsCommand(_args: string): Promise<CommandResult> {
  const ghOutput = run("gh pr list --state open --limit 10 --json number,title,author,updatedAt 2>/dev/null");

  if (!ghOutput) {
    return markdown("*Open PRs*\n\nNo open PRs found (or `gh` CLI not available).");
  }

  try {
    const prs = JSON.parse(ghOutput) as Array<{
      number: number;
      title: string;
      author: { login: string };
      updatedAt: string;
    }>;

    if (prs.length === 0) return markdown("*Open PRs*\n\nNo open pull requests.");

    const lines = ["*Open PRs*", ""];
    for (const pr of prs) {
      const age = timeSince(new Date(pr.updatedAt));
      lines.push(`#${pr.number} - ${pr.title}`);
      lines.push(`  by ${pr.author.login}, updated ${age}`);
    }
    return markdown(lines.join("\n"));
  } catch {
    return markdown("*Open PRs*\n\nFailed to parse PR data.");
  }
}

// ── Command: /health ─────────────────────────────────────────────────

async function healthCommand(_args: string): Promise<CommandResult> {
  const tscOutput = run("bunx tsc --noEmit --pretty false 2>&1 | tail -5", 30_000);
  const typeErrors = tscOutput ? (tscOutput.match(/error TS/g) || []).length : -1;

  const gitStatus = run("git status --porcelain 2>/dev/null");
  const uncommitted = gitStatus ? gitStatus.split("\n").filter(Boolean).length : 0;

  const pkgDirs = run("ls -d packages/*/package.json 2>/dev/null | wc -l").trim();
  const testFiles = run("find . -name '*.test.ts' -o -name '*.spec.ts' 2>/dev/null | wc -l").trim();

  let score = 100;
  if (typeErrors > 0) score -= Math.min(40, typeErrors * 2);
  if (typeErrors < 0) score -= 10;
  if (uncommitted > 20) score -= 15;
  else if (uncommitted > 5) score -= 5;
  if (Number(testFiles) < 5) score -= 10;
  score = Math.max(0, score);

  const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
  const bar = "\u2588".repeat(Math.floor(score / 10)) + "\u2591".repeat(10 - Math.floor(score / 10));

  return markdown([
    "*Codebase Health*",
    "",
    `Score: [${bar}] ${score}/100 (${grade})`,
    "",
    `Type errors: ${typeErrors >= 0 ? typeErrors : "could not check"}`,
    `Uncommitted files: ${uncommitted}`,
    `Packages: ${pkgDirs}`,
    `Test files: ${testFiles}`,
    "",
    `Checked: ${timestamp()}`,
  ].join("\n"));
}

// ── Command: /standup ────────────────────────────────────────────────

async function standupCommand(_args: string): Promise<CommandResult> {
  const since = new Date(Date.now() - 86400_000).toISOString();
  const recentCommits = run(`git log --since="${since}" --oneline --no-merges 2>/dev/null`);
  const commitLines = recentCommits ? recentCommits.split("\n").filter(Boolean) : [];
  const changedFiles = run(`git diff --stat HEAD~${Math.min(commitLines.length || 1, 20)} 2>/dev/null | tail -1`);
  const branch = run("git rev-parse --abbrev-ref HEAD");
  const prCount = run("gh pr list --state open --json number 2>/dev/null | grep -c number || echo 0").trim();

  const lines = [
    "*Daily Standup*",
    `_${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}_`,
    "",
    "*Done (last 24h):*",
  ];

  if (commitLines.length === 0) {
    lines.push("  No commits in the last 24 hours.");
  } else {
    for (const c of commitLines.slice(0, 8)) lines.push(`  - ${c}`);
    if (commitLines.length > 8) lines.push(`  ... and ${commitLines.length - 8} more`);
  }

  lines.push("", "*Stats:*", `  Commits: ${commitLines.length}`);
  if (changedFiles) lines.push(`  ${changedFiles.trim()}`);
  lines.push(`  Branch: \`${branch}\``, `  Open PRs: ${prCount}`);

  return markdown(lines.join("\n"));
}

// ── Command: /scan ───────────────────────────────────────────────────

async function scanCommand(args: string): Promise<CommandResult> {
  const query = args.trim() || "label:bounty,help-wanted,good-first-issue";
  const ghOutput = run(
    `gh search issues "${query}" --limit 10 --json repository,title,url,labels,updatedAt 2>/dev/null`,
    15_000,
  );

  if (!ghOutput) {
    return markdown("*Market Scan*\n\nNo results (or `gh` CLI not available).\n\nTry: `/scan label:bounty` or `/scan help wanted typescript`");
  }

  try {
    const issues = JSON.parse(ghOutput) as Array<{
      repository: { nameWithOwner: string };
      title: string;
      url: string;
      labels: Array<{ name: string }>;
      updatedAt: string;
    }>;

    if (issues.length === 0) return markdown("*Market Scan*\n\nNo matching issues found.");

    const lines = ["*Market Scan*", `Query: \`${query}\``, ""];
    for (const issue of issues) {
      const labels = issue.labels.map((l) => l.name).join(", ");
      lines.push(`*${issue.repository.nameWithOwner}*`);
      lines.push(`  ${issue.title}`);
      if (labels) lines.push(`  Labels: ${labels}`);
      lines.push(`  Updated: ${timeSince(new Date(issue.updatedAt))}`);
      lines.push(`  ${issue.url}`, "");
    }
    return markdown(lines.join("\n"));
  } catch {
    return markdown("*Market Scan*\n\nFailed to parse search results.");
  }
}

// ── Command Registry ─────────────────────────────────────────────────

const COMMANDS: Record<string, CommandHandler> = {
  "/status": statusCommand,
  "/prs": prsCommand,
  "/health": healthCommand,
  "/standup": standupCommand,
  "/scan": scanCommand,
};

// ── Public API ───────────────────────────────────────────────────────

/**
 * Handle a Telegram command. Returns null if the text is not a recognized command.
 * The bridge should call this before routing to the agent.
 */
export async function handleCommand(text: string): Promise<CommandResult | null> {
  const trimmed = text.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const cmd = spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed;
  const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1) : "";

  const handler = COMMANDS[cmd.toLowerCase()];
  if (!handler) return null;

  try {
    return await handler(args);
  } catch (err) {
    return markdown(`Command \`${cmd}\` failed: ${String(err)}`);
  }
}

/** List all available commands. */
export function listCommands(): string[] {
  return Object.keys(COMMANDS);
}

export { COMMANDS, statusCommand, prsCommand, healthCommand, standupCommand, scanCommand };
