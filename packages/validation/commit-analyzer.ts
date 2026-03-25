/**
 * Commit Analyzer - Conventional Commit compliance checker
 *
 * Analyzes git commit messages for:
 * - Conventional Commits format (type(scope): description)
 * - Breaking change detection (! suffix or BREAKING CHANGE footer)
 * - Scope extraction and validation
 * - Quality scoring (0-100)
 */

// --- Types ---

export interface CommitAnalysis {
  raw: string;
  valid: boolean;
  type: string | null;
  scope: string | null;
  description: string | null;
  breaking: boolean;
  body: string | null;
  footers: Record<string, string>;
  quality: number;
  issues: string[];
}

const VALID_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
] as const;

// Conventional commit header: type(scope)!: description
const HEADER_RE =
  /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9_./-]+)\))?(?<bang>!)?:\s+(?<desc>.+)$/i;

const FOOTER_RE = /^(?<key>[A-Za-z-]+|BREAKING CHANGE):\s+(?<val>.+)$/;

// --- Core ---

export function analyzeCommit(message: string): CommitAnalysis {
  const lines = message.split("\n");
  const header = lines[0]?.trim() ?? "";
  const issues: string[] = [];

  const match = HEADER_RE.exec(header);

  if (!match?.groups) {
    return {
      raw: message,
      valid: false,
      type: null,
      scope: null,
      description: null,
      breaking: false,
      body: null,
      footers: {},
      quality: 0,
      issues: ["Header does not match conventional commit format"],
    };
  }

  const { type, scope, bang, desc } = match.groups;

  // Validate type
  const typeLower = type.toLowerCase();
  if (!VALID_TYPES.includes(typeLower as (typeof VALID_TYPES)[number])) {
    issues.push(`Unknown type "${type}" - expected one of: ${VALID_TYPES.join(", ")}`);
  }

  // Parse body and footers
  let body: string | null = null;
  const footers: Record<string, string> = {};
  let breaking = !!bang;

  if (lines.length > 1) {
    if (lines[1]?.trim() !== "") {
      issues.push("Missing blank line between header and body");
    }

    const bodyLines: string[] = [];
    let inFooters = false;

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      const footerMatch = FOOTER_RE.exec(line);
      if (footerMatch?.groups) {
        inFooters = true;
        footers[footerMatch.groups.key] = footerMatch.groups.val;
        if (footerMatch.groups.key === "BREAKING CHANGE") {
          breaking = true;
        }
      } else if (!inFooters) {
        bodyLines.push(line);
      }
    }

    const joined = bodyLines.join("\n").trim();
    if (joined) body = joined;
  }

  // Quality scoring
  let quality = 50; // Base score for valid format

  // Type bonus
  if (VALID_TYPES.includes(typeLower as (typeof VALID_TYPES)[number])) quality += 10;

  // Scope bonus
  if (scope) quality += 10;

  // Description quality
  if (desc.length >= 10 && desc.length <= 72) quality += 15;
  else if (desc.length > 72) issues.push("Description exceeds 72 characters");
  else if (desc.length < 10) issues.push("Description is very short");

  // Lowercase start
  if (desc[0] === desc[0].toLowerCase()) quality += 5;
  else issues.push("Description should start lowercase");

  // No trailing period
  if (!desc.endsWith(".")) quality += 5;
  else issues.push("Description should not end with a period");

  // Body bonus
  if (body) quality += 5;

  quality = Math.min(100, Math.max(0, quality));

  return {
    raw: message,
    valid: issues.length === 0,
    type: typeLower,
    scope: scope ?? null,
    description: desc,
    breaking,
    body,
    footers,
    quality,
    issues,
  };
}

/** Analyze multiple commit messages and return aggregate stats */
export function analyzeCommits(messages: string[]): {
  results: CommitAnalysis[];
  compliance: number;
  averageQuality: number;
  typeDistribution: Record<string, number>;
} {
  const results = messages.map(analyzeCommit);
  const valid = results.filter((r) => r.valid).length;
  const types: Record<string, number> = {};

  for (const r of results) {
    if (r.type) types[r.type] = (types[r.type] ?? 0) + 1;
  }

  return {
    results,
    compliance: results.length ? Math.round((valid / results.length) * 100) : 0,
    averageQuality: results.length
      ? Math.round(results.reduce((s, r) => s + r.quality, 0) / results.length)
      : 0,
    typeDistribution: types,
  };
}
