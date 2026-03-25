/**
 * commit-linter.ts - Conventional commit validator for 8gent-code.
 * Zero deps. CLI: bun packages/validation/commit-linter.ts "feat: message"
 */

export interface LintResult {
  valid: boolean;
  score: number;
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

const CONVENTIONAL_TYPES = new Set([
  "feat","fix","docs","style","refactor","perf","test","build","ci","chore","revert",
]);
const MAX_SUBJECT = 72;
const MAX_BODY_LINE = 100;
const EM_DASHES: Array<[string,string]> = [
  ["\u2014","em dash"],["\u2013","en dash"],["\uFE58","small em dash"],["\uFE31","presentation em dash"],
];
const HEADER_RE = /^([a-z]+)(\([^)]*\))?(!)?: (.+)$/;

export function lintCommit(message: string): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!message?.trim()) {
    return { valid:false, score:0, errors:["Commit message is empty."], warnings:[], parsed:null };
  }
  const lines = message.split("\n");
  const header = lines[0].trim();
  const rest = lines.slice(1);

  for (const [ch, label] of EM_DASHES) {
    if (message.includes(ch)) {
      const code = ch.charCodeAt(0).toString(16).toUpperCase().padStart(4,"0");
      errors.push(`Banned character: ${label} (U+${code}). Use a hyphen (-) instead.`);
    }
  }

  const m = HEADER_RE.exec(header);
  if (!m) {
    errors.push(`Header must be: <type>(scope)!: <description>. Got: "${header}"`);
    return { valid:false, score:Math.max(0,10-errors.length*10), errors, warnings, parsed:null };
  }

  const [, rawType, rawScope, bang, description] = m;
  const scope = rawScope ? rawScope.slice(1,-1) : null;
  const breaking = bang === "!";

  if (!CONVENTIONAL_TYPES.has(rawType)) {
    errors.push(`Unknown type "${rawType}". Allowed: ${[...CONVENTIONAL_TYPES].join(", ")}.`);
  }
  if (header.length > MAX_SUBJECT) {
    errors.push(`Subject too long: ${header.length} chars (max ${MAX_SUBJECT}).`);
  } else if (header.length > 60) {
    warnings.push(`Subject is ${header.length} chars. Consider keeping under 60.`);
  }
  if (!description?.trim()) {
    errors.push("Description is empty after the colon.");
  } else {
    if (/^[A-Z]/.test(description)) warnings.push("Description starts with a capital. Use lowercase.");
    if (description.trimEnd().endsWith(".")) warnings.push("Description ends with a period. Omit it.");
    const dl = description.toLowerCase().trim();
    const vague = ["update","changes","stuff","misc","wip","fix things","cleanup"];
    if (vague.some((v) => dl===v || dl.startsWith(v+" ") || dl.endsWith(" "+v))) {
      warnings.push(`Description "${description}" is vague. Be specific.`);
    }
    if (description.trim().length < 5) errors.push(`Description too short: "${description}".`);
  }
  if (scope !== null) {
    if (!scope.trim()) errors.push("Scope is empty. Provide a value or omit the parens.");
    else if (!/^[a-z][a-z0-9-]*$/.test(scope)) warnings.push(`Scope "${scope}" should be lowercase kebab-case.`);
  }
  if (rest.length > 0 && rest[0].trim() !== "") {
    errors.push("Missing blank line between subject and body.");
  }
  rest.slice(1).forEach((line,i) => {
    if (line.length > MAX_BODY_LINE) warnings.push(`Body line ${i+2} is ${line.length} chars (max ${MAX_BODY_LINE}).`);
  });
  if (breaking && !rest.some((l) => l.startsWith("BREAKING CHANGE:") || l.startsWith("BREAKING-CHANGE:"))) {
    warnings.push("Breaking commit (!) has no BREAKING CHANGE: footer.");
  }

  const body = rest.length <= 1 ? null : rest.slice(1).join("\n").trim() || null;
  const parsed: ParsedCommit = { type:rawType, scope, breaking, description, body, footer:null };
  const score = Math.max(0, Math.min(100, 100 - errors.length*20 - warnings.length*5));
  return { valid: errors.length === 0, score, errors, warnings, parsed };
}

function fmt(r: LintResult): string {
  const out = [`${r.valid ? "[PASS]" : "[FAIL]"} Score: ${r.score}/100`];
  if (r.parsed) {
    const { type, scope, breaking, description } = r.parsed;
    out.push(`  Parsed: ${type}${scope?`(${scope})`:""}${breaking?"!":""}: ${description}`);
  }
  if (r.errors.length) { out.push("\nErrors:"); r.errors.forEach((e) => out.push(`  ERROR  ${e}`)); }
  if (r.warnings.length) { out.push("\nWarnings:"); r.warnings.forEach((w) => out.push(`  WARN   ${w}`)); }
  if (r.valid && !r.warnings.length) out.push("  All checks passed.");
  return out.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!args.length) { console.error('Usage: bun packages/validation/commit-linter.ts "feat: message"'); process.exit(1); }
  const r = lintCommit(args.join(" "));
  console.log(fmt(r));
  process.exit(r.valid ? 0 : 1);
}
