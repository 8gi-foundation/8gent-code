/**
 * 8gent - Proactive Code Reviewer
 *
 * Reads recent git diffs and sends them to Ollama for automated code review.
 * Returns structured feedback: bugs, style issues, security concerns, suggestions.
 * Designed to run post-commit (via git hook) or on-demand from the TUI/CLI.
 *
 * No external deps beyond fetch (Ollama API) and child_process (git).
 */

import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "critical" | "warning" | "info";
export type FindingCategory = "bug" | "style" | "security" | "suggestion";

export interface ReviewFinding {
  category: FindingCategory;
  severity: Severity;
  file: string;
  line?: number;
  message: string;
}

export interface CodeReview {
  /** ISO timestamp */
  timestamp: string;
  /** Commit range reviewed */
  commitRange: string;
  /** Number of files changed */
  filesChanged: number;
  /** Number of lines added/removed */
  linesChanged: number;
  /** Individual findings */
  findings: ReviewFinding[];
  /** One-line summary */
  summary: string;
}

export interface ReviewConfig {
  /** Number of recent commits to review. Default: 1 */
  commitCount?: number;
  /** Ollama model to use. Default: qwen3:0.6b */
  model?: string;
  /** Ollama base URL. Default: http://localhost:11434 */
  ollamaUrl?: string;
  /** Working directory (git repo root). Default: cwd */
  cwd?: string;
  /** Max diff size in chars before truncation. Default: 8000 */
  maxDiffChars?: number;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function gitDiff(commitCount: number, cwd: string): string {
  try {
    return execSync(`git diff HEAD~${commitCount}..HEAD`, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch {
    // Fallback: if not enough commits, diff the whole tree
    return execSync("git diff HEAD", { cwd, encoding: "utf-8" }).trim();
  }
}

function gitDiffStats(commitCount: number, cwd: string): { files: number; lines: number } {
  try {
    const stat = execSync(`git diff --stat HEAD~${commitCount}..HEAD`, {
      cwd,
      encoding: "utf-8",
    }).trim();
    const lines = stat.split("\n");
    const summary = lines[lines.length - 1] || "";
    const filesMatch = summary.match(/(\d+)\s+files?\s+changed/);
    const insMatch = summary.match(/(\d+)\s+insertions?/);
    const delMatch = summary.match(/(\d+)\s+deletions?/);
    return {
      files: parseInt(filesMatch?.[1] || "0"),
      lines: parseInt(insMatch?.[1] || "0") + parseInt(delMatch?.[1] || "0"),
    };
  } catch {
    return { files: 0, lines: 0 };
  }
}

function gitCommitRange(commitCount: number, cwd: string): string {
  try {
    const from = execSync(`git rev-parse --short HEAD~${commitCount}`, { cwd, encoding: "utf-8" }).trim();
    const to = execSync("git rev-parse --short HEAD", { cwd, encoding: "utf-8" }).trim();
    return `${from}..${to}`;
  } catch {
    return "HEAD";
  }
}

// ---------------------------------------------------------------------------
// Ollama integration
// ---------------------------------------------------------------------------

const REVIEW_PROMPT = `You are a senior code reviewer. Analyze the following git diff and return a JSON object with exactly this shape:

{
  "findings": [
    {
      "category": "bug" | "style" | "security" | "suggestion",
      "severity": "critical" | "warning" | "info",
      "file": "path/to/file.ts",
      "line": 42,
      "message": "Brief description of the issue"
    }
  ],
  "summary": "One sentence overall summary"
}

Rules:
- Only report real issues. Do not invent problems.
- "bug": logic errors, null refs, off-by-one, race conditions.
- "security": SQL injection, XSS, secrets in code, path traversal.
- "style": naming, dead code, missing types, overly complex logic.
- "suggestion": refactoring ideas, better APIs, performance wins.
- Keep messages under 120 chars each.
- If the diff is clean, return an empty findings array with a positive summary.
- Return ONLY valid JSON, no markdown fences, no explanation.

Diff:
`;

async function callOllama(
  diff: string,
  model: string,
  ollamaUrl: string,
): Promise<{ findings: ReviewFinding[]; summary: string }> {
  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: REVIEW_PROMPT + diff }],
      stream: false,
      format: "json",
      think: false,
      options: { num_predict: 2048, temperature: 0.2 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { message?: { content?: string } };
  const raw = data.message?.content || "{}";

  try {
    const parsed = JSON.parse(raw);
    return {
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : "No summary",
    };
  } catch {
    return { findings: [], summary: `Failed to parse model output: ${raw.slice(0, 100)}` };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a code review on recent commits.
 */
export async function reviewRecentCommits(config: ReviewConfig = {}): Promise<CodeReview> {
  const commitCount = config.commitCount ?? 1;
  const model = config.model ?? "qwen3:0.6b";
  const ollamaUrl = config.ollamaUrl ?? process.env.OLLAMA_URL ?? "http://localhost:11434";
  const cwd = config.cwd ?? process.cwd();
  const maxDiffChars = config.maxDiffChars ?? 8000;

  let diff = gitDiff(commitCount, cwd);
  if (diff.length > maxDiffChars) {
    diff = diff.slice(0, maxDiffChars) + "\n... [truncated]";
  }

  if (!diff) {
    return {
      timestamp: new Date().toISOString(),
      commitRange: gitCommitRange(commitCount, cwd),
      filesChanged: 0,
      linesChanged: 0,
      findings: [],
      summary: "No changes to review.",
    };
  }

  const stats = gitDiffStats(commitCount, cwd);
  const { findings, summary } = await callOllama(diff, model, ollamaUrl);

  return {
    timestamp: new Date().toISOString(),
    commitRange: gitCommitRange(commitCount, cwd),
    filesChanged: stats.files,
    linesChanged: stats.lines,
    findings,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Formatting - TUI / Telegram output
// ---------------------------------------------------------------------------

const SEVERITY_ICON: Record<Severity, string> = {
  critical: "[!!]",
  warning: "[!]",
  info: "[i]",
};

const CATEGORY_LABEL: Record<FindingCategory, string> = {
  bug: "BUG",
  style: "STYLE",
  security: "SEC",
  suggestion: "TIP",
};

/**
 * Format a review for terminal / TUI display.
 */
export function formatForTUI(review: CodeReview): string {
  const header = `Code Review - ${review.commitRange} (${review.filesChanged} files, ${review.linesChanged} lines)`;
  const divider = "-".repeat(header.length);

  if (review.findings.length === 0) {
    return `${header}\n${divider}\nAll clear. ${review.summary}`;
  }

  const lines = review.findings.map((f) => {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    return `  ${SEVERITY_ICON[f.severity]} [${CATEGORY_LABEL[f.category]}] ${loc} - ${f.message}`;
  });

  return `${header}\n${divider}\n${lines.join("\n")}\n${divider}\n${review.summary}`;
}

/**
 * Format a review for Telegram (markdown).
 */
export function formatForTelegram(review: CodeReview): string {
  const header = `*Code Review* - \`${review.commitRange}\`\n${review.filesChanged} files, ${review.linesChanged} lines`;

  if (review.findings.length === 0) {
    return `${header}\n\nAll clear. ${review.summary}`;
  }

  const critical = review.findings.filter((f) => f.severity === "critical");
  const warnings = review.findings.filter((f) => f.severity === "warning");
  const info = review.findings.filter((f) => f.severity === "info");

  const sections: string[] = [];

  if (critical.length > 0) {
    sections.push("*Critical:*\n" + critical.map((f) => `- \`${f.file}\` - ${f.message}`).join("\n"));
  }
  if (warnings.length > 0) {
    sections.push("*Warnings:*\n" + warnings.map((f) => `- \`${f.file}\` - ${f.message}`).join("\n"));
  }
  if (info.length > 0) {
    sections.push("*Info:*\n" + info.map((f) => `- \`${f.file}\` - ${f.message}`).join("\n"));
  }

  return `${header}\n\n${sections.join("\n\n")}\n\n_${review.summary}_`;
}
