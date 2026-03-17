/**
 * 8gent Toolshed - The `run` Tool
 *
 * Inspired by agent-clip (ex-Manus backend lead):
 * "A single run(command=...) outperforms a catalog of typed function calls."
 *
 * Architecture:
 * - Layer 1 (Execution): Pure Unix semantics — pipes, chains, exit codes. Raw text.
 * - Layer 2 (Presentation): Binary guard, overflow truncation, metadata footer.
 *
 * Supports: | (pipe), && (and), || (or), ; (seq)
 * Progressive help: command with no args → usage. command --help → full docs.
 * Error-as-navigation: every error tells the agent what to do instead.
 *
 * This is the SINGLE tool that makes 8gent model-agnostic.
 * Smaller models that struggle with function schemas can compose CLI strings naturally.
 */

import { registerTool } from "../../registry/register";
import type { ExecutionContext } from "../../../types";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ============================================
// Built-in Commands Registry
// ============================================

interface BuiltinCommand {
  name: string;
  summary: string;
  usage: string;
  handler: (args: string[], stdin: string, ctx: ExecutionContext) => CommandResult;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  binary?: boolean;
}

const builtins = new Map<string, BuiltinCommand>();

function registerBuiltin(cmd: BuiltinCommand) {
  builtins.set(cmd.name, cmd);
}

// ── cat: Read text files ─────────────────────────────

registerBuiltin({
  name: "cat",
  summary: "Read a text file. For images use 'see'. For binary use 'cat -b'.",
  usage: "cat <path> [-n] [-b]",
  handler: (args, _stdin, ctx) => {
    if (args.length === 0) return { stdout: "", stderr: "cat: usage: cat <path> [-n] [-b]", exitCode: 1 };

    const showLineNumbers = args.includes("-n");
    const allowBinary = args.includes("-b");
    const filePath = args.find(a => !a.startsWith("-"))!;
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(ctx.workingDirectory, filePath);

    if (!fs.existsSync(absPath)) {
      return { stdout: "", stderr: `cat: ${filePath}: No such file or directory`, exitCode: 1 };
    }

    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      return { stdout: "", stderr: `cat: ${filePath}: Is a directory. Use: ls ${filePath}`, exitCode: 1 };
    }

    // Binary detection
    const buf = Buffer.alloc(512);
    const fd = fs.openSync(absPath, "r");
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);

    const hasNull = buf.subarray(0, bytesRead).includes(0);
    const ext = path.extname(absPath).toLowerCase();
    const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp"];

    if (hasNull && !allowBinary) {
      if (imageExts.includes(ext)) {
        const size = (stat.size / 1024).toFixed(1);
        return {
          stdout: "",
          stderr: `cat: binary image file (${size}KB). Use: see ${filePath}`,
          exitCode: 1,
          binary: true,
        };
      }
      const size = (stat.size / 1024).toFixed(1);
      return {
        stdout: "",
        stderr: `cat: binary file (${size}KB). Use: cat -b ${filePath}`,
        exitCode: 1,
        binary: true,
      };
    }

    let content = fs.readFileSync(absPath, "utf-8");
    if (showLineNumbers) {
      content = content.split("\n").map((line, i) => `${String(i + 1).padStart(4)} ${line}`).join("\n");
    }

    return { stdout: content, stderr: "", exitCode: 0 };
  },
});

// ── ls: List files ──────────────────────────────────

