/**
 * 8gent Toolshed - Execution Tools
 *
 * Shell execution, process management, and environment tools.
 */

import { execFileSync, execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeShellCommand } from "../../../permissions/shell-sanitizer";
import type { ExecutionContext } from "../../../types";
import { registerTool } from "../../registry/register";

/** Why a model-supplied argument was refused. */
export const UNSAFE_ARG_REASON = "Argument contains a quote, $, backtick or ; and was not run";

/** A model-supplied word with no quote, $, backtick, ; or line break. Kept as a second guard behind argv. */
export function isPlainArg(value: unknown): boolean {
	return typeof value === "string" && !/["'`$;\n\r]/.test(value);
}

// ── run_command ─────────────────────────────────────

registerTool(
	{
		name: "run_command",
		description: "Execute a shell command and return stdout/stderr. Supports timeout.",
		capabilities: ["code"],
		inputSchema: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to execute" },
				timeout: {
					type: "number",
					description: "Timeout in ms (default: 30000)",
				},
			},
			required: ["command"],
		},
		permissions: ["exec:shell"],
		tiers: ["execute"],
	},
	async (input: unknown, ctx: ExecutionContext) => {
		const { command, timeout = 30000 } = input as {
			command: string;
			timeout?: number;
		};
		// Same sanitizer as the agent's run_command: one guard for every shell path (#3763).
		const validation = sanitizeShellCommand(command);
		if (!validation.safe) {
			return {
				exitCode: 1,
				stdout: "",
				stderr: `[BLOCKED] ${validation.reason}. Command: ${command}`,
			};
		}
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
	},
);

// ── run_tests ───────────────────────────────────────

registerTool(
	{
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
		tiers: ["execute"],
	},
	async (input: unknown, ctx: ExecutionContext) => {
		const { file, grep } = input as { file?: string; grep?: string };
		const cwd = ctx.workingDirectory;

		// An argument that starts a new shell word is never a file or a test name.
		const bad = [file, grep].find((v) => v !== undefined && !isPlainArg(v));
		if (bad !== undefined) {
			return { passed: false, output: `[BLOCKED] ${UNSAFE_ARG_REASON}`, command: "" };
		}

		// Detect test runner. argv, never a shell string (#3763).
		let argv: string[];
		const pkgPath = path.join(cwd, "package.json");
		if (fs.existsSync(pkgPath)) {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
			const deps = { ...pkg.dependencies, ...pkg.devDependencies };

			if (deps.vitest) {
				argv = ["npx", "vitest", "run"];
				if (file) argv.push(file);
				if (grep) argv.push("-t", grep);
			} else if (deps.jest) {
				argv = ["npx", "jest"];
				if (file) argv.push(file);
				if (grep) argv.push("-t", grep);
			} else if (fs.existsSync(path.join(cwd, "bun.lockb"))) {
				argv = ["bun", "test"];
				if (file) argv.push(file);
				if (grep) argv.push("-t", grep);
			} else {
				argv = ["npm", "test"];
			}
		} else {
			argv = ["bun", "test"];
			if (file) argv.push(file);
		}
		const cmd = argv.join(" ");

		try {
			const stdout = execFileSync(argv[0], argv.slice(1), {
				cwd,
				encoding: "utf-8",
				timeout: 120000,
			});
			return { passed: true, output: stdout.slice(0, 8000), command: cmd };
		} catch (err: any) {
			return {
				passed: false,
				output: `${err.stdout ?? ""}\n${err.stderr ?? ""}`.slice(0, 8000),
				command: cmd,
			};
		}
	},
);

// ── install_deps ────────────────────────────────────

registerTool(
	{
		name: "install_deps",
		description:
			"Install project dependencies. Auto-detects package manager (bun, pnpm, yarn, npm).",
		capabilities: ["code"],
		inputSchema: {
			type: "object",
			properties: {
				packages: {
					type: "array",
					items: { type: "string" },
					description: "Specific packages to install",
				},
				dev: { type: "boolean", description: "Install as dev dependency" },
			},
		},
		permissions: ["exec:shell", "write:fs"],
		tiers: ["execute", "write", "network"],
	},
	async (input: unknown, ctx: ExecutionContext) => {
		const { packages, dev } = input as { packages?: string[]; dev?: boolean };
		const cwd = ctx.workingDirectory;

		// Detect package manager
		let pm = "npm";
		if (fs.existsSync(path.join(cwd, "bun.lockb"))) pm = "bun";
		else if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) pm = "pnpm";
		else if (fs.existsSync(path.join(cwd, "yarn.lock"))) pm = "yarn";

		// A package name is a plain spec: no shell syntax, and never an option (#3763).
		const badPkg = (packages ?? []).find((p) => !isPlainArg(p) || p.startsWith("-"));
		if (badPkg !== undefined) {
			return { packageManager: pm, command: "", output: `[BLOCKED] ${UNSAFE_ARG_REASON}` };
		}

		const argv = [packages?.length ? "add" : "install", ...(packages ?? [])];
		if (dev) argv.push(pm === "npm" ? "--save-dev" : "-D");
		const cmd = `${pm} ${argv.join(" ")}`;

		const stdout = execFileSync(pm, argv, { cwd, encoding: "utf-8", timeout: 120000 });
		return { packageManager: pm, command: cmd, output: stdout.slice(0, 4000) };
	},
);

// ── list_processes ──────────────────────────────────

registerTool(
	{
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
		tiers: ["execute"],
	},
	async (input: unknown, ctx: ExecutionContext) => {
		const { filter, port } = input as { filter?: string; port?: number };

		if (port !== undefined && port !== null) {
			// A port is a number, whatever the model sent (#3763).
			const portNum = Number(port);
			if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
				return { processes: [], message: `Invalid port: ${String(port).slice(0, 20)}` };
			}
			try {
				const output = execFileSync("lsof", ["-i", `:${portNum}`, "-P", "-n"], {
					encoding: "utf-8",
					timeout: 5000,
				});
				return { processes: output.trim().split("\n").slice(1) };
			} catch {
				return { processes: [], message: `No process found on port ${portNum}` };
			}
		}

		try {
			const output = execFileSync("ps", ["aux"], { encoding: "utf-8", timeout: 5000 });
			// Filtered here, not by a shell pipeline: the filter is text, never a command.
			const needle = filter?.toLowerCase();
			const lines = output
				.trim()
				.split("\n")
				.filter((l) => !needle || (l.toLowerCase().includes(needle) && !/\bgrep\b/.test(l)))
				.slice(0, 20);
			return { processes: lines };
		} catch {
			return { processes: [] };
		}
	},
);

// ── read_env ────────────────────────────────────────

registerTool(
	{
		name: "read_env",
		description:
			"Read environment variables from .env file. Never returns actual values of sensitive keys.",
		capabilities: ["code"],
		inputSchema: {
			type: "object",
			properties: {
				file: { type: "string", description: "Env file path (default: .env)" },
			},
		},
		permissions: ["read:fs"],
		tiers: ["read", "admin"],
	},
	async (input: unknown, ctx: ExecutionContext) => {
		const { file = ".env" } = input as { file?: string };
		const envPath = path.isAbsolute(file) ? file : path.join(ctx.workingDirectory, file);

		if (!fs.existsSync(envPath)) {
			return { exists: false, file: envPath };
		}

		const content = fs.readFileSync(envPath, "utf-8");
		const sensitivePatterns = /key|secret|token|password|auth|api_key|private/i;

		const vars = content
			.split("\n")
			.filter((l) => l.trim() && !l.startsWith("#"))
			.map((l) => {
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
	},
);
