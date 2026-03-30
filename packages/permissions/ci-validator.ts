/**
 * CI Validation Gate for NemoClaw (#990)
 *
 * Dry-runs changed files through NemoClaw policy evaluation.
 * Callable as CLI: `8gent policy validate [files...]`
 */

import { loadPolicies, evaluatePolicy } from "./policy-engine.js";
import type { PolicyDecision, PolicyActionType } from "./types.js";

// ============================================
// Types
// ============================================

export interface PolicyViolation {
  action: PolicyActionType;
  reason: string;
  requiresApproval?: boolean;
}

export interface ValidationResult {
  file: string;
  violations: PolicyViolation[];
  passed: boolean;
}

// ============================================
// Validator
// ============================================

/** Map file extension/path to relevant policy actions for dry-run. */
function actionsForFile(file: string): PolicyActionType[] {
  const actions: PolicyActionType[] = ["write_file"];
  if (file.includes(".env")) actions.push("env_access");
  if (file.includes("secret") || file.includes("credential")) actions.push("secret_write");
  return actions;
}

/**
 * Dry-run each file through NemoClaw policy evaluation.
 * Returns per-file violation results.
 */
export function validateChangedFiles(files: string[]): ValidationResult[] {
  loadPolicies();

  return files.map((file) => {
    const violations: PolicyViolation[] = [];
    const actions = actionsForFile(file);

    for (const action of actions) {
      const context: Record<string, unknown> = { path: file };

      // For write_file, simulate a content field so condition-based rules fire
      if (action === "write_file") {
        context.content = "";
      }
      if (action === "env_access" || action === "secret_write") {
        context.key = file;
      }

      const decision: PolicyDecision = evaluatePolicy(action, context);

      if (!decision.allowed) {
        violations.push({
          action,
          reason: decision.reason,
          requiresApproval: "requiresApproval" in decision ? decision.requiresApproval : undefined,
        });
      }
    }

    return { file, violations, passed: violations.length === 0 };
  });
}

// ============================================
// CLI entry point
// ============================================

/** Run as CLI: `bun run packages/permissions/ci-validator.ts [files...]` */
export async function runCLI(files: string[]): Promise<void> {
  if (files.length === 0) {
    console.log("Usage: 8gent policy validate <file1> [file2] ...");
    process.exit(1);
  }

  const results = validateChangedFiles(files);
  let exitCode = 0;

  for (const r of results) {
    if (r.passed) {
      console.log(`  PASS  ${r.file}`);
    } else {
      exitCode = 1;
      console.log(`  FAIL  ${r.file}`);
      for (const v of r.violations) {
        console.log(`        [${v.action}] ${v.reason}`);
      }
    }
  }

  process.exit(exitCode);
}

// Direct execution support
if (import.meta.main) {
  const args = process.argv.slice(2);
  runCLI(args);
}
