/**
 * execution-grader.ts — SWE-Bench style execution-based grading
 *
 * Supports both single-file and multi-file benchmarks:
 * - Single-file: writes LLM output as fixture.ts, runs test with FIXTURE_PATH
 * - Multi-file: parses file markers from LLM output, writes each file to work dir,
 *   copies fixture files, runs test with WORK_DIR env var
 *
 * Grading: 0.7 * execution + 0.3 * keyword
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import type {
  BenchmarkDefinition,
  ExecutionGradeResult,
  KeywordGradeResult,
  CombinedGradeResult,
} from "../types";

const BENCHMARKS_ROOT = resolve(dirname(import.meta.dir));
const WORK_DIR = join(BENCHMARKS_ROOT, "autoresearch", "work");

// ── Single-File Code Extraction ─────────────────────────────────────

export function extractCode(raw: string): string | null {
  if (!raw || raw.trim().length === 0) return null;

  const fencedPatterns = [
    /```(?:typescript|ts)\s*\n([\s\S]*?)```/g,
    /```(?:html|css)\s*\n([\s\S]*?)```/g,
    /```\s*\n([\s\S]*?)```/g,
  ];

  for (const pattern of fencedPatterns) {
    const matches = [...raw.matchAll(pattern)];
    if (matches.length > 0) {
      const code = matches.map((m) => m[1].trim()).join("\n\n");
      if (code.length > 20) return code;
    }
  }

  const trimmed = raw.trim();
  if (
    /^(export\s+)?(class|function|const|interface|type|import)\s/m.test(trimmed)
  ) {
    return trimmed;
  }

  // HTML content without fences
  if (/^<!DOCTYPE|^<html/i.test(trimmed)) {
    return trimmed;
  }

  return null;
}

// ── Multi-File Code Extraction ──────────────────────────────────────

export interface ExtractedFile {
  path: string;
  content: string;
}

/**
 * Extract multiple files from LLM output.
 *
 * Supported markers:
 *   // === FILE: path/to/file.ts ===
 *   // --- file: path/to/file.ts ---
 *   ### path/to/file.ts
 *   ```typescript // path/to/file.ts
 *   ```ts path/to/file.ts
 */