registerBuiltin({
  name: "ls",
  summary: "List files in a directory.",
  usage: "ls [path] [-a] [-l]",
  handler: (args, _stdin, ctx) => {
    const showAll = args.includes("-a");
    const showLong = args.includes("-l");
    const dirPath = args.find(a => !a.startsWith("-")) ?? ".";
    const absDir = path.isAbsolute(dirPath) ? dirPath : path.join(ctx.workingDirectory, dirPath);

    if (!fs.existsSync(absDir)) {
      return { stdout: "", stderr: `ls: ${dirPath}: No such file or directory`, exitCode: 1 };
    }

    const entries = fs.readdirSync(absDir, { withFileTypes: true })
      .filter(e => showAll || !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    if (showLong) {
      const lines = entries.map(e => {
        const stat = fs.statSync(path.join(absDir, e.name));
        const size = stat.size > 1024 * 1024 ? `${(stat.size / 1024 / 1024).toFixed(1)}M`
          : stat.size > 1024 ? `${(stat.size / 1024).toFixed(1)}K`
          : `${stat.size}B`;
        const type = e.isDirectory() ? "d" : "-";
        const date = stat.mtime.toISOString().slice(0, 10);
        return `${type} ${size.padStart(8)} ${date} ${e.name}${e.isDirectory() ? "/" : ""}`;
      });
      return { stdout: lines.join("\n"), stderr: "", exitCode: 0 };
    }

    const names = entries.map(e => e.name + (e.isDirectory() ? "/" : ""));
    return { stdout: names.join("\n"), stderr: "", exitCode: 0 };
  },
});

// ── grep: Filter lines ─────────────────────────────

registerBuiltin({
  name: "grep",
  summary: "Filter lines matching a pattern (supports -i, -v, -c, -n).",
  usage: "grep <pattern> [file] [-i] [-v] [-c] [-n]",
  handler: (args, stdin, ctx) => {
    if (args.length === 0) return { stdout: "", stderr: "grep: usage: grep <pattern> [file] [-i] [-v] [-c] [-n]", exitCode: 1 };

    const flags = args.filter(a => a.startsWith("-"));
    const nonFlags = args.filter(a => !a.startsWith("-"));
    const pattern = nonFlags[0];
    const file = nonFlags[1];
    const ignoreCase = flags.includes("-i");
    const invert = flags.includes("-v");
    const countOnly = flags.includes("-c");
    const lineNumbers = flags.includes("-n");

    let input: string;
    if (file) {
      const absPath = path.isAbsolute(file) ? file : path.join(ctx.workingDirectory, file);
      if (!fs.existsSync(absPath)) {
        return { stdout: "", stderr: `grep: ${file}: No such file or directory`, exitCode: 1 };
      }
      input = fs.readFileSync(absPath, "utf-8");
    } else {
      input = stdin;
    }

    if (!input) return { stdout: "", stderr: "", exitCode: 1 };

    const regex = new RegExp(pattern, ignoreCase ? "i" : "");
    const lines = input.split("\n");
    const matched = lines
      .map((line, i) => ({ line, num: i + 1 }))
      .filter(({ line }) => invert ? !regex.test(line) : regex.test(line));

    if (countOnly) {
      return { stdout: String(matched.length), stderr: "", exitCode: matched.length > 0 ? 0 : 1 };
    }

    const output = matched.map(({ line, num }) => lineNumbers ? `${num}:${line}` : line).join("\n");
    return { stdout: output, stderr: "", exitCode: matched.length > 0 ? 0 : 1 };
  },
});

// ── head / tail ─────────────────────────────────────

registerBuiltin({
  name: "head",
  summary: "Show first N lines (default 10).",
  usage: "head [N] [file]",
  handler: (args, stdin, ctx) => {
    const n = parseInt(args.find(a => /^\d+$/.test(a)) ?? "10");
    const file = args.find(a => !/^\d+$/.test(a) && !a.startsWith("-"));
    let input = stdin;
    if (file) {
      const p = path.isAbsolute(file) ? file : path.join(ctx.workingDirectory, file);
      if (!fs.existsSync(p)) return { stdout: "", stderr: `head: ${file}: not found`, exitCode: 1 };
      input = fs.readFileSync(p, "utf-8");
    }
    return { stdout: input.split("\n").slice(0, n).join("\n"), stderr: "", exitCode: 0 };
  },
});

registerBuiltin({
  name: "tail",
  summary: "Show last N lines (default 10).",
  usage: "tail [N] [file]",
  handler: (args, stdin, ctx) => {
    const n = parseInt(args.find(a => /^\d+$/.test(a)) ?? "10");
    const file = args.find(a => !/^\d+$/.test(a) && !a.startsWith("-"));
    let input = stdin;
    if (file) {
      const p = path.isAbsolute(file) ? file : path.join(ctx.workingDirectory, file);
      if (!fs.existsSync(p)) return { stdout: "", stderr: `tail: ${file}: not found`, exitCode: 1 };
      input = fs.readFileSync(p, "utf-8");
    }
    const lines = input.split("\n");
    return { stdout: lines.slice(-n).join("\n"), stderr: "", exitCode: 0 };
  },
});

// ── wc: Word/line/char count ────────────────────────

registerBuiltin({
  name: "wc",
  summary: "Count lines, words, characters.",
  usage: "wc [-l] [-w] [-c] [file]",
  handler: (args, stdin, ctx) => {
    const flags = args.filter(a => a.startsWith("-"));
    const file = args.find(a => !a.startsWith("-"));
    let input = stdin;
    if (file) {
      const p = path.isAbsolute(file) ? file : path.join(ctx.workingDirectory, file);
      if (!fs.existsSync(p)) return { stdout: "", stderr: `wc: ${file}: not found`, exitCode: 1 };
      input = fs.readFileSync(p, "utf-8");
    }

    const lines = input.split("\n").length - (input.endsWith("\n") ? 1 : 0);
    const words = input.split(/\s+/).filter(Boolean).length;
    const chars = input.length;

    if (flags.includes("-l")) return { stdout: String(lines), stderr: "", exitCode: 0 };
    if (flags.includes("-w")) return { stdout: String(words), stderr: "", exitCode: 0 };
    if (flags.includes("-c")) return { stdout: String(chars), stderr: "", exitCode: 0 };
    return { stdout: `${lines} ${words} ${chars}`, stderr: "", exitCode: 0 };
  },
});

// ── sort / uniq ─────────────────────────────────────

registerBuiltin({
  name: "sort",
  summary: "Sort lines. -r for reverse, -n for numeric.",
  usage: "sort [-r] [-n] [file]",
  handler: (args, stdin, ctx) => {
    const reverse = args.includes("-r");
    const numeric = args.includes("-n");
    const file = args.find(a => !a.startsWith("-"));
    let input = stdin;
    if (file) {
      const p = path.isAbsolute(file) ? file : path.join(ctx.workingDirectory, file);
      if (!fs.existsSync(p)) return { stdout: "", stderr: `sort: ${file}: not found`, exitCode: 1 };
      input = fs.readFileSync(p, "utf-8");
    }
    let lines = input.split("\n").filter(Boolean);
    if (numeric) lines.sort((a, b) => parseFloat(a) - parseFloat(b));
    else lines.sort();
    if (reverse) lines.reverse();
    return { stdout: lines.join("\n"), stderr: "", exitCode: 0 };
  },
});

registerBuiltin({
  name: "uniq",
  summary: "Remove duplicate consecutive lines. -c for counts.",
  usage: "uniq [-c] [file]",
  handler: (args, stdin, ctx) => {
    const showCount = args.includes("-c");
    const file = args.find(a => !a.startsWith("-"));
    let input = stdin;
    if (file) {
      const p = path.isAbsolute(file) ? file : path.join(ctx.workingDirectory, file);
      if (!fs.existsSync(p)) return { stdout: "", stderr: `uniq: ${file}: not found`, exitCode: 1 };
      input = fs.readFileSync(p, "utf-8");
    }
    const lines = input.split("\n");
    const result: { line: string; count: number }[] = [];
    for (const line of lines) {
      if (result.length > 0 && result[result.length - 1].line === line) {
        result[result.length - 1].count++;
      } else {
        result.push({ line, count: 1 });
      }
    }
    const output = result.map(r => showCount ? `${String(r.count).padStart(4)} ${r.line}` : r.line).join("\n");
    return { stdout: output, stderr: "", exitCode: 0 };
  },
});

// ── write: Write to file ────────────────────────────

registerBuiltin({
  name: "write",
  summary: "Write content to a file. Reads from stdin if no content given.",
  usage: "write <path> [content]",
  handler: (args, stdin, ctx) => {
    if (args.length === 0) return { stdout: "", stderr: "write: usage: write <path> [content]", exitCode: 1 };
    const filePath = args[0];
    const content = args.length > 1 ? args.slice(1).join(" ") : stdin;
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(ctx.workingDirectory, filePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
    return { stdout: `wrote ${content.length} bytes to ${filePath}`, stderr: "", exitCode: 0 };
  },
});

// ── tree: Directory tree ────────────────────────────

registerBuiltin({
  name: "tree",
  summary: "Show directory tree structure.",
  usage: "tree [path] [depth]",
  handler: (args, _stdin, ctx) => {
    const dir = args[0] ?? ".";
    const maxDepth = parseInt(args[1] ?? "3");
    const absDir = path.isAbsolute(dir) ? dir : path.join(ctx.workingDirectory, dir);
    const IGNORE = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".cache", "coverage"]);
    const lines: string[] = [];

    function walk(d: string, prefix: string, depth: number) {
      if (depth > maxDepth) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      entries = entries.filter(e => !e.name.startsWith(".") && !IGNORE.has(e.name));
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (let i = 0; i < entries.length; i++) {
        const isLast = i === entries.length - 1;
        lines.push(`${prefix}${isLast ? "└── " : "├── "}${entries[i].name}${entries[i].isDirectory() ? "/" : ""}`);
        if (entries[i].isDirectory()) walk(path.join(d, entries[i].name), prefix + (isLast ? "    " : "│   "), depth + 1);
      }
    }
    walk(absDir, "", 0);
    return { stdout: lines.join("\n"), stderr: "", exitCode: 0 };
  },
});

