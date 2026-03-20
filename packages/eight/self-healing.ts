/**
 * Self-healing code executor — AutoResearchClaw pattern
 *
 * Runs code in a sandbox, detects failures, classifies errors, applies
 * automatic fixes where possible, and retries up to N rounds. For errors
 * that cannot be fixed mechanically the caller-supplied `onFix` callback
 * is invoked (typically backed by an LLM).
 */

import { execSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealingResult {
  code: string;
  passed: boolean;
  rounds: number;
  errors: string[];
}

export interface SandboxResult {
  passed: boolean;
  output: string;
  exitCode: number;
}

export type ErrorType =
  | "nan_infinity"
  | "type_error"
  | "import_error"
  | "syntax_error"
  | "runtime_error"
  | "timeout"
  | "unknown";

export interface ClassifiedError {
  type: ErrorType;
  message: string;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class SelfHealingExecutor {
  private maxRounds: number;
  private timeoutMs: number;
  private sandboxDir: string;

  constructor(opts?: { maxRounds?: number; timeoutMs?: number }) {
    this.maxRounds = opts?.maxRounds ?? 10;
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
    this.sandboxDir = join(os.tmpdir(), ".8gent-sandbox");
    mkdirSync(this.sandboxDir, { recursive: true });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Execute code, verify with a test file, auto-fix on failure, repeat.
   *
   * @param code     The source code to execute / test.
   * @param testFile Absolute path to the test file that validates the code.
   * @param onFix    Async callback that receives the error output, the current
   *                 code, and the round number. Returns the fixed code string.
   *                 Typically backed by an LLM call.
   */
  async execute(
    code: string,
    testFile: string,
    onFix: (error: string, code: string, round: number) => Promise<string>,
  ): Promise<HealingResult> {
    let currentCode = code;
    const errors: string[] = [];

    for (let round = 0; round < this.maxRounds; round++) {
      const result = await this.runInSandbox(currentCode, testFile);

      if (result.passed) {
        return { code: currentCode, passed: true, rounds: round + 1, errors };
      }

      // Classify and attempt auto-fix
      const classified = this.classifyError(result.output);
      errors.push(classified.message);

      if (classified.type === "nan_infinity") {
        currentCode = this.addGuardClauses(currentCode);
      } else if (classified.type === "import_error") {
        currentCode = this.fixImports(currentCode, result.output);
      } else if (classified.type === "syntax_error") {
        // Syntax errors almost always need LLM assistance
        currentCode = await onFix(result.output, currentCode, round);
      } else if (classified.type === "type_error") {
        currentCode = await onFix(result.output, currentCode, round);
      } else if (classified.type === "timeout") {
        // Add early-return guards or reduce iteration counts
        currentCode = await onFix(
          `TIMEOUT after ${this.timeoutMs}ms. Consider reducing work or adding early exits.\n${result.output}`,
          currentCode,
          round,
        );
      } else {
        // Generic: let the LLM figure it out
        currentCode = await onFix(result.output, currentCode, round);
      }
    }

    return {
      code: currentCode,
      passed: false,
      rounds: this.maxRounds,
      errors,
    };
  }

  // -----------------------------------------------------------------------
  // Sandbox
  // -----------------------------------------------------------------------

  async runInSandbox(
    code: string,
    testFile: string,
  ): Promise<SandboxResult> {
    const codePath = join(this.sandboxDir, `module-${Date.now()}.ts`);
    writeFileSync(codePath, code, "utf-8");

    try {
      const output = execSync(
        `bun test "${testFile}" --bail`,
        {
          cwd: this.sandboxDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: this.timeoutMs,
          env: {
            ...process.env,
            SANDBOX_MODULE: codePath,
          },
        },
      );
      return { passed: true, output: output.slice(-2000), exitCode: 0 };
    } catch (err: unknown) {
      const e = err as {
        stdout?: string;
        stderr?: string;
        status?: number;
        message?: string;
      };
      const output = [e.stdout, e.stderr, e.message]
        .filter(Boolean)
        .join("\n")
        .slice(-2000);
      return { passed: false, output, exitCode: e.status ?? 1 };
    }
  }

  // -----------------------------------------------------------------------
  // Error classification
  // -----------------------------------------------------------------------

  classifyError(output: string): ClassifiedError {
    const lower = output.toLowerCase();

    if (lower.includes("nan") || lower.includes("infinity")) {
      return {
        type: "nan_infinity",
        message: "NaN or Infinity detected in output",
      };
    }

    if (
      lower.includes("typeerror") ||
      lower.includes("type error") ||
      lower.includes("is not a function")
    ) {
      return {
        type: "type_error",
        message: extractFirstLine(output, "TypeError"),
      };
    }

    if (
      lower.includes("cannot find module") ||
      lower.includes("module not found") ||
      lower.includes("importerror") ||
      lower.includes("no such file")
    ) {
      return {
        type: "import_error",
        message: extractFirstLine(output, "import"),
      };
    }

    if (
      lower.includes("syntaxerror") ||
      lower.includes("unexpected token") ||
      lower.includes("parsing error")
    ) {
      return {
        type: "syntax_error",
        message: extractFirstLine(output, "SyntaxError"),
      };
    }

    if (lower.includes("timeout") || lower.includes("timed out")) {
      return { type: "timeout", message: "Execution timed out" };
    }

    // Fallback
    return {
      type: "runtime_error",
      message: output.split("\n").find((l) => l.trim().length > 0) || "Unknown runtime error",
    };
  }

  // -----------------------------------------------------------------------
  // Auto-fix strategies
  // -----------------------------------------------------------------------

  /**
   * Wrap numeric expressions with NaN/Infinity guards.
   * Adds a helper function at the top and wraps return statements.
   */
  addGuardClauses(code: string): string {
    const guard = `
function safeNum(n: number, fallback = 0): number {
  if (Number.isNaN(n) || !Number.isFinite(n)) return fallback;
  return n;
}
`;
    // Only add once
    if (code.includes("safeNum")) return code;

    // Insert guard at the top (after imports)
    const lines = code.split("\n");
    const lastImportIdx = lines.findLastIndex((l) =>
      l.startsWith("import "),
    );
    const insertAt = lastImportIdx >= 0 ? lastImportIdx + 1 : 0;
    lines.splice(insertAt, 0, guard);

    return lines.join("\n");
  }

  /**
   * Attempt to fix common import errors:
   * - Missing file extensions (.ts -> add .js for ESM)
   * - Wrong relative paths
   */
  fixImports(code: string, error: string): string {
    // Extract the module name from "Cannot find module './foo'"
    const match = error.match(/Cannot find module ['"]([^'"]+)['"]/);
    if (!match) return code;

    const modulePath = match[1];

    // Try adding .js extension for ESM compat
    if (
      !modulePath.endsWith(".js") &&
      !modulePath.endsWith(".ts") &&
      modulePath.startsWith(".")
    ) {
      return code.replace(
        new RegExp(`from ['"]${escapeRegex(modulePath)}['"]`, "g"),
        `from "${modulePath}.js"`,
      );
    }

    // Try swapping .ts -> .js
    if (modulePath.endsWith(".ts")) {
      const fixed = modulePath.replace(/\.ts$/, ".js");
      return code.replace(
        new RegExp(`from ['"]${escapeRegex(modulePath)}['"]`, "g"),
        `from "${fixed}"`,
      );
    }

    return code;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function extractFirstLine(output: string, keyword: string): string {
  const line = output
    .split("\n")
    .find((l) => l.toLowerCase().includes(keyword.toLowerCase()));
  return line?.trim() || output.split("\n")[0] || "Unknown error";
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
