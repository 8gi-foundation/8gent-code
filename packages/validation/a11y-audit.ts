/**
 * Accessibility Audit Tool for the 8gent TUI
 *
 * Checks TUI components for screen reader compatibility, color contrast,
 * interactive element labels, and keyboard navigation paths.
 * Outputs a score (0-100) with remediation suggestions.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// --- Types ---

export interface A11yFinding {
  file: string;
  line: number;
  rule: string;
  severity: "error" | "warning" | "info";
  message: string;
  remediation: string;
}

export interface A11yReport {
  score: number;
  totalChecks: number;
  passed: number;
  findings: A11yFinding[];
  summary: string;
}

// --- Banned color values that break on certain terminal themes ---

const BANNED_COLORS = ["gray", "grey", "white", "black"];
const BANNED_COLOR_RE = new RegExp(
  `color=["'\`](${BANNED_COLORS.join("|")})["'\`]`,
  "gi",
);

// --- Interactive Ink elements that need an accessible label ---

const INTERACTIVE_TAGS = ["<TextInput", "<SelectInput", "<Select", "<TextField"];
const LABEL_PROPS = ["placeholder", "label", "aria-label", "accessibilityLabel"];

// --- Hotkey / keyboard nav patterns ---

const HOTKEY_HOOK_RE = /useInput\s*\(/g;
const SHORTCUT_HINT_RE = /<ShortcutHint/g;

// --- Screen reader friendly patterns ---

const RAW_TEXT_RE = /<Text[\s>]/g;
const SEMANTIC_TEXT_RE = /<(?:AppText|MutedText|Heading|Label|ErrorText|SuccessText|WarningText)[\s>]/g;

// --- Core checks ---

function checkColorContrast(source: string, filePath: string): A11yFinding[] {
  const findings: A11yFinding[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = BANNED_COLOR_RE.exec(lines[i]);
    if (match) {
      findings.push({
        file: filePath,
        line: i + 1,
        rule: "color-contrast",
        severity: "error",
        message: `Banned color "${match[1]}" used - invisible on some terminal themes`,
        remediation: `Replace with a safe ANSI color (red, green, yellow, blue, cyan) or use dimColor for muted text.`,
      });
    }
    BANNED_COLOR_RE.lastIndex = 0;
  }
  return findings;
}

function checkInteractiveLabels(source: string, filePath: string): A11yFinding[] {
  const findings: A11yFinding[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const tag of INTERACTIVE_TAGS) {
      if (!lines[i].includes(tag)) continue;
      const hasLabel = LABEL_PROPS.some((p) => lines[i].includes(p));
      if (!hasLabel) {
        findings.push({
          file: filePath,
          line: i + 1,
          rule: "interactive-label",
          severity: "error",
          message: `Interactive element ${tag.replace("<", "")} has no accessible label`,
          remediation: `Add a placeholder, label, or aria-label prop so screen readers can announce this element.`,
        });
      }
    }
  }
  return findings;
}

function checkScreenReaderCompat(source: string, filePath: string): A11yFinding[] {
  const findings: A11yFinding[] = [];
  const rawCount = (source.match(RAW_TEXT_RE) || []).length;
  const semanticCount = (source.match(SEMANTIC_TEXT_RE) || []).length;

  if (rawCount > 0 && semanticCount === 0) {
    findings.push({
      file: filePath,
      line: 1,
      rule: "screen-reader",
      severity: "warning",
      message: `Uses raw <Text> (${rawCount}x) with no semantic primitives - screen readers get no role hints`,
      remediation: `Replace <Text> with AppText, Heading, MutedText, ErrorText, etc. from primitives.`,
    });
  }
  return findings;
}

function checkKeyboardNav(source: string, filePath: string): A11yFinding[] {
  const findings: A11yFinding[] = [];
  const hasUseInput = HOTKEY_HOOK_RE.test(source);
  HOTKEY_HOOK_RE.lastIndex = 0;
  const hasShortcutHint = SHORTCUT_HINT_RE.test(source);
  SHORTCUT_HINT_RE.lastIndex = 0;

  if (hasUseInput && !hasShortcutHint) {
    findings.push({
      file: filePath,
      line: 1,
      rule: "keyboard-nav",
      severity: "warning",
      message: "Has keyboard handlers (useInput) but no visible ShortcutHint for discoverability",
      remediation: "Add <ShortcutHint> components so users know which keys are available.",
    });
  }
  return findings;
}

// --- Public API ---

export async function auditFile(filePath: string): Promise<A11yFinding[]> {
  const source = await Bun.file(filePath).text();
  return [
    ...checkColorContrast(source, filePath),
    ...checkInteractiveLabels(source, filePath),
    ...checkScreenReaderCompat(source, filePath),
    ...checkKeyboardNav(source, filePath),
  ];
}

export async function auditDirectory(dir: string): Promise<A11yReport> {
  const findings: A11yFinding[] = [];
  const stack = [dir];
  let filesScanned = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await readdir(current);
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const full = join(current, entry);
      const info = await stat(full);
      if (info.isDirectory()) {
        stack.push(full);
      } else if (entry.endsWith(".tsx") || entry.endsWith(".jsx")) {
        filesScanned++;
        findings.push(...(await auditFile(full)));
      }
    }
  }

  const totalChecks = filesScanned * 4; // 4 rule categories per file
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  const deductions = errorCount * 5 + warningCount * 2;
  const score = Math.max(0, Math.min(100, 100 - deductions));
  const passed = totalChecks - findings.length;

  return {
    score,
    totalChecks,
    passed,
    findings,
    summary: formatSummary(score, filesScanned, findings),
  };
}

function formatSummary(score: number, files: number, findings: A11yFinding[]): string {
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const grade = score >= 90 ? "A" : score >= 70 ? "B" : score >= 50 ? "C" : "F";
  return [
    `A11y Score: ${score}/100 (Grade ${grade})`,
    `Scanned ${files} component files`,
    `${errors} errors, ${warnings} warnings`,
    errors > 0 ? "Fix errors first - they cause real accessibility failures." : "No critical errors found.",
  ].join("\n");
}

// --- CLI entry point ---

if (import.meta.main) {
  const target = process.argv[2] || "apps/tui/src";
  console.log(`Running accessibility audit on: ${target}\n`);
  const report = await auditDirectory(target);
  console.log(report.summary);
  if (report.findings.length > 0) {
    console.log("\n--- Findings ---\n");
    for (const f of report.findings) {
      console.log(`[${f.severity.toUpperCase()}] ${f.file}:${f.line}`);
      console.log(`  Rule: ${f.rule}`);
      console.log(`  ${f.message}`);
      console.log(`  Fix: ${f.remediation}\n`);
    }
  }
}