// ── 8gent: Meta commands ────────────────────────────

registerBuiltin({
  name: "8gent",
  summary: "8gent agent control. Subcommands: status, model, skills, outline, history.",
  usage: "8gent <subcommand> [args]",
  handler: (args, _stdin, ctx) => {
    const sub = args[0];
    if (!sub) {
      return {
        stdout: [
          "8gent — Agent Control",
          "",
          "  8gent status              — Agent status (model, history, uptime)",
          "  8gent model               — Current model",
          "  8gent model <name>        — Switch model",
          "  8gent skills              — List available skills",
          "  8gent skills <name>       — Show skill details",
          "  8gent outline <file>      — AST outline of a file",
          "  8gent history             — Conversation length",
          "  8gent help                — This help",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      };
    }

    // These return placeholder text — the actual agent integration
    // happens in the tool executor which has access to the agent instance
    switch (sub) {
      case "help":
        return { stdout: builtins.get("8gent")!.handler([], "", ctx).stdout, stderr: "", exitCode: 0 };
      case "status":
        return { stdout: "status: use callback to agent instance", stderr: "", exitCode: 0 };
      case "model":
        return { stdout: args[1] ? `model: switching to ${args[1]}` : "model: use callback", stderr: "", exitCode: 0 };
      case "skills":
        try {
          const indexPath = path.join(os.homedir(), ".8gent", "skills", ".index.json");
          if (fs.existsSync(indexPath)) {
            const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
            const lines = [`${index.skillCount} skills loaded (${Math.round(index.totalTokens / 1000)}k tokens)`, ""];
            for (const skill of index.skills.slice(0, 30)) {
              lines.push(`  ${skill.name.padEnd(30)} [${skill.category}] ${skill.description.slice(0, 50)}`);
            }
            if (index.skills.length > 30) lines.push(`  ... and ${index.skills.length - 30} more`);
            return { stdout: lines.join("\n"), stderr: "", exitCode: 0 };
          }
          return { stdout: "No skills loaded. Run: 8gent skills load", stderr: "", exitCode: 1 };
        } catch (err: any) {
          return { stdout: "", stderr: `skills: ${err.message}`, exitCode: 1 };
        }
      case "outline":
        if (!args[1]) return { stdout: "", stderr: "outline: usage: 8gent outline <file>", exitCode: 1 };
        return { stdout: `outline: ${args[1]} (delegate to AST parser)`, stderr: "", exitCode: 0 };
      case "history":
        return { stdout: "history: use callback to agent instance", stderr: "", exitCode: 0 };
      default:
        return { stdout: "", stderr: `8gent: unknown subcommand '${sub}'. Use: 8gent help`, exitCode: 1 };
    }
  },
});

// ── echo ────────────────────────────────────────────

registerBuiltin({
  name: "echo",
  summary: "Print text to stdout.",
  usage: "echo [text...]",
  handler: (args) => ({ stdout: args.join(" "), stderr: "", exitCode: 0 }),
});

// ── pwd ─────────────────────────────────────────────

registerBuiltin({
  name: "pwd",
  summary: "Print working directory.",
  usage: "pwd",
  handler: (_args, _stdin, ctx) => ({ stdout: ctx.workingDirectory, stderr: "", exitCode: 0 }),
});

// ============================================
// Chain Parser (|, &&, ||, ;)
// ============================================

type ChainOp = "|" | "&&" | "||" | ";";

interface ChainSegment {
  command: string;
  args: string[];
  operator: ChainOp | null; // operator AFTER this segment
}

function parseChain(command: string): ChainSegment[] {
  const segments: ChainSegment[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    // Handle quotes
    if ((ch === '"' || ch === "'") && !inQuote) { inQuote = ch; current += ch; continue; }
    if (ch === inQuote) { inQuote = null; current += ch; continue; }
    if (inQuote) { current += ch; continue; }

    // Detect operators
    if (ch === "|" && next !== "|") {
      pushSegment(current.trim(), "|");
      current = "";
      continue;
    }
    if (ch === "&" && next === "&") {
      pushSegment(current.trim(), "&&");
      current = "";
      i++; // skip second &
      continue;
    }
    if (ch === "|" && next === "|") {
      pushSegment(current.trim(), "||");
      current = "";
      i++; // skip second |
      continue;
    }
    if (ch === ";") {
      pushSegment(current.trim(), ";");
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim()) pushSegment(current.trim(), null);
  return segments;

  function pushSegment(raw: string, op: ChainOp | null) {
    if (!raw) return;
    const parts = parseArgs(raw);
    segments.push({ command: parts[0], args: parts.slice(1), operator: op });
  }
}

function parseArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (const ch of raw) {
    if ((ch === '"' || ch === "'") && !inQuote) { inQuote = ch; continue; }
    if (ch === inQuote) { inQuote = null; continue; }
    if (ch === " " && !inQuote) {
      if (current) args.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

// ============================================
// Layer 1: Execution (Pure Unix Semantics)
// ============================================

function executeSegment(segment: ChainSegment, stdin: string, ctx: ExecutionContext): CommandResult {
  const { command, args } = segment;

  // Check --help flag
  if (args.includes("--help") || args.includes("-h")) {
    const builtin = builtins.get(command);
    if (builtin) {
      return { stdout: `${command} — ${builtin.summary}\n\nUsage: ${builtin.usage}`, stderr: "", exitCode: 0 };
    }
  }

  // Try builtin first
  const builtin = builtins.get(command);
  if (builtin) {
    return builtin.handler(args, stdin, ctx);
  }

  // Fall through to shell
  try {
    const fullCmd = [command, ...args.map(a => a.includes(" ") ? `"${a}"` : a)].join(" ");
    const stdout = execSync(fullCmd, {
      cwd: ctx.workingDirectory,
      encoding: "utf-8",
      timeout: 30000,
      input: stdin || undefined,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message,
      exitCode: err.status ?? 1,
    };
  }
}

function executeChain(segments: ChainSegment[], ctx: ExecutionContext): CommandResult {
  let lastResult: CommandResult = { stdout: "", stderr: "", exitCode: 0 };
  let stdin = "";

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const prevOp = i > 0 ? segments[i - 1].operator : null;

    // Check chain operators
    if (prevOp === "&&" && lastResult.exitCode !== 0) continue; // skip on failure
    if (prevOp === "||" && lastResult.exitCode === 0) continue; // skip on success
    if (prevOp === "|") stdin = lastResult.stdout; // pipe stdout
    else if (prevOp !== null) stdin = ""; // reset for ; and others

    lastResult = executeSegment(segment, stdin, ctx);
  }

  return lastResult;
}

// ============================================
// Layer 2: Presentation (LLM-Friendly)
// ============================================

const OVERFLOW_LINES = 200;
const OVERFLOW_BYTES = 50 * 1024;
const OVERFLOW_DIR = path.join(os.tmpdir(), "8gent-run-output");

let overflowCounter = 0;

function presentResult(result: CommandResult, durationMs: number): string {
  let output = result.stdout;

  // Binary guard (Layer 2 - should not happen if builtins are correct, but defense in depth)
  if (result.binary) {
    output = result.stderr; // error message already formatted
  }

  // Overflow mode
  const lines = output.split("\n");
  const bytes = Buffer.byteLength(output, "utf-8");

  if (lines.length > OVERFLOW_LINES || bytes > OVERFLOW_BYTES) {
    // Save full output
    fs.mkdirSync(OVERFLOW_DIR, { recursive: true });
    overflowCounter++;
    const overflowFile = path.join(OVERFLOW_DIR, `cmd-${overflowCounter}.txt`);
    fs.writeFileSync(overflowFile, output);

    output = lines.slice(0, OVERFLOW_LINES).join("\n");
    output += `\n\n--- output truncated (${lines.length} lines, ${(bytes / 1024).toFixed(1)}KB) ---`;
    output += `\nFull output: ${overflowFile}`;
    output += `\nExplore: cat ${overflowFile} | grep <pattern>`;
    output += `\n         cat ${overflowFile} | tail 100`;
  }

  // Attach stderr if present
  if (result.stderr && result.exitCode !== 0) {
    output += (output ? "\n" : "") + `[stderr] ${result.stderr}`;
  }

  // Metadata footer
  output += `\n[exit:${result.exitCode} | ${durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`}]`;

  return output;
}

// ============================================
// Generate Dynamic Tool Description
// ============================================

function generateCommandList(): string {
  const lines = ["Available commands:"];
  for (const [name, cmd] of builtins) {
    lines.push(`  ${name.padEnd(12)} — ${cmd.summary}`);
  }
  lines.push("");
  lines.push("Also supports any system command (git, npm, bun, python3, etc.)");
  lines.push("Chain with: | (pipe) && (and) || (or) ; (seq)");
  lines.push("Discovery: <command> --help for usage details");
  return lines.join("\n");
}

// ============================================
// Register the `run` Tool
// ============================================

registerTool({
  name: "run",
  description: `Execute commands. Single unified tool for all operations. ${generateCommandList()}`,
  capabilities: ["code", "repo", "github"],
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Command to execute. Supports pipes (|), chains (&&, ||, ;). Examples: 'cat file.ts | grep TODO | wc -l', 'ls -l && echo done', '8gent status'",
      },
    },
    required: ["command"],
  },
  permissions: ["exec:shell", "read:code", "read:fs"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { command } = input as { command: string };

  if (!command?.trim()) {
    return presentResult({
      stdout: generateCommandList(),
      stderr: "",
      exitCode: 0,
    }, 0);
  }

  const start = performance.now();
  const segments = parseChain(command);
  const result = executeChain(segments, ctx);
  const durationMs = Math.round(performance.now() - start);

  return presentResult(result, durationMs);
});
