/**
 * 8gent Code - Security Scanner
 *
 * Scans files and directories for leaked secrets and vulnerability patterns.
 * Pure regex/string matching — no external scanner dependencies.
 *
 * Credit: pattern taxonomy inspired by 0din-ai/ai-scanner
 */

import * as fs from "fs";
import * as path from "path";
import { SECRET_PATTERNS, VULNERABILITY_PATTERNS } from "./secret-patterns";

// ============================================
// Types
// ============================================

export interface SecurityFinding {
  type: "secret" | "vulnerability";
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;
  message: string;
  pattern: string;
  suggestion: string;
}

export interface ScanOptions {
  /** Glob-style directory or file name segments to skip */
  ignore?: string[];
  /** Only scan these extensions (default: common source files) */
  extensions?: string[];
}

const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".8gent",
  "*.enc",
  "*.lock",
  "bun.lockb",
];

const DEFAULT_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".env", ".env.local", ".env.example",
  ".yaml", ".yml", ".json", ".toml",
  ".sh", ".bash", ".zsh",
  ".py", ".rb", ".go",
];

// ============================================
// Core scan logic
// ============================================

/**
 * Scan a string of content for secrets and vulnerability patterns.
 * Returns all findings with line numbers.
 */
export function scanContent(content: string, filename = "<buffer>"): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split("\n");

  for (const sp of SECRET_PATTERNS) {
    // Re-create the regex per scan to reset lastIndex
    const re = new RegExp(sp.pattern.source, sp.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const line = content.slice(0, match.index).split("\n").length;
      const lineText = lines[line - 1]?.trim() ?? "";
      // Skip if the line is a comment
      if (lineText.startsWith("//") || lineText.startsWith("#") || lineText.startsWith("*")) {
        continue;
      }
      findings.push({
        type: "secret",
        severity: sp.severity,
        file: filename,
        line,
        message: `Potential ${sp.name} detected`,
        pattern: sp.name,
        suggestion: sp.suggestion,
      });
    }
  }

  for (const vp of VULNERABILITY_PATTERNS) {
    const re = new RegExp(vp.pattern.source, vp.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const line = content.slice(0, match.index).split("\n").length;
      const lineText = lines[line - 1]?.trim() ?? "";
      if (lineText.startsWith("//") || lineText.startsWith("#") || lineText.startsWith("*")) {
        continue;
      }
      findings.push({
        type: "vulnerability",
        severity: vp.severity,
        file: filename,
        line,
        message: `Vulnerability: ${vp.name}`,
        pattern: vp.name,
        suggestion: vp.suggestion,
      });
    }
  }

  return findings;
}

/**
 * Scan a single file. Returns [] if the file cannot be read or is binary.
 */
export function scanFile(filePath: string): SecurityFinding[] {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return scanContent(content, filePath);
  } catch {
    return [];
  }
}

/**
 * Recursively scan a directory. Returns all findings across all files.
 */
export function scanDirectory(
  dirPath: string,
  opts: ScanOptions = {},
): SecurityFinding[] {
  const ignore = [...DEFAULT_IGNORE, ...(opts.ignore ?? [])];
  const extensions = opts.extensions ?? DEFAULT_EXTENSIONS;
  const findings: SecurityFinding[] = [];

  function shouldIgnore(name: string): boolean {
    return ignore.some((pattern) => name === pattern || name.endsWith(pattern));
  }

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (shouldIgnore(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        // .env files have no extension but should always be scanned
        const isEnvFile = entry.name.startsWith(".env");
        if (extensions.includes(ext) || isEnvFile) {
          findings.push(...scanFile(fullPath));
        }
      }
    }
  }

  walk(dirPath);
  return findings;
}

// ============================================
// Summary helpers
// ============================================

export interface ScanSummary {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  byFile: Record<string, SecurityFinding[]>;
}

export function summarizeFindings(findings: SecurityFinding[]): ScanSummary {
  const summary: ScanSummary = {
    total: findings.length,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    byFile: {},
  };

  for (const f of findings) {
    summary[f.severity]++;
    if (!summary.byFile[f.file]) summary.byFile[f.file] = [];
    summary.byFile[f.file].push(f);
  }

  return summary;
}

/**
 * Returns true if there are any critical or high severity findings.
 * Useful as a pre-commit gate.
 */
export function hasCriticalFindings(findings: SecurityFinding[]): boolean {
  return findings.some((f) => f.severity === "critical" || f.severity === "high");
}
