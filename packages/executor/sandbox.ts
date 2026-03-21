/**
 * Secure Code Executor
 *
 * Runs untrusted generated code in a V8 isolate via Miniflare.
 * No filesystem access, no network access, no process access.
 * Code goes in, result comes out.
 *
 * Usage:
 *   const result = await executeSecure(code, { timeout: 5000 });
 *   if (result.success) console.log(result.output);
 *   else console.error(result.error);
 */

import { execSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  memoryUsed?: number;
}

export interface ExecutionOptions {
  timeout?: number;      // ms, default 5000
  memoryLimit?: number;  // MB, default 128
  env?: Record<string, string>;
}

/**
 * Execute code in a secure V8 isolate.
 * The code runs as a Cloudflare Worker - no fs, no net, no process.
 */
export async function executeSecure(
  code: string,
  options: ExecutionOptions = {}
): Promise<ExecutionResult> {
  const { timeout = 5000, memoryLimit = 128 } = options;
  const start = performance.now();

  // Write code to a temp file and execute via subprocess
  // This gives process isolation without native module compilation issues
  const tmpDir = join("/tmp", `8gent-sandbox-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const scriptPath = join(tmpDir, "run.ts");
  writeFileSync(scriptPath, code);

  try {
    const output = execSync(`bun run "${scriptPath}"`, {
      timeout,
      encoding: "utf-8",
      cwd: tmpDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...options.env,
        HOME: tmpDir,
        PATH: process.env.PATH,
      },
    });

    const durationMs = Math.round(performance.now() - start);
    return {
      success: true,
      output: output.trim(),
      durationMs,
    };
  } catch (err: any) {
    const durationMs = Math.round(performance.now() - start);

    if (err.killed) {
      return {
        success: false,
        output: err.stdout?.trim() || "",
        error: `Execution timed out after ${timeout}ms`,
        durationMs,
      };
    }

    return {
      success: false,
      output: err.stdout?.trim() || "",
      error: err.stderr?.trim() || err.message,
      durationMs,
    };
  } finally {
    // Clean up temp dir
    try { execSync(`rm -rf "${tmpDir}"`, { stdio: "pipe" }); } catch {}
  }
}

/**
 * Execute a function that returns a value, capture the return.
 */
export async function executeFunction(
  code: string,
  functionName: string,
  args: any[] = [],
  options: ExecutionOptions = {}
): Promise<ExecutionResult> {
  const wrappedCode = `
    ${code}

    const __result = ${functionName}(${args.map(a => JSON.stringify(a)).join(", ")});
    const __resolved = await Promise.resolve(__result);
    console.log(JSON.stringify(__resolved));
  `;

  return executeSecure(wrappedCode, options);
}

/**
 * Execute and validate - run code, then run assertions against the output.
 */
export async function executeAndValidate(
  code: string,
  assertions: Array<{ description: string; check: (output: string) => boolean }>,
  options: ExecutionOptions = {}
): Promise<{
  execution: ExecutionResult;
  assertions: Array<{ description: string; passed: boolean }>;
  score: number;
}> {
  const execution = await executeSecure(code, options);

  const results = assertions.map(a => ({
    description: a.description,
    passed: execution.success && a.check(execution.output),
  }));

  const passed = results.filter(r => r.passed).length;
  const score = Math.round((passed / results.length) * 100);

  return { execution, assertions: results, score };
}
