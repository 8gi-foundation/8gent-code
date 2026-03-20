/**
 * Built-in verifiers for the hypothesis engine.
 *
 * Each verifier runs a standard toolchain command and returns a structured
 * result indicating whether it passed and any output/error text.
 */

import { execSync } from "child_process";

export interface VerifyResult {
  passed: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, cwd: string): VerifyResult {
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000, // 2 min hard cap
    });
    return { passed: true, output: output.slice(-2000) };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout, e.stderr, e.message]
      .filter(Boolean)
      .join("\n")
      .slice(-2000);
    return { passed: false, output };
  }
}

// ---------------------------------------------------------------------------
// Individual verifiers
// ---------------------------------------------------------------------------

/** Run `bun test` (or vitest/jest if detected). */
export async function verifyTests(cwd: string): Promise<VerifyResult> {
  return run("bun test --bail", cwd);
}

/** Run `tsc --noEmit` for type checking. */
export async function verifyTypecheck(cwd: string): Promise<VerifyResult> {
  return run("npx tsc --noEmit", cwd);
}

/** Run linter — tries biome first, then eslint. */
export async function verifyLint(cwd: string): Promise<VerifyResult> {
  // Prefer biome if a config exists
  try {
    execSync("test -f biome.json || test -f biome.jsonc", {
      cwd,
      stdio: "pipe",
    });
    return run("npx @biomejs/biome check .", cwd);
  } catch {
    /* no biome config */
  }

  return run("npx eslint . --max-warnings=0", cwd);
}

/** Run `bun run build` (or next build if detected). */
export async function verifyBuild(cwd: string): Promise<VerifyResult> {
  return run("bun run build", cwd);
}

// ---------------------------------------------------------------------------
// Composite verifier
// ---------------------------------------------------------------------------

/**
 * Run all verifiers in sequence. Returns the first failure or an all-pass
 * result. The output concatenates all verifier outputs for context.
 */
export async function verifyAll(cwd: string): Promise<VerifyResult> {
  const stages: { name: string; fn: (cwd: string) => Promise<VerifyResult> }[] =
    [
      { name: "typecheck", fn: verifyTypecheck },
      { name: "lint", fn: verifyLint },
      { name: "tests", fn: verifyTests },
      { name: "build", fn: verifyBuild },
    ];

  const outputs: string[] = [];

  for (const stage of stages) {
    const result = await stage.fn(cwd);
    outputs.push(`--- ${stage.name} ---\n${result.output}`);

    if (!result.passed) {
      return {
        passed: false,
        output: `[FAILED at ${stage.name}]\n${outputs.join("\n")}`,
      };
    }
  }

  return { passed: true, output: outputs.join("\n") };
}

// ---------------------------------------------------------------------------
// Factory: pick verifiers by name
// ---------------------------------------------------------------------------

const VERIFIER_MAP: Record<
  string,
  (cwd: string) => Promise<VerifyResult>
> = {
  tests: verifyTests,
  typecheck: verifyTypecheck,
  lint: verifyLint,
  build: verifyBuild,
  all: verifyAll,
};

/**
 * Create a composite verifier from a list of named stages.
 *
 * @example
 * const verify = createVerifier(["typecheck", "tests"], cwd);
 * const result = await verify();
 */
export function createVerifier(
  stages: string[],
  cwd: string,
): () => Promise<VerifyResult> {
  const fns = stages.map((s) => {
    const fn = VERIFIER_MAP[s];
    if (!fn) throw new Error(`Unknown verifier: ${s}`);
    return { name: s, fn };
  });

  return async () => {
    const outputs: string[] = [];
    for (const { name, fn } of fns) {
      const result = await fn(cwd);
      outputs.push(`--- ${name} ---\n${result.output}`);
      if (!result.passed) {
        return {
          passed: false,
          output: `[FAILED at ${name}]\n${outputs.join("\n")}`,
        };
      }
    }
    return { passed: true, output: outputs.join("\n") };
  };
}
