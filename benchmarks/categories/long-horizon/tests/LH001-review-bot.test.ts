import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.join(import.meta.dir, "../../autoresearch/work");

// Dynamic imports from generated code
let diffParser: any, astAnalyzer: any, securityScanner: any, styleChecker: any, reviewGenerator: any;

beforeEach(async () => {
  try {
    diffParser = await import(path.join(WORK_DIR, "diff-parser.ts"));
  } catch { try { diffParser = await import(path.join(WORK_DIR, "diff-parser.js")); } catch {} }
  try {
    astAnalyzer = await import(path.join(WORK_DIR, "ast-analyzer.ts"));
  } catch { try { astAnalyzer = await import(path.join(WORK_DIR, "ast-analyzer.js")); } catch {} }
  try {
    securityScanner = await import(path.join(WORK_DIR, "security-scanner.ts"));
  } catch { try { securityScanner = await import(path.join(WORK_DIR, "security-scanner.js")); } catch {} }
  try {
    styleChecker = await import(path.join(WORK_DIR, "style-checker.ts"));
  } catch { try { styleChecker = await import(path.join(WORK_DIR, "style-checker.js")); } catch {} }
  try {
    reviewGenerator = await import(path.join(WORK_DIR, "review-generator.ts"));
  } catch { try { reviewGenerator = await import(path.join(WORK_DIR, "review-generator.js")); } catch {} }
});

// ── Diff Parser ─────────────────────────────────────

const UNIFIED_DIFF_ADD = `diff --git a/src/hello.ts b/src/hello.ts
new file mode 100644
--- /dev/null
+++ b/src/hello.ts
@@ -0,0 +1,5 @@
+export function hello() {
+  return "hello";
+}
+
+export const greeting = "hi";
`;

const UNIFIED_DIFF_MODIFY = `diff --git a/src/math.ts b/src/math.ts
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,5 +1,6 @@
 export function add(a: number, b: number) {
-  return a + b;
+  const result = a + b;
+  return result;
 }

 export function sub(a: number, b: number) {
`;

const UNIFIED_DIFF_DELETE = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
--- a/src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function deprecated() {
-  return "old";
-}
`;

const UNIFIED_DIFF_RENAME = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 90%
rename from src/old-name.ts
rename to src/new-name.ts
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,3 +1,3 @@
-export function oldFunc() {
+export function newFunc() {
   return true;
 }
`;

describe("Diff Parser", () => {
  it("parseDiff handles added files", () => {
    const fn = diffParser.parseDiff || diffParser.default?.parseDiff;
    const result = fn(UNIFIED_DIFF_ADD);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const file = result[0];
    expect(file.path).toContain("hello.ts");
    expect(file.status).toBe("added");
    expect(file.hunks?.length).toBeGreaterThanOrEqual(1);
    // Should have added lines
    const addedChanges = file.hunks[0].changes.filter((c: any) => c.type === "add");
    expect(addedChanges.length).toBeGreaterThan(0);
  });

  it("parseDiff handles modified files", () => {
    const fn = diffParser.parseDiff || diffParser.default?.parseDiff;
    const result = fn(UNIFIED_DIFF_MODIFY);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const file = result[0];
    expect(file.path).toContain("math.ts");
    expect(file.status).toBe("modified");
    const changes = file.hunks[0].changes;
    const adds = changes.filter((c: any) => c.type === "add");
    const deletes = changes.filter((c: any) => c.type === "delete");
    expect(adds.length).toBeGreaterThan(0);
    expect(deletes.length).toBeGreaterThan(0);
  });

  it("parseDiff handles deleted files", () => {
    const fn = diffParser.parseDiff || diffParser.default?.parseDiff;
    const result = fn(UNIFIED_DIFF_DELETE);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const file = result[0];
    expect(file.path).toContain("old.ts");
    expect(file.status).toBe("deleted");
  });

  it("parseDiff handles rename detection", () => {
    const fn = diffParser.parseDiff || diffParser.default?.parseDiff;
    const result = fn(UNIFIED_DIFF_RENAME);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const file = result[0];
    expect(file.status).toBe("renamed");
    expect(file.oldPath || file.path).toContain("old-name");
    expect(file.path).toContain("new-name");
  });
});

