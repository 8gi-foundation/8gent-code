/**
 * 8gent Toolshed - Execution Tools
 *
 * Shell execution, process management, and environment tools.
 */

import { registerTool } from "../../registry/register";
import type { ExecutionContext } from "../../../types";
import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ── run_command ─────────────────────────────────────

registerTool({
  name: "run_command",
  description: "Execute a shell command and return stdout/stderr. Supports timeout.",
  capabilities: ["code"],
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "number", description: "Timeout in ms (default: 30000)" },
    },
    required: ["command"],
  },
  permissions: ["exec:shell"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { command, timeout = 30000 } = input as { command: string; timeout?: number };
  try {
    const stdout = execSync(command, {
      cwd: ctx.workingDirectory,
      encoding: "utf-8",
      timeout,
      maxBuffer: 1024 * 1024,
    });
    return { exitCode: 0, stdout: stdout.slice(0, 8000), stderr: "" };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout ?? "").slice(0, 4000),
      stderr: (err.stderr ?? "").slice(0, 4000),
    };
  }
});

// ── run_tests ───────────────────────────────────────

registerTool({
  name: "run_tests",
  description: "Run test suite. Auto-detects test runner (bun test, vitest, jest, npm test).",
  capabilities: ["code"],
  inputSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: "Specific test file to run" },
      grep: { type: "string", description: "Filter tests by name pattern" },
    },
  },
  permissions: ["exec:shell"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { file, grep } = input as { file?: string; grep?: string };
  const cwd = ctx.workingDirectory;

  // Detect test runner
  let cmd: string;
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (deps["vitest"]) {
      cmd = "npx vitest run";
      if (file) cmd += ` ${file}`;
      if (grep) cmd += ` -t "${grep}"`;
    } else if (deps["jest"]) {
      cmd = "npx jest";
      if (file) cmd += ` ${file}`;
      if (grep) cmd += ` -t "${grep}"`;
    } else if (fs.existsSync(path.join(cwd, "bun.lockb"))) {
      cmd = "bun test";
      if (file) cmd += ` ${file}`;
      if (grep) cmd += ` -t "${grep}"`;
    } else {
      cmd = "npm test";
    }
  } else {
    cmd = "bun test";
    if (file) cmd += ` ${file}`;
  }

  try {
    const stdout = execSync(cmd, { cwd, encoding: "utf-8", timeout: 120000 });
    return { passed: true, output: stdout.slice(0, 8000), command: cmd };
  } catch (err: any) {
    return {
      passed: false,
      output: ((err.stdout ?? "") + "\n" + (err.stderr ?? "")).slice(0, 8000),
      command: cmd,
    };
  }
});

// ── install_deps ────────────────────────────────────

registerTool({
  name: "install_deps",
  description: "Install project dependencies. Auto-detects package manager (bun, pnpm, yarn, npm).",
  capabilities: ["code"],
  inputSchema: {
    type: "object",
    properties: {
      packages: { type: "array", items: { type: "string" }, description: "Specific packages to install" },
      dev: { type: "boolean", description: "Install as dev dependency" },
    },
  },
  permissions: ["exec:shell", "write:fs"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { packages, dev } = input as { packages?: string[]; dev?: boolean };
  const cwd = ctx.workingDirectory;

  // Detect package manager
  let pm = "npm";
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) pm = "bun";
  else if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) pm = "pnpm";
  else if (fs.existsSync(path.join(cwd, "yarn.lock"))) pm = "yarn";

  let cmd = `${pm} ${packages?.length ? "add" : "install"}`;
  if (packages?.length) cmd += ` ${packages.join(" ")}`;
  if (dev) cmd += pm === "npm" ? " --save-dev" : " -D";

  const stdout = execSync(cmd, { cwd, encoding: "utf-8", timeout: 120000 });
  return { packageManager: pm, command: cmd, output: stdout.slice(0, 4000) };
});

// ── list_processes ──────────────────────────────────

registerTool({
  name: "list_processes",
  description: "List running processes, optionally filtered by name or port.",
  capabilities: ["code"],
  inputSchema: {
    type: "object",
    properties: {
      filter: { type: "string", description: "Filter by process name" },
      port: { type: "number", description: "Find process using this port" },
    },
  },
  permissions: ["exec:shell"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { filter, port } = input as { filter?: string; port?: number };

  if (port) {
    try {
      const output = execSync(`lsof -i :${port} -P -n`, { encoding: "utf-8", timeout: 5000 });
      return { processes: output.trim().split("\n").slice(1) };
    } catch {
      return { processes: [], message: `No process found on port ${port}` };
    }
  }

  let cmd = "ps aux";
  if (filter) cmd += ` | grep -i "${filter}" | grep -v grep`;
  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: 5000 });
    const lines = output.trim().split("\n").slice(0, 20);
    return { processes: lines };
  } catch {
    return { processes: [] };
  }
});

// ── read_env ────────────────────────────────────────

registerTool({
  name: "read_env",
  description: "Read environment variables from .env file. Never returns actual values of sensitive keys.",
  capabilities: ["code"],
  inputSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: "Env file path (default: .env)" },
    },
  },
  permissions: ["read:fs"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { file = ".env" } = input as { file?: string };
  const envPath = path.isAbsolute(file) ? file : path.join(ctx.workingDirectory, file);

  if (!fs.existsSync(envPath)) {
    return { exists: false, file: envPath };
  }

  const content = fs.readFileSync(envPath, "utf-8");
  const sensitivePatterns = /key|secret|token|password|auth|api_key|private/i;

  const vars = content
    .split("\n")
    .filter(l => l.trim() && !l.startsWith("#"))
    .map(l => {
      const [key, ...rest] = l.split("=");
      const value = rest.join("=").trim();
      const isSensitive = sensitivePatterns.test(key);
      return {
        key: key.trim(),
        value: isSensitive ? "***" : value.slice(0, 50),
        sensitive: isSensitive,
      };
    });

  return { exists: true, file: envPath, variables: vars };
});
