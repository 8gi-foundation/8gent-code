/**
 * Smoke tests for TUI components
 * Verifies all new TV Mode components render without crashing
 */
import { describe, test, expect } from "bun:test";

// Test narrator translation functions (pure, no React)
import {
  narrateToolStart,
  narrateToolEnd,
  narratePlan,
  narrateStep,
} from "../lib/narrator";

describe("Narrator translations", () => {
  test("narrateToolStart maps tool names to human language", () => {
    expect(narrateToolStart("run_command", { command: "bun test" })).toContain("test");
    expect(narrateToolStart("read_file", { path: "/src/app.tsx" })).toContain("app.tsx");
    expect(narrateToolStart("write_file", { path: "/src/index.ts" })).toContain("index.ts");
    expect(narrateToolStart("list_files", {})).toContain("Exploring");
    expect(narrateToolStart("web_search", { query: "react hooks" })).toContain("react hooks");
    expect(narrateToolStart("unknown_tool", {})).toContain("unknown_tool");
  });

  test("narrateToolEnd reports success/failure", () => {
    const success = narrateToolEnd("run_command", true, 2400);
    expect(success).toContain("2.4s");
    expect(success).not.toContain("Failed");

    const failure = narrateToolEnd("run_command", false, 500);
    expect(failure).toContain("Failed");
  });

  test("narratePlan extracts numbered steps", () => {
    const result = narratePlan("PLAN: 1) scaffold 2) add routes 3) test 4) commit");
    expect(result).toContain("scaffold");
    expect(result).toContain("→");
    expect(result).toContain("test");
  });

  test("narratePlan handles no steps", () => {
    const result = narratePlan("I'll just think about this");
    expect(result).toContain("plan");
  });

  test("narrateStep strips code blocks", () => {
    const result = narrateStep("Here's the fix:\n```ts\nconst x = 1;\n```\nThis should work now.");
    expect(result).not.toContain("```");
    expect(result.length).toBeLessThanOrEqual(120);
  });

  test("narrateStep returns Thinking for empty text", () => {
    expect(narrateStep("")).toBe("Thinking...");
    expect(narrateStep("   ")).toBe("Thinking...");
  });
});

// Test component imports don't crash
describe("Component imports", () => {
  test("FixedFrame imports", async () => {
    const mod = await import("../components/fixed-frame/index");
    expect(mod.FixedFrame).toBeDefined();
  });

  test("TaskCard imports", async () => {
    const mod = await import("../components/task-card/index");
    expect(mod.TaskCard).toBeDefined();
    expect(mod.TaskCardList).toBeDefined();
  });

  test("Narrator imports", async () => {
    const mod = await import("../components/narrator/index");
    expect(mod.Narrator).toBeDefined();
  });

  test("NarratorView imports", async () => {
    const mod = await import("../screens/index");
    expect(mod.NarratorView).toBeDefined();
  });
});

// Note: React component rendering tests need a proper Ink test renderer
// These are covered by the launch smoke test (bun tui starts without crash)

// Test version consistency
describe("Version consistency", () => {
  test("package.json and bin/8gent.ts have same version", async () => {
    const pkg = await import("../../../../package.json");
    const binContent = await Bun.file("bin/8gent.ts").text();
    const versionMatch = binContent.match(/const VERSION = "([^"]+)"/);
    expect(versionMatch).not.toBeNull();
    expect(versionMatch![1]).toBe(pkg.default.version);
  });
});