// ── AST Analyzer ────────────────────────────────────

describe("AST Analyzer", () => {
  it("analyzeChanges detects added/removed/modified functions", () => {
    const fn = astAnalyzer.analyzeChanges || astAnalyzer.default?.analyzeChanges;
    const before = `
function foo() { return 1; }
function bar() { return 2; }
`;
    const after = `
function foo() { return 42; }
function baz() { return 3; }
`;
    const result = fn(before, after);
    expect(result.functionsRemoved).toContain("bar");
    expect(result.functionsAdded).toContain("baz");
    // foo was modified (body changed)
    expect(result.functionsModified).toContain("foo");
  });

  it("calculateComplexity counts control flow operators", () => {
    const fn = astAnalyzer.calculateComplexity || astAnalyzer.default?.calculateComplexity;
    const simpleCode = `function simple() { return 1; }`;
    const complexCode = `
function complex(x: number) {
  if (x > 0) {
    for (let i = 0; i < x; i++) {
      if (i % 2 === 0 && x > 10) {
        while (true) { break; }
      }
    }
  } else {
    switch (x) {
      case -1: return "neg";
      default: return "zero";
    }
  }
}`;
    const s = fn(simpleCode);
    const c = fn(complexCode);
    expect(typeof s).toBe("number");
    expect(typeof c).toBe("number");
    expect(c).toBeGreaterThan(s);
    // The complex function has if, for, if, &&, while, else, switch => at least 6
    expect(c).toBeGreaterThanOrEqual(5);
  });
});

// ── Security Scanner ────────────────────────────────

describe("Security Scanner", () => {
  it("scanCode detects SQL injection patterns", () => {
    const fn = securityScanner.scanCode || securityScanner.default?.scanCode;
    const code = `
const query = \`SELECT * FROM users WHERE id = \${userId}\`;
db.execute(query);
`;
    const issues = fn(code, "db.ts");
    expect(Array.isArray(issues)).toBe(true);
    const sqlIssues = issues.filter((i: any) =>
      i.rule?.toLowerCase().includes("sql") ||
      i.message?.toLowerCase().includes("sql") ||
      i.rule?.toLowerCase().includes("injection")
    );
    expect(sqlIssues.length).toBeGreaterThan(0);
    expect(["critical", "high"]).toContain(sqlIssues[0].severity);
  });

  it("scanCode detects XSS (innerHTML)", () => {
    const fn = securityScanner.scanCode || securityScanner.default?.scanCode;
    const code = `
element.innerHTML = userInput;
document.write(data);
`;
    const issues = fn(code, "ui.ts");
    const xssIssues = issues.filter((i: any) =>
      i.rule?.toLowerCase().includes("xss") ||
      i.message?.toLowerCase().includes("xss") ||
      i.message?.toLowerCase().includes("innerhtml") ||
      i.message?.toLowerCase().includes("document.write")
    );
    expect(xssIssues.length).toBeGreaterThan(0);
  });

  it("scanCode detects hardcoded secrets", () => {
    const fn = securityScanner.scanCode || securityScanner.default?.scanCode;
    const code = `
const password = "supersecret123";
const api_key = "sk-abc123def456";
`;
    const issues = fn(code, "config.ts");
    const secretIssues = issues.filter((i: any) =>
      i.rule?.toLowerCase().includes("secret") ||
      i.rule?.toLowerCase().includes("hardcoded") ||
      i.message?.toLowerCase().includes("hardcoded") ||
      i.message?.toLowerCase().includes("secret")
    );
    expect(secretIssues.length).toBeGreaterThan(0);
  });

  it("scanCode detects eval usage", () => {
    const fn = securityScanner.scanCode || securityScanner.default?.scanCode;
    const code = `
const result = eval(userCode);
const fn = new Function("return " + expr);
`;
    const issues = fn(code, "exec.ts");
    const evalIssues = issues.filter((i: any) =>
      i.rule?.toLowerCase().includes("eval") ||
      i.message?.toLowerCase().includes("eval") ||
      i.message?.toLowerCase().includes("function(")
    );
    expect(evalIssues.length).toBeGreaterThan(0);
  });
});

