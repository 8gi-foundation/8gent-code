/**
 * regex-tester.ts
 * Test regex patterns, show matches with capture groups, explain patterns.
 * Zero dependencies. CLI-ready.
 *
 * Exports: testRegex(), explainRegex()
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegexMatch {
  fullMatch: string;
  index: number;
  groups: string[];
  namedGroups: Record<string, string> | null;
}

export interface RegexTestResult {
  pattern: string;
  flags: string;
  input: string;
  matches: RegexMatch[];
  matchCount: number;
  isValid: boolean;
  error: string | null;
}

export interface RegexExplanation {
  pattern: string;
  tokens: TokenExplanation[];
  summary: string;
}

export interface TokenExplanation {
  token: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const PRESETS: Record<string, { pattern: string; flags: string; description: string }> = {
  email: {
    pattern: "[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}",
    flags: "g",
    description: "Email address",
  },
  url: {
    pattern: "https?:\\/\\/(?:www\\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\\.[a-zA-Z0-9()]{1,6}\\b(?:[-a-zA-Z0-9()@:%_+.~#?&/=]*)",
    flags: "gi",
    description: "HTTP/HTTPS URL",
  },
  semver: {
    pattern: "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?",
    flags: "g",
    description: "Semantic version (SemVer)",
  },
  ipv4: {
    pattern: "(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)",
    flags: "g",
    description: "IPv4 address",
  },
  date_iso: {
    pattern: "\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])",
    flags: "g",
    description: "ISO 8601 date (YYYY-MM-DD)",
  },
  hex_color: {
    pattern: "#(?:[0-9a-fA-F]{3}){1,2}",
    flags: "g",
    description: "Hex color code",
  },
  slug: {
    pattern: "[a-z0-9]+(?:-[a-z0-9]+)*",
    flags: "g",
    description: "URL slug",
  },
  uuid: {
    pattern: "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
    flags: "gi",
    description: "UUID v1-v5",
  },
};

// ---------------------------------------------------------------------------
// Core: testRegex
// ---------------------------------------------------------------------------

export function testRegex(
  pattern: string,
  input: string,
  flags = "g",
  preset?: string
): RegexTestResult {
  let resolvedPattern = pattern;
  let resolvedFlags = flags;

  if (preset && PRESETS[preset]) {
    resolvedPattern = PRESETS[preset].pattern;
    resolvedFlags = PRESETS[preset].flags;
  }

  const result: RegexTestResult = {
    pattern: resolvedPattern,
    flags: resolvedFlags,
    input,
    matches: [],
    matchCount: 0,
    isValid: true,
    error: null,
  };

  let regex: RegExp;
  try {
    regex = new RegExp(resolvedPattern, resolvedFlags.includes("g") ? resolvedFlags : resolvedFlags + "g");
  } catch (err) {
    result.isValid = false;
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }

  const allMatches = [...input.matchAll(regex)];
  result.matchCount = allMatches.length;
  result.matches = allMatches.map((m) => ({
    fullMatch: m[0],
    index: m.index ?? 0,
    groups: m.slice(1).map((g) => g ?? ""),
    namedGroups: m.groups ? { ...m.groups } : null,
  }));

  return result;
}

// ---------------------------------------------------------------------------
// Core: explainRegex
// ---------------------------------------------------------------------------

const TOKEN_MAP: Array<{ re: RegExp; describe: (m: string) => string }> = [
  { re: /^\^/, describe: () => "Start of string/line" },
  { re: /^\$/, describe: () => "End of string/line" },
  { re: /^\\./, describe: (m) => describeEscape(m) },
  { re: /^\[(?:\^)?(?:[^\]\\]|\\.)*\]/, describe: (m) => describeCharClass(m) },
  { re: /^\((?:\?(?:<[a-zA-Z]+>|[:=!<])?)?/, describe: (m) => describeGroup(m) },
  { re: /^\)/, describe: () => "End of group" },
  { re: /^\{(\d+)(?:,(\d*)?)?\}/, describe: (m) => describeQuantifier(m) },
  { re: /^[*+?]/, describe: (m) => describeSimpleQuantifier(m) },
  { re: /^\|/, describe: () => "Alternation (OR)" },
  { re: /^\./, describe: () => "Any character except newline" },
  { re: /^[a-zA-Z0-9]/, describe: (m) => `Literal character "${m}"` },
  { re: /^[^a-zA-Z0-9\s]/, describe: (m) => `Literal symbol "${m}"` },
];

function describeEscape(m: string): string {
  const map: Record<string, string> = {
    "\\d": "Digit [0-9]",
    "\\D": "Non-digit",
    "\\w": "Word character [a-zA-Z0-9_]",
    "\\W": "Non-word character",
    "\\s": "Whitespace",
    "\\S": "Non-whitespace",
    "\\b": "Word boundary",
    "\\B": "Non-word boundary",
    "\\n": "Newline",
    "\\t": "Tab",
    "\\r": "Carriage return",
    "\\.": 'Literal "."',
    "\\-": 'Literal "-"',
    "\\+": 'Literal "+"',
    "\\*": 'Literal "*"',
    "\\?": 'Literal "?"',
    "\\(": 'Literal "("',
    "\\)": 'Literal ")"',
    "\\[": 'Literal "["',
    "\\]": 'Literal "]"',
    "\\{": 'Literal "{"',
    "\\}": 'Literal "}"',
    "\\^": 'Literal "^"',
    "\\$": 'Literal "$"',
    "\\/": 'Literal "/"',
    "\\\\": 'Literal backslash "\\"',
  };
  return map[m] ?? `Escaped character "${m}"`;
}

function describeCharClass(m: string): string {
  const negated = m[1] === "^";
  const inner = negated ? m.slice(2, -1) : m.slice(1, -1);
  return `${negated ? "Negated character class" : "Character class"}: [${inner}]`;
}

function describeGroup(m: string): string {
  if (m.startsWith("(?<")) return `Named capture group "<${m.slice(3)}>"`;
  if (m === "(?:") return "Non-capturing group";
  if (m === "(?=") return "Positive lookahead";
  if (m === "(?!") return "Negative lookahead";
  if (m === "(?<=") return "Positive lookbehind";
  if (m === "(?<!") return "Negative lookbehind";
  return "Capture group";
}

function describeQuantifier(m: string): string {
  const inner = m.slice(1, -1);
  if (inner.includes(",")) {
    const [min, max] = inner.split(",");
    return max === "" ? `At least ${min} times` : `Between ${min} and ${max} times`;
  }
  return `Exactly ${inner} times`;
}

function describeSimpleQuantifier(m: string): string {
  const map: Record<string, string> = {
    "*": "Zero or more times (greedy)",
    "+": "One or more times (greedy)",
    "?": "Zero or one time (optional)",
  };
  return map[m] ?? `Quantifier "${m}"`;
}

export function explainRegex(pattern: string): RegexExplanation {
  const tokens: TokenExplanation[] = [];
  let remaining = pattern;

  while (remaining.length > 0) {
    let matched = false;
    for (const { re, describe } of TOKEN_MAP) {
      const m = remaining.match(re);
      if (m) {
        tokens.push({ token: m[0], description: describe(m[0]) });
        remaining = remaining.slice(m[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      // fallback - consume one char
      tokens.push({ token: remaining[0], description: `Character "${remaining[0]}"` });
      remaining = remaining.slice(1);
    }
  }

  const summary = buildSummary(tokens);
  return { pattern, tokens, summary };
}

function buildSummary(tokens: TokenExplanation[]): string {
  if (tokens.length === 0) return "Empty pattern - matches everything.";
  const parts = tokens.map((t) => t.description);
  return parts.join(", then ") + ".";
}

// ---------------------------------------------------------------------------
// Formatting helpers (for CLI output)
// ---------------------------------------------------------------------------

function formatResult(result: RegexTestResult): string {
  const lines: string[] = [];
  lines.push(`Pattern : /${result.pattern}/${result.flags}`);
  lines.push(`Input   : ${JSON.stringify(result.input)}`);

  if (!result.isValid) {
    lines.push(`ERROR   : ${result.error}`);
    return lines.join("\n");
  }

  lines.push(`Matches : ${result.matchCount}`);

  if (result.matchCount === 0) {
    lines.push("(no matches)");
    return lines.join("\n");
  }

  result.matches.forEach((m, i) => {
    lines.push(`\n  [${i + 1}] "${m.fullMatch}" at index ${m.index}`);
    if (m.groups.length > 0) {
      m.groups.forEach((g, gi) => {
        lines.push(`      Group ${gi + 1}: ${JSON.stringify(g)}`);
      });
    }
    if (m.namedGroups) {
      for (const [k, v] of Object.entries(m.namedGroups)) {
        lines.push(`      Named <${k}>: ${JSON.stringify(v)}`);
      }
    }
  });

  return lines.join("\n");
}

function formatExplanation(exp: RegexExplanation): string {
  const lines: string[] = [];
  lines.push(`Pattern : /${exp.pattern}/`);
  lines.push(`Summary : ${exp.summary}`);
  lines.push("\nToken breakdown:");
  exp.tokens.forEach((t) => {
    lines.push(`  ${JSON.stringify(t.token).padEnd(12)} ${t.description}`);
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
regex-tester - Test and explain regex patterns

Usage:
  bun packages/tools/regex-tester.ts test <pattern> <input> [flags]
  bun packages/tools/regex-tester.ts preset <name> <input>
  bun packages/tools/regex-tester.ts explain <pattern>
  bun packages/tools/regex-tester.ts presets

Examples:
  bun packages/tools/regex-tester.ts test "(\\w+)@(\\w+)\\.\\w+" "hello@example.com" g
  bun packages/tools/regex-tester.ts preset email "contact me at user@example.com or admin@test.org"
  bun packages/tools/regex-tester.ts explain "(\\d{4})-(\\d{2})-(\\d{2})"
  bun packages/tools/regex-tester.ts presets

Available presets: ${Object.keys(PRESETS).join(", ")}
`);
}

if (import.meta.main) {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "test": {
      const [pattern, input, flags] = args;
      if (!pattern || !input) {
        console.error("Error: test requires <pattern> and <input>");
        process.exit(1);
      }
      const result = testRegex(pattern, input, flags ?? "g");
      console.log(formatResult(result));
      break;
    }
    case "preset": {
      const [name, input] = args;
      if (!name || !input) {
        console.error("Error: preset requires <name> and <input>");
        process.exit(1);
      }
      if (!PRESETS[name]) {
        console.error(`Error: unknown preset "${name}". Available: ${Object.keys(PRESETS).join(", ")}`);
        process.exit(1);
      }
      const result = testRegex("", input, "", name);
      console.log(`Preset  : ${name} - ${PRESETS[name].description}`);
      console.log(formatResult(result));
      break;
    }
    case "explain": {
      const [pattern] = args;
      if (!pattern) {
        console.error("Error: explain requires <pattern>");
        process.exit(1);
      }
      const exp = explainRegex(pattern);
      console.log(formatExplanation(exp));
      break;
    }
    case "presets": {
      console.log("Available presets:\n");
      for (const [name, p] of Object.entries(PRESETS)) {
        console.log(`  ${name.padEnd(12)} ${p.description}`);
        console.log(`               /${p.pattern}/${p.flags}\n`);
      }
      break;
    }
    default:
      printHelp();
      break;
  }
}
