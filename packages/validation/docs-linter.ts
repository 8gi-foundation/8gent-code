/**
 * docs-linter.ts - Markdown documentation linter for 8gent
 *
 * Checks for:
 * - Broken internal links (relative file refs)
 * - Missing top-level heading (H1)
 * - Em dash usage (banned per CLAUDE.md)
 * - Malformed code blocks (unclosed fences)
 * - Heading hierarchy violations (e.g. H1 -> H3 skipping H2)
 */

import { readFileSync, existsSync } from "fs";
import { dirname, resolve } from "path";

export interface LintIssue {
  file: string;
  line: number;
  rule: string;
  message: string;
}

/** Lint a single markdown file. Returns list of issues. */
export function lintMarkdown(filePath: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const dir = dirname(filePath);

  let hasH1 = false;
  let inCodeBlock = false;
  let codeBlockStart = 0;
  let lastHeadingLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Track code fences
    if (/^```/.test(line.trimStart())) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockStart = lineNum;
      } else {
        inCodeBlock = false;
      }
      continue;
    }

    // Skip checks inside code blocks
    if (inCodeBlock) continue;

    // -- Em dash check (U+2014) --
    if (line.includes("\u2014")) {
      issues.push({
        file: filePath,
        line: lineNum,
        rule: "no-em-dash",
        message: "Em dash found - use hyphens (-) or rewrite",
      });
    }

    // -- Heading checks --
    const headingMatch = line.match(/^(#{1,6})\s+/);
    if (headingMatch) {
      const level = headingMatch[1].length;

      if (level === 1) hasH1 = true;

      // Hierarchy: should not skip levels (e.g. H1 -> H3)
      if (lastHeadingLevel > 0 && level > lastHeadingLevel + 1) {
        issues.push({
          file: filePath,
          line: lineNum,
          rule: "heading-hierarchy",
          message: `Heading jumps from H${lastHeadingLevel} to H${level} - skips H${lastHeadingLevel + 1}`,
        });
      }
      lastHeadingLevel = level;
    }

    // -- Broken internal links --
    const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(line)) !== null) {
      const target = match[2];
      // Skip external URLs, anchors, and mailto
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      // Strip anchor from path
      const cleanPath = target.split("#")[0];
      if (!cleanPath) continue;
      const resolved = resolve(dir, cleanPath);
      if (!existsSync(resolved)) {
        issues.push({
          file: filePath,
          line: lineNum,
          rule: "broken-link",
          message: `Broken link: ${target} (resolved to ${resolved})`,
        });
      }
    }
  }

  // -- Unclosed code block --
  if (inCodeBlock) {
    issues.push({
      file: filePath,
      line: codeBlockStart,
      rule: "unclosed-code-block",
      message: `Code block opened at line ${codeBlockStart} is never closed`,
    });
  }

  // -- Missing H1 --
  if (!hasH1 && lines.length > 0) {
    issues.push({
      file: filePath,
      line: 1,
      rule: "missing-h1",
      message: "Document has no H1 heading",
    });
  }

  return issues;
}

/** Lint multiple files. Returns all issues grouped. */
export function lintFiles(paths: string[]): LintIssue[] {
  return paths.flatMap((p) => lintMarkdown(p));
}

// CLI entry point
if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("Usage: bun run packages/validation/docs-linter.ts <file.md> [file2.md ...]");
    process.exit(1);
  }
  const issues = lintFiles(files);
  if (issues.length === 0) {
    console.log("No issues found.");
    process.exit(0);
  }
  for (const issue of issues) {
    console.log(`${issue.file}:${issue.line} [${issue.rule}] ${issue.message}`);
  }
  process.exit(1);
}
