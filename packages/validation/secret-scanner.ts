/**
 * 8gent Code - Pre-Commit Secret Scanner
 *
 * Scans git-staged files for accidentally committed secrets.
 * Designed to run as a pre-commit hook or standalone CLI.
 *
 * Usage:
 *   bun packages/validation/secret-scanner.ts          # scan staged files
 *   bun packages/validation/secret-scanner.ts --all     # scan entire repo
 *   bun packages/validation/secret-scanner.ts file.ts   # scan specific file
 *
 * Pre-commit hook (add to .git/hooks/pre-commit):
 *   #!/bin/sh
 *   bun packages/validation/secret-scanner.ts || exit 1
 */

import { execSync } from "child_process";
import {
  scanContent,
  scanFile,
  scanDirectory,
  hasCriticalFindings,
  summarizeFindings,
  type SecurityFinding,
} from "./security-scanner";

// ============================================
// Git integration
// ============================================

/** Get list of staged files from git index */
function getStagedFiles(): string[] {
  try {
    const output = execSync("git diff --cached --name-only --diff-filter=ACMR", {
      encoding: "utf-8",
    });
    return output
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Read file content from the git staging area (not working tree) */
function readStagedContent(filePath: string): string | null {
  try {
    return execSync(`git show ":${filePath}"`, { encoding: "utf-8" });
  } catch {
    return null;
  }
}

// ============================================
// Formatters
// ============================================

const SEVERITY_ICON: Record<string, string> = {
  critical: "!!",
  high: "! ",
  medium: "~ ",
  low: "  ",
};

function formatFinding(f: SecurityFinding): string {
  const icon = SEVERITY_ICON[f.severity] ?? "  ";
  return `  [${icon}] ${f.file}:${f.line} - ${f.message}\n       -> ${f.suggestion}`;
}

function printReport(findings: SecurityFinding[]): void {
  if (findings.length === 0) {
    console.log("[secret-scanner] No secrets detected. Clean.");
    return;
  }

  const summary = summarizeFindings(findings);
  console.log(`\n[secret-scanner] Found ${summary.total} issue(s):\n`);
  console.log(`  Critical: ${summary.critical}  High: ${summary.high}  Medium: ${summary.medium}\n`);

  for (const f of findings) {
    console.log(formatFinding(f));
  }
  console.log();
}

// ============================================
// Scan modes
// ============================================

/** Scan only git-staged files (default for pre-commit) */
function scanStaged(): SecurityFinding[] {
  const staged = getStagedFiles();
  if (staged.length === 0) return [];

  const findings: SecurityFinding[] = [];
  for (const file of staged) {
    const content = readStagedContent(file);
    if (content) {
      findings.push(...scanContent(content, file));
    }
  }
  return findings;
}

/** Scan the entire repository */
function scanAll(): SecurityFinding[] {
  return scanDirectory(process.cwd());
}

// ============================================
// CLI entry point
// ============================================

function main(): void {
  const args = process.argv.slice(2);
  let findings: SecurityFinding[];

  if (args.includes("--all")) {
    console.log("[secret-scanner] Scanning entire repository...");
    findings = scanAll();
  } else if (args.length > 0 && !args[0].startsWith("-")) {
    // Scan specific file(s)
    findings = args.flatMap((f) => scanFile(f));
  } else {
    // Default: scan staged files (pre-commit mode)
    findings = scanStaged();
  }

  printReport(findings);

  if (hasCriticalFindings(findings)) {
    console.error("[secret-scanner] Blocked: critical or high severity secrets found.");
    console.error("[secret-scanner] Fix the issues above, then re-stage and commit.");
    process.exit(1);
  }
}

// Export for programmatic use
export { scanStaged, scanAll, printReport };

// Run when executed directly
main();