// ── Style Checker ───────────────────────────────────

describe("Style Checker", () => {
  it("checkStyle detects lines too long", () => {
    const fn = styleChecker.checkStyle || styleChecker.default?.checkStyle;
    const longLine = "const x = " + "a".repeat(200) + ";";
    const code = `function short() {\n  return 1;\n}\n${longLine}\n`;
    const violations = fn(code);
    expect(Array.isArray(violations)).toBe(true);
    const longViolations = violations.filter((v: any) =>
      v.rule?.toLowerCase().includes("line") ||
      v.message?.toLowerCase().includes("line") ||
      v.message?.toLowerCase().includes("long") ||
      v.message?.toLowerCase().includes("length")
    );
    expect(longViolations.length).toBeGreaterThan(0);
  });

  it("checkStyle detects console.log", () => {
    const fn = styleChecker.checkStyle || styleChecker.default?.checkStyle;
    const code = `
function handler() {
  console.log("debug info");
  return process();
}
`;
    const violations = fn(code);
    const consoleViolations = violations.filter((v: any) =>
      v.rule?.toLowerCase().includes("console") ||
      v.message?.toLowerCase().includes("console")
    );
    expect(consoleViolations.length).toBeGreaterThan(0);
  });

  it("checkStyle respects config overrides", () => {
    const fn = styleChecker.checkStyle || styleChecker.default?.checkStyle;
    const code = `console.log("test");\n`;
    // With noConsoleLog disabled, should not flag console.log
    const withConsole = fn(code, { noConsoleLog: false });
    const consoleViolations = withConsole.filter((v: any) =>
      v.rule?.toLowerCase().includes("console") ||
      v.message?.toLowerCase().includes("console")
    );
    expect(consoleViolations.length).toBe(0);
  });
});

// ── Review Generator ────────────────────────────────

describe("Review Generator", () => {
  it("generateReview produces summary with correct counts", () => {
    const parseFn = diffParser.parseDiff || diffParser.default?.parseDiff;
    const genFn = reviewGenerator.generateReview || reviewGenerator.default?.generateReview;
    const diffs = parseFn(UNIFIED_DIFF_ADD + "\n" + UNIFIED_DIFF_MODIFY);
    const report = genFn(diffs);
    expect(report).toBeDefined();
    expect(typeof report.summary).toBe("string");
    expect(report.summary.length).toBeGreaterThan(0);
    expect(Array.isArray(report.files)).toBe(true);
    expect(report.files.length).toBeGreaterThanOrEqual(1);
    // Should have numeric counts
    expect(typeof report.blockers).toBe("number");
    expect(typeof report.warnings).toBe("number");
    expect(typeof report.suggestions).toBe("number");
  });

  it("generateReview scores files 0-100", () => {
    const parseFn = diffParser.parseDiff || diffParser.default?.parseDiff;
    const genFn = reviewGenerator.generateReview || reviewGenerator.default?.generateReview;
    const diffs = parseFn(UNIFIED_DIFF_ADD);
    const report = genFn(diffs);
    expect(typeof report.overallScore).toBe("number");
    expect(report.overallScore).toBeGreaterThanOrEqual(0);
    expect(report.overallScore).toBeLessThanOrEqual(100);
    for (const file of report.files) {
      expect(file.score).toBeGreaterThanOrEqual(0);
      expect(file.score).toBeLessThanOrEqual(100);
    }
  });

  it("generateReview handles empty diffs", () => {
    const genFn = reviewGenerator.generateReview || reviewGenerator.default?.generateReview;
    const report = genFn([]);
    expect(report).toBeDefined();
    expect(Array.isArray(report.files)).toBe(true);
    expect(report.files.length).toBe(0);
    expect(typeof report.overallScore).toBe("number");
  });
});
