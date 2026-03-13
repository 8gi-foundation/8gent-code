import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.dirname(process.env.FIXTURE_PATH || ".");

let cli: any, command: any, parser: any, help: any;

beforeEach(async () => {
  try {
    cli = await import(path.join(WORK_DIR, "cli.ts"));
    command = await import(path.join(WORK_DIR, "command.ts"));
    parser = await import(path.join(WORK_DIR, "parser.ts"));
    help = await import(path.join(WORK_DIR, "help.ts"));
  } catch {}
});

describe("CLI Builder", () => {
  it("creates CLI with name and version", () => {
    const C = cli.CLI || cli.default;
    const app = new C("myapp", "1.0.0");
    expect(app.version()).toBe("1.0.0");
  });

  it("registers commands", () => {
    const C = cli.CLI || cli.default;
    const app = new C("myapp");
    app.command("init", "Initialize project");
    app.command("build", "Build project");
    const helpText = app.help();
    expect(helpText).toContain("init");
    expect(helpText).toContain("build");
  });
});

describe("Command Builder", () => {
  it("fluent API returns this", () => {
    const Cmd = command.Command || command.default;
    const cmd = new Cmd("test", "Test command");
    const result = cmd
      .argument("name", "Project name")
      .option("--verbose", "Enable verbose", { type: "boolean" });
    expect(result).toBe(cmd); // fluent chaining
  });

  it("registers arguments and options", () => {
    const Cmd = command.Command || command.default;
    const cmd = new Cmd("init", "Initialize");
    cmd.argument("name", "Project name", { required: true });
    cmd.option("--template", "Template to use", { type: "string", default: "default" });
    const helpText = cmd.help();
    expect(helpText).toContain("name");
    expect(helpText).toContain("--template");
  });
});

describe("Argument Parser", () => {
  it("parses basic flags", () => {
    const parseFn = parser.parseArgs || parser.default?.parseArgs || parser.parse;
    const Cmd = command.Command || command.default;
    const cmd = new Cmd("test", "Test");
    cmd.option("--name", "Name", { type: "string" });
    cmd.option("--count", "Count", { type: "number" });
    const result = parseFn(["--name", "alice", "--count", "42"], cmd);
    expect(result.options.name).toBe("alice");
    expect(result.options.count).toBe(42);
  });

  it("parses --flag=value syntax", () => {
    const parseFn = parser.parseArgs || parser.default?.parseArgs || parser.parse;
    const Cmd = command.Command || command.default;
    const cmd = new Cmd("test", "Test");
    cmd.option("--name", "Name", { type: "string" });
    const result = parseFn(["--name=bob"], cmd);
    expect(result.options.name).toBe("bob");
  });

  it("handles boolean flags", () => {
    const parseFn = parser.parseArgs || parser.default?.parseArgs || parser.parse;
    const Cmd = command.Command || command.default;
    const cmd = new Cmd("test", "Test");
    cmd.option("--verbose", "Verbose", { type: "boolean" });
    const result = parseFn(["--verbose"], cmd);
    expect(result.options.verbose).toBe(true);
  });

  it("handles --no- negation", () => {
    const parseFn = parser.parseArgs || parser.default?.parseArgs || parser.parse;
    const Cmd = command.Command || command.default;
    const cmd = new Cmd("test", "Test");
    cmd.option("--color", "Color", { type: "boolean", default: true });
    const result = parseFn(["--no-color"], cmd);
    expect(result.options.color).toBe(false);
  });

  it("collects positional arguments", () => {
    const parseFn = parser.parseArgs || parser.default?.parseArgs || parser.parse;
    const Cmd = command.Command || command.default;
    const cmd = new Cmd("init", "Init");
    cmd.argument("name", "Project name");
    const result = parseFn(["myproject"], cmd);
    expect(result.args.name).toBe("myproject");
  });

  it("collects rest args after --", () => {
    const parseFn = parser.parseArgs || parser.default?.parseArgs || parser.parse;
    const Cmd = command.Command || command.default;
    const cmd = new Cmd("run", "Run");
    const result = parseFn(["--", "extra1", "extra2"], cmd);
    expect(result.rest).toContain("extra1");
    expect(result.rest).toContain("extra2");
  });

  it("reports errors for missing required args", () => {
    const parseFn = parser.parseArgs || parser.default?.parseArgs || parser.parse;
    const Cmd = command.Command || command.default;
    const cmd = new Cmd("init", "Init");
    cmd.argument("name", "Name", { required: true });
    const result = parseFn([], cmd);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("Help Generator", () => {
  it("generates formatted help text", () => {
    const genFn = help.generateHelp || help.default?.generateHelp;
    const C = cli.CLI || cli.default;
    const app = new C("myapp", "2.0.0");
    app.command("init", "Initialize a project");
    app.command("build", "Build the project");
    const text = genFn(app);
    expect(text).toContain("myapp");
    expect(text).toContain("init");
    expect(text).toContain("build");
    expect(text).toContain("Initialize");
  });

  it("generates command-specific help", () => {
    const genCmdFn = help.generateCommandHelp || help.default?.generateCommandHelp;
    const Cmd = command.Command || command.default;
    const cmd = new Cmd("deploy", "Deploy application");
    cmd.argument("env", "Target environment");
    cmd.option("--force", "Force deploy", { type: "boolean" });
    const text = genCmdFn(cmd);
    expect(text).toContain("deploy");
    expect(text).toContain("env");
    expect(text).toContain("--force");
  });
});
