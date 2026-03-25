/**
 * commit-linter.ts
 * Conventional commit format validator for 8gent-code.
 * Zero deps. CLI-runnable via: bun packages/validation/commit-linter.ts "feat: message"
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LintResult {
  valid: boolean;
  score: number; // 0-100
  errors: string[];
  warnings: string[];
  parsed: ParsedCommit | null;
}

export interface ParsedCommit {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
  body: string | null;
  footer: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONVENTIONAL_TYPES = new Set([
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
]);

const MAX_SUBJECT_LENGTH = 72;
const MAX_BODY_LINE_LENGTH = 100;

// Em dash variants - all banned per 8gent-code rules
const EM_DASH_PATTERNS: string[] = [
  "\u2014", // standard em dash
  "\u2013", // en dash (also flagged)
  "\uFE58", // small em dash
  "\uFE31", // presentation form em dash
];

// Conventional commit header regex: type(scope)!: description
const HEADER_REGEX = /^([a-z]+)(\([^)]*\))?(!)?: (.+)$/;

// ---------------------------------------------------------------------------
// Core linter
// ---------------------------------------------------------------------------

export function lintCommit(message: string): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!message || message.trim().length === 0) {
    return {
      valid: false,
      score: 0,
      errors: ["Commit message is empty."],
      warnings: [],
      parsed: null,
    };
  }

  const lines = message.split("\n");
  const header = lines[0].trim();
  const rest = lines.slice(1);

  // -- Em dash detection (hard error, banned in this repo)
  for (const dash of EM_DASH_PATTERNS) {
    if (message.includes(dash)) {
      const label = dash === "\u2013" ? "en dash" : "em dash";
      const code = dash.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
      errors.push(
        `Banned character detected: ${label} (U+${code}). Use a hyphen (-) instead.`
      );
    }
  }

  // -- Parse header
  const match = HEADER_REGEX.exec(header);
  if (!match) {
    errors.push(
      `Header does not follow conventional commit format: <type>(scope)!: <description>. Got: "${header}"`
    );
    const score = Math.max(0, 10 - errors.length * 10);
    return { valid: false, score, errors, warnings, parsed: null };
  }

  const [, rawType, rawScope, breakingBang, description] = match;
  const scope = rawScope ? rawScope.slice(1, -1) : null;
  const breaking = breakingBang === "!";

  // -- Type validation
  if (!CONVENTIONAL_TYPES.has(rawType)) {
    errors.push(
      `Unknown commit type: "${rawType}". Allowed: ${[...CONVENTIONAL_TYPES].join(", ")}.`
    );
  }

  // -- Subject line length
  if (header.length > MAX_SUBJECT_LENGTH) {
    errors.push(
      `Subject line too long: ${header.length} chars (max ${MAX_SUBJECT_LENGTH}). Shorten or move detail to body.`
    );
  } else if (header.length > 60) {
    warnings.push(
      `Subject line is ${header.length} chars. Consider keeping under 60 for readability.`
    );
  }

  // -- Description quality checks
  if (!description || description.trim().length === 0) {
    errors.push("Description is empty after the colon separator.");
  } else {
    if (/^[A-Z]/.test(description)) {
      warnings.push(
        `Description starts with a capital letter. Conventional commits use lowercase.`
      );
    }

    if (description.trimEnd().endsWith(".")) {
      warnings.push("Description ends with a period. Omit the trailing period.");
    }

    const vague = ["update", "changes", "stuff", "misc", "wip", "fix things", "cleanup"];
    const descLower = description.toLowerCase().trim();
    for (const v of vague) {
      if (descLower === v || descLower.startsWith(v + " ") || descLower.endsWith(" " + v)) {
        warnings.push(`Description "${description}" is vague. Be specific about what changed.`);
        break;
      }
    }

    if (description.trim().length < 5) {
      errors.push(`Description is too short: "${description}". Provide meaningful context.`);
    }
  }

  // -- Scope validation (optional; if present must be non-empty kebab-case)
  if (scope !== null) {
    if (scope.trim().length === 0) {
      errors.push("Scope is empty. Either provide a value or omit the parens.");
    } else if (!/^[a-z][a-z0-9-]*$/.test(scope)) {
      warnings.push(
        `Scope "${scope}" should be lowercase kebab-case (e.g., auth, api-client).`
      );
    }
  }

  // -- Blank line between header and body required
  if (rest.length > 0 && rest[0].trim() !== "") {
    errors.push(
      "Missing blank line between subject and body. An empty line is required after the header."
    );
  }

  // -- Body line length
  const bodyLines = rest.slice(1);
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i].length > MAX_BODY_LINE_LENGTH) {
      warnings.push(
        `Body line ${i + 2} exceeds ${MAX_BODY_LINE_LENGTH} chars (${bodyLines[i].length}). Consider wrapping.`
      );
    }
  }

  // -- Breaking change footer check
  if (breaking) {
    const hasBreakingFooter = rest.some(
      (l) => l.startsWith("BREAKING CHANGE:") || l.startsWith("BREAKING-CHANGE:")
    );
    if (!hasBreakingFooter) {
      warnings.push(
        "Commit marked as breaking (!) but no BREAKING CHANGE: footer found. Consider adding one."
      );
    }
  }

  // -- Build parsed result
  const bodyText =
    rest.length <= 1
      ? null
      : rest
          .slice(1)
          .join("\n")
          .trim() || null;

  const parsed: ParsedCommit = {
    type: rawType,
    scope,
    breaking,
    description,
    body: bodyText,
    footer: null,
  };

  // -- Score: 100 - 20 per error - 5 per warning
  const score = Math.max(0, Math.min(100, 100 - errors.length * 20 - warnings.length * 5));
  const valid = errors.length === 0;

  return { valid, score, errors, warnings, parsed };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function formatResult(result: LintResult): string {
  const lines: string[] = [];
  const icon = result.valid ? "[PASS]" : "[FAIL]";
  lines.push(`${icon} Score: ${result.score}/100`);

  if (result.parsed) {
    const { type, scope, breaking, description } = result.parsed;
    const scopeStr = scope ? `(${scope})` : "";
    const bangStr = breaking ? "!" : "";
    lines.push(`  Parsed: ${type}${scopeStr}${bangStr}: ${description}`);
  }

  if (result.errors.length > 0) {
    lines.push("\nErrors:");
    for (const e of result.errors) {
      lines.push(`  ERROR  ${e}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("\nWarnings:");
    for (const w of result.warnings) {
      lines.push(`  WARN   ${w}`);
    }
  }

  if (result.valid && result.warnings.length === 0) {
    lines.push("  All checks passed.");
  }

  return lines.join("\n");
}

// bun packages/validation/commit-linter.ts "feat: my message"
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: bun packages/validation/commit-linter.ts <commit-message>");
    console.error('Example: bun packages/validation/commit-linter.ts "feat(auth): add JWT refresh"');
    process.exit(1);
  }

  const message = args.join(" ");
  const result = lintCommit(message);
  console.log(formatResult(result));
  process.exit(result.valid ? 0 : 1);
}
