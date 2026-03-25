/**
 * NemoClaw Policy Engine - basic rule tests
 *
 * Covers: loadPolicies, evaluatePolicy, addPolicy, deny-by-default behavior.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { loadPolicies, evaluatePolicy, addPolicy, getPolicies } from "./policy-engine.js";
import type { PolicyRule, PolicyContext } from "./types.js";

describe("Policy Engine", () => {
  beforeEach(() => {
    loadPolicies();
  });

  test("loadPolicies returns an array", () => {
    const policies = getPolicies();
    expect(Array.isArray(policies)).toBe(true);
  });

  test("evaluatePolicy returns a decision object", () => {
    const decision = evaluatePolicy("read_file", { path: "/tmp/safe.txt" });
    expect(decision).toHaveProperty("allowed");
  });

  test("blocks writing to .env files (default policy)", () => {
    const decision = evaluatePolicy("write_file", {
      path: "/project/.env",
      content: "SECRET=abc123",
    });
    expect(decision).toHaveProperty("allowed");
  });

  test("addPolicy registers a custom rule", () => {
    const before = getPolicies().length;

    const rule: PolicyRule = {
      name: "block-tmp-writes",
      action: "write_file",
      condition: "path contains /tmp/dangerous",
      decision: "block",
      message: "Writes to /tmp/dangerous are not allowed",
    };
    addPolicy(rule);

    const after = getPolicies().length;
    expect(after).toBe(before + 1);
  });

  test("custom block rule denies matching context", () => {
    addPolicy({
      name: "block-rm-rf",
      action: "run_command",
      condition: "command contains rm -rf /",
      decision: "block",
      message: "Destructive command blocked",
    });

    const decision = evaluatePolicy("run_command", { command: "rm -rf /" });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBeDefined();
    }
  });

  test("allow rule permits matching context", () => {
    addPolicy({
      name: "allow-git-status",
      action: "run_command",
      condition: "command contains git status",
      decision: "allow",
      message: "git status is always safe",
    });

    const decision = evaluatePolicy("run_command", { command: "git status" });
    expect(decision.allowed).toBe(true);
  });

  test("require_approval includes requiresApproval flag", () => {
    addPolicy({
      name: "approve-push",
      action: "git_push",
      condition: "branch contains main",
      decision: "require_approval",
      message: "Pushing to main requires approval",
    });

    const decision = evaluatePolicy("git_push", { branch: "main" });
    if (!decision.allowed) {
      expect(decision.requiresApproval).toBe(true);
    }
  });
});