export function extractMultiFileCode(raw: string): ExtractedFile[] {
  const files: ExtractedFile[] = [];

  // Strategy 1: Explicit file markers between code blocks
  // Pattern: "// === FILE: path ===" or "// --- file: path ---" followed by fenced code
  const markerPattern =
    /(?:\/\/\s*={3,}\s*FILE:\s*(.+?)\s*={3,}|\/\/\s*-{3,}\s*file:\s*(.+?)\s*-{3,}|###\s+(\S+\.(?:ts|js|tsx|jsx)))\s*\n```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/gi;

  for (const match of raw.matchAll(markerPattern)) {
    const path = (match[1] || match[2] || match[3]).trim();
    const content = match[4].trim();
    if (path && content.length > 10) {
      files.push({ path, content });
    }
  }

  if (files.length >= 2) return files;

  // Strategy 2: Fenced blocks with filename in the fence line
  // ```typescript // path/to/file.ts  OR  ```ts path/to/file.ts
  const fenceFilePattern =
    /```(?:typescript|ts|javascript|js)\s+(?:\/\/\s*)?(\S+\.(?:ts|js|tsx|jsx))\s*\n([\s\S]*?)```/gi;

  for (const match of raw.matchAll(fenceFilePattern)) {
    const path = match[1].trim();
    const content = match[2].trim();
    if (path && content.length > 10) {
      files.push({ path, content });
    }
  }

  if (files.length >= 2) return files;

  // Strategy 3: Inline file markers within a single large code block
  // // === FILE: path ===  within the code itself
  const singleBlock = extractCode(raw);
  if (singleBlock) {
    const inlinePattern = /\/\/\s*={3,}\s*FILE:\s*(.+?)\s*={3,}/gi;
    const splits = singleBlock.split(inlinePattern);
    // splits: [preamble, filename1, code1, filename2, code2, ...]
    if (splits.length >= 3) {
      for (let i = 1; i < splits.length; i += 2) {
        const path = splits[i].trim();
        const content = splits[i + 1]?.trim();
        if (path && content && content.length > 10) {
          files.push({ path, content });
        }
      }
    }
  }

  return files;
}

// ── Keyword Grading ─────────────────────────────────────────────────

export function gradeKeywords(
  code: string,
  benchmark: BenchmarkDefinition
): KeywordGradeResult {
  const lower = code.toLowerCase();
  const matched: string[] = [];
  const missed: string[] = [];

  for (const kw of benchmark.keywords) {
    if (lower.includes(kw.toLowerCase())) {
      matched.push(kw);
    } else {
      missed.push(kw);
    }
  }

  const ratio =
    benchmark.keywords.length > 0
      ? matched.length / benchmark.keywords.length
      : 0;

  return {
    score: Math.round(ratio * 100),
    matchedKeywords: matched,
    missedKeywords: missed,
  };
}

// ── Execution Grading (Single-File) ─────────────────────────────────

export async function gradeExecution(
  code: string,
  benchmark: BenchmarkDefinition
): Promise<ExecutionGradeResult> {
  const id = `${benchmark.id}-${Date.now()}`;
  const tmpDir = join(WORK_DIR, `tmp-${id}`);
  // Use index.html for ui-design benchmarks, fixture.ts for code benchmarks
  const isHTML = benchmark.category === "ui-design" || /^<!DOCTYPE|^<html/i.test(code.trim());
  const fixtureName = isHTML ? "index.html" : "fixture.ts";
  const fixturePath = join(tmpDir, fixtureName);
  const testFile = join(BENCHMARKS_ROOT, benchmark.testFile!);

  const startMs = performance.now();

  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(fixturePath, code, "utf-8");

    const proc = Bun.spawn(["bun", "test", testFile], {
      env: { ...process.env, FIXTURE_PATH: fixturePath, WORK_DIR: tmpDir },
      cwd: BENCHMARKS_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = benchmark.timeoutMs ?? 15000;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    clearTimeout(timeoutId);

    const durationMs = Math.round(performance.now() - startMs);
    const { passed, failed, total } = parseBunTestOutput(
      stdout + "\n" + stderr
    );

    return {
      score: total > 0 ? Math.round((passed / total) * 100) : 0,
      totalTests: total,
      passedTests: passed,
      failedTests: failed,
      stdout,
      stderr,
      timedOut,
      durationMs,
    };
  } catch (err: any) {
    return {
      score: 0,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      stdout: "",
      stderr: err.message ?? String(err),
      timedOut: false,
      durationMs: Math.round(performance.now() - startMs),
    };
  } finally {
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

// ── Execution Grading (Multi-File) ──────────────────────────────────

export async function gradeMultiFileExecution(
  files: ExtractedFile[],
  benchmark: BenchmarkDefinition
): Promise<ExecutionGradeResult> {
  const id = `${benchmark.id}-${Date.now()}`;
  const tmpDir = join(WORK_DIR, `tmp-${id}`);
  const testFile = join(BENCHMARKS_ROOT, benchmark.testFile!);

  const startMs = performance.now();

  try {
    mkdirSync(tmpDir, { recursive: true });

    // Copy fixture files into work dir
    if (benchmark.fixtures) {
      for (const fixturePath of benchmark.fixtures) {
        const src = join(BENCHMARKS_ROOT, fixturePath);
        const dest = join(tmpDir, basename(fixturePath));
        if (existsSync(src)) {
          copyFileSync(src, dest);
        }
      }
    }

    // Write each LLM-generated file
    for (const file of files) {
      const filePath = join(tmpDir, file.path);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, file.content, "utf-8");
    }

    const proc = Bun.spawn(["bun", "test", testFile], {
      env: { ...process.env, WORK_DIR: tmpDir },
      cwd: tmpDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = benchmark.timeoutMs ?? 30000;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    clearTimeout(timeoutId);

    const durationMs = Math.round(performance.now() - startMs);
    const { passed, failed, total } = parseBunTestOutput(
      stdout + "\n" + stderr
    );

    return {
      score: total > 0 ? Math.round((passed / total) * 100) : 0,
      totalTests: total,
      passedTests: passed,
      failedTests: failed,
      stdout,
      stderr,
      timedOut,
      durationMs,
    };
  } catch (err: any) {
    return {
      score: 0,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      stdout: "",
      stderr: err.message ?? String(err),
      timedOut: false,
      durationMs: Math.round(performance.now() - startMs),
    };
  } finally {
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

// ── Bun Test Output Parser ──────────────────────────────────────────

function parseBunTestOutput(output: string): {
  passed: number;
  failed: number;
  total: number;
} {
  let passed = 0;
  let failed = 0;

  const passMatch = output.match(/(\d+)\s+pass/i);
  const failMatch = output.match(/(\d+)\s+fail/i);

  if (passMatch) passed = parseInt(passMatch[1], 10);
  if (failMatch) failed = parseInt(failMatch[1], 10);

  if (passed === 0 && failed === 0) {
    const lines = output.split("\n");
    for (const line of lines) {
      if (/✓|✅|pass/i.test(line) && /\[\d+/.test(line)) passed++;
      if (/✗|✘|❌|fail/i.test(line) && /\[\d+/.test(line)) failed++;
    }
  }

  return { passed, failed, total: passed + failed };
}

// ── Combined Grading ────────────────────────────────────────────────

export async function grade(
  rawOutput: string,
  benchmark: BenchmarkDefinition
): Promise<{ code: string | null; result: CombinedGradeResult }> {
  // Keyword grading always runs on the raw output
  const keyword = gradeKeywords(rawOutput, benchmark);

  // No test harness → keyword-only
  if (!benchmark.testExecution || !benchmark.testFile) {
    return {
      code: null,
      result: {
        score: keyword.score,
        execution: null,
        keyword,
        method: "keyword-only",
      },
    };
  }

  // ── Multi-file path ──────────────────────────────────────────────
  if (benchmark.multiFile) {
    const files = extractMultiFileCode(rawOutput);
    const allCode = files.map((f) => `// ${f.path}\n${f.content}`).join("\n\n");

    if (files.length === 0) {
      // Try single-file extraction as fallback
      const single = extractCode(rawOutput);
      if (!single) {
        return {
          code: null,
          result: { score: keyword.score, execution: null, keyword, method: "keyword-only" },
        };
      }
      // If single block found for multi-file benchmark, it's probably incomplete
      // but try it anyway
      const execution = await gradeExecution(single, benchmark);
      const blended = Math.round(0.7 * execution.score + 0.3 * keyword.score);
      return {
        code: single,
        result: { score: blended, execution, keyword, method: "execution+keyword" },
      };
    }

    const execution = await gradeMultiFileExecution(files, benchmark);
    const blended = Math.round(0.7 * execution.score + 0.3 * keyword.score);
    return {
      code: allCode,
      result: { score: blended, execution, keyword, method: "execution+keyword" },
    };
  }

  // ── Single-file path ─────────────────────────────────────────────
  const code = extractCode(rawOutput);

  if (!code) {
    return {
      code: null,
      result: { score: keyword.score, execution: null, keyword, method: "keyword-only" },
    };
  }

  const execution = await gradeExecution(code, benchmark);
  const blended = Math.round(0.7 * execution.score + 0.3 * keyword.score);

  return {
    code,
    result: { score: blended, execution, keyword, method: "execution+keyword" },
  };
}
