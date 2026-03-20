import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.join(import.meta.dir, "../../autoresearch/work");

// Dynamic imports from generated code
let argParser: any, commandRegistry: any, helpGenerator: any, progress: any, formatter: any;

beforeEach(async () => {
  try {
    argParser = await import(path.join(WORK_DIR, "arg-parser.ts"));
  } catch { try { argParser = await import(path.join(WORK_DIR, "arg-parser.js")); } catch {} }
  try {
    commandRegistry = await import(path.join(WORK_DIR, "command-registry.ts"));
  } catch { try { commandRegistry = await import(path.join(WORK_DIR, "command-registry.js")); } catch {} }
  try {
    helpGenerator = await import(path.join(WORK_DIR, "help-generator.ts"));
  } catch { try { helpGenerator = await import(path.join(WORK_DIR, "help-generator.js")); } catch {} }
  try {
    progress = await import(path.join(WORK_DIR, "progress.ts"));
  } catch { try { progress = await import(path.join(WORK_DIR, "progress.js")); } catch {} }
  try {
    formatter = await import(path.join(WORK_DIR, "formatter.ts"));
  } catch { try { formatter = await import(path.join(WORK_DIR, "formatter.js")); } catch {} }
});

// ── Arg Parser ──────────────────────────────────────

describe("Arg Parser", () => {
  it("handles --key=value", () => {
    const fn = argParser.parseArgs || argParser.default?.parseArgs;
    const defs = [
      { name: "name", type: "string" },
    ];
    const result = fn(["--name=hello"], defs);
    expect(result.args.name).toBe("hello");
  });

  it("handles --flag (boolean)", () => {
    const fn = argParser.parseArgs || argParser.default?.parseArgs;
    const defs = [
      { name: "verbose", type: "boolean" },
    ];
    const result = fn(["--verbose"], defs);
    expect(result.args.verbose).toBe(true);
  });

  it("handles -f alias", () => {
    const fn = argParser.parseArgs || argParser.default?.parseArgs;
    const defs = [
      { name: "force", alias: "f", type: "boolean" },
    ];
    const result = fn(["-f"], defs);
    expect(result.args.force).toBe(true);
  });

  it("handles --no-flag negation", () => {
    const fn = argParser.parseArgs || argParser.default?.parseArgs;
    const defs = [
      { name: "color", type: "boolean", default: true },
    ];
    const result = fn(["--no-color"], defs);
    expect(result.args.color).toBe(false);
  });

  it("handles array args (--include a --include b)", () => {
    const fn = argParser.parseArgs || argParser.default?.parseArgs;
    const defs = [
      { name: "include", type: "array" },
    ];
    const result = fn(["--include", "src", "--include", "lib"], defs);
    expect(Array.isArray(result.args.include)).toBe(true);
    expect(result.args.include).toContain("src");
    expect(result.args.include).toContain("lib");
    expect(result.args.include.length).toBe(2);
  });

  it("validates required args", () => {
    const fn = argParser.parseArgs || argParser.default?.parseArgs;
    const defs = [
      { name: "name", type: "string", required: true },
    ];
    const result = fn([], defs);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    // Error should mention 'name' or 'required'
    const errorStr = result.errors.join(" ").toLowerCase();
    expect(errorStr.includes("name") || errorStr.includes("required")).toBe(true);
  });

  it("validates choices", () => {
    const fn = argParser.parseArgs || argParser.default?.parseArgs;
    const defs = [
      { name: "env", type: "string", choices: ["dev", "staging", "prod"] },
    ];
    const result = fn(["--env", "invalid"], defs);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("collects positional args", () => {
    const fn = argParser.parseArgs || argParser.default?.parseArgs;
    const defs = [
      { name: "verbose", type: "boolean" },
    ];
    const result = fn(["file1.txt", "--verbose", "file2.txt"], defs);
    expect(Array.isArray(result.positionals)).toBe(true);
    expect(result.positionals).toContain("file1.txt");
    expect(result.positionals).toContain("file2.txt");
  });
});

// ── Command Registry ────────────────────────────────

describe("CommandRegistry", () => {
  it("dispatches to correct handler", async () => {
    const CR = commandRegistry.CommandRegistry || commandRegistry.default?.CommandRegistry || commandRegistry.default;
    const reg = new CR();
    let handled = "";
    reg.register({
      name: "build",
      description: "Build the project",
      args: [],
      handler: () => { handled = "build"; },
    });
    reg.register({
      name: "test",
      description: "Run tests",
      args: [],
      handler: () => { handled = "test"; },
    });
    await reg.dispatch(["test"]);
    expect(handled).toBe("test");
  });

  it("handles subcommands", async () => {
    const CR = commandRegistry.CommandRegistry || commandRegistry.default?.CommandRegistry || commandRegistry.default;
    const reg = new CR();
    let result = "";
    reg.register({
      name: "project",
      description: "Project management",
      subcommands: [
        {
          name: "create",
          description: "Create a project",
          args: [{ name: "name", type: "string" }],
          handler: (args: any) => { result = `created:${args.args?.name || args.name || "unnamed"}`; },
        },
      ],
      handler: () => {},
    });
    await reg.dispatch(["project", "create", "--name", "myapp"]);
    expect(result).toContain("created");
  });

  it("suggests similar commands for typos", async () => {
    const CR = commandRegistry.CommandRegistry || commandRegistry.default?.CommandRegistry || commandRegistry.default;
    const reg = new CR();
    reg.register({ name: "build", description: "Build", handler: () => {} });
    reg.register({ name: "test", description: "Test", handler: () => {} });
    reg.register({ name: "deploy", description: "Deploy", handler: () => {} });

    // Try to get suggestions for a typo
    let suggestion = "";
    try {
      await reg.dispatch(["buidl"]);
    } catch (e: any) {
      suggestion = e.message || "";
    }
    // Some implementations expose a suggest method
    if (!suggestion && typeof reg.suggest === "function") {
      const suggestions = reg.suggest("buidl");
      expect(suggestions).toContain("build");
    } else if (suggestion) {
      // Error message should suggest "build"
      expect(suggestion.toLowerCase()).toContain("build");
    }
  });
});

// ── Help Generator ──────────────────────────────────

describe("Help Generator", () => {
  it("generateHelp formats usage correctly", () => {
    const fn = helpGenerator.generateHelp || helpGenerator.default?.generateHelp;
    const cmd = {
      name: "create",
      description: "Create a new project",
      args: [
        { name: "name", alias: "n", type: "string", required: true, description: "Project name" },
        { name: "verbose", alias: "v", type: "boolean", description: "Enable verbose output" },
        { name: "template", type: "string", default: "default", description: "Template to use", choices: ["default", "react", "vue"] },
      ],
      handler: () => {},
    };
    const helpText = fn(cmd, "mycli");
    expect(typeof helpText).toBe("string");
    expect(helpText.length).toBeGreaterThan(0);
    // Should contain usage information
    const lower = helpText.toLowerCase();
    expect(lower.includes("usage") || lower.includes("mycli") || lower.includes("create")).toBe(true);
    // Should mention the arguments
    expect(helpText).toContain("name");
    expect(helpText).toContain("verbose");
    // Should show default values or choices
    expect(helpText.includes("default") || helpText.includes("template")).toBe(true);
  });
});

// ── Progress Bar ────────────────────────────────────

describe("ProgressBar", () => {
  it("renders with correct percentage", () => {
    const PB = progress.ProgressBar || progress.default?.ProgressBar || progress.default;
    const bar = new PB({ total: 100, width: 20 });
    const output = bar.update(50);
    expect(typeof output).toBe("string");
    expect(output).toContain("50");
  });

  it("calculates ETA", () => {
    const PB = progress.ProgressBar || progress.default?.ProgressBar || progress.default;
    const bar = new PB({ total: 100 });
    // Simulate some progress to build rate history
    bar.update(10);
    // Small delay to create time delta
    const start = Date.now();
    while (Date.now() - start < 20) {} // busy-wait 20ms
    const output = bar.update(50);
    // The output should contain some form of ETA or time info
    // Could be "ETA:", "eta:", time remaining, etc.
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });
});

// ── Spinner ─────────────────────────────────────────

describe("Spinner", () => {
  it("cycles through frames", () => {
    const S = progress.Spinner || progress.default?.Spinner;
    const spinner = new S();
    const frames = new Set<string>();
    for (let i = 0; i < 20; i++) {
      frames.add(spinner.frame());
    }
    // Should have cycled through multiple unique frames
    expect(frames.size).toBeGreaterThan(1);
  });
});

// ── Formatter: table ────────────────────────────────

describe("Formatter", () => {
  it("table aligns columns correctly", () => {
    const tableFn = formatter.table || formatter.default?.table;
    const rows = [
      ["Name", "Age", "City"],
      ["Alice", "30", "NYC"],
      ["Bob", "25", "LA"],
      ["Charlie", "35", "Chicago"],
    ];
    const output = tableFn(rows);
    expect(typeof output).toBe("string");
    // Each non-empty line should have aligned content
    const lines = output.split("\n").filter((l: string) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    // "Alice" and "Bob" lines should have consistent column alignment
    // Check that columns are padded (all lines with data should have similar structure)
    for (const line of lines) {
      if (line.includes("Alice") || line.includes("Bob") || line.includes("Charlie")) {
        // The name and age should both be present
        expect(line.length).toBeGreaterThan(10);
      }
    }
  });

  it("colorize wraps text in ANSI codes", () => {
    const colorizeFn = formatter.colorize || formatter.default?.colorize;
    const colored = colorizeFn("hello", "red");
    expect(typeof colored).toBe("string");
    // Should contain ANSI escape sequence
    expect(colored).toContain("\x1b[");
    // Should contain the original text
    expect(colored).toContain("hello");
    // Should contain reset code
    expect(colored).toContain("\x1b[0m");
  });

  it("truncate respects maxWidth", () => {
    const truncateFn = formatter.truncate || formatter.default?.truncate;
    const result = truncateFn("Hello, World! This is a long string.", 10);
    expect(result.length).toBeLessThanOrEqual(10);
    // Should contain truncation indicator (usually "...")
    expect(result.endsWith("...") || result.endsWith("\u2026")).toBe(true);
  });

  it("truncate does not modify short strings", () => {
    const truncateFn = formatter.truncate || formatter.default?.truncate;
    const result = truncateFn("Short", 20);
    expect(result).toBe("Short");
  });
});
