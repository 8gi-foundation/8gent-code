#!/usr/bin/env bun
/**
 * Entry point for 8gent Computer (live computer-use loop).
 *
 * Usage:
 *   bun run cua:run "open TextEdit and type hello world"
 *   bun run packages/eight/scripts/cua-run.ts "your goal here"
 *
 * Each step is printed to stdout. NemoClaw policy calls that require approval
 * are routed to an inline y/N prompt — the agent never acts without consent.
 *
 * Requires cua:setup to have been run first (writes ~/.8gent/cua-configured).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runComputerUseLoop, type CuaLoopConfig, type HandsAdapter } from "../loops/computer-use";
import { ModelFailover } from "../../providers/failover";

const MARKER_PATH = join(homedir(), ".8gent", "cua-configured");
const DEFAULT_MAX_STEPS = 20;

// ── Approval prompt ───────────────────────────────────────────────────────────

async function approveInteractive(req: {
	tool: string;
	input: unknown;
	reason: string;
}): Promise<boolean> {
	const preview =
		typeof req.input === "object"
			? JSON.stringify(req.input).slice(0, 120)
			: String(req.input).slice(0, 120);

	console.log(`\n  [APPROVAL NEEDED]`);
	console.log(`  Tool:   ${req.tool}`);
	console.log(`  Reason: ${req.reason}`);
	console.log(`  Input:  ${preview}`);

	process.stdout.write("  Allow? [y/N] ");
	return new Promise((resolve) => {
		let buf = "";
		process.stdin.setRawMode?.(false);
		process.stdin.resume();
		process.stdin.setEncoding("utf8");
		const onData = (chunk: string) => {
			if (chunk === "\r" || chunk === "\n" || chunk.includes("\n")) {
				process.stdin.pause();
				process.stdin.removeListener("data", onData);
				process.stdout.write("\n");
				resolve(buf.trim().toLowerCase() === "y");
			} else {
				buf += chunk;
				process.stdout.write(chunk);
			}
		};
		process.stdin.on("data", onData);
	});
}

// ── Step printer ──────────────────────────────────────────────────────────────

function printStep(
	step: number,
	maxSteps: number,
	toolName: string,
	preview: string,
	durationMs: number,
): void {
	const pct = Math.round((step / maxSteps) * 100);
	const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
	console.log(
		`\n  [${String(step).padStart(2, "0")}/${maxSteps}] ${bar} ${pct}%`,
	);
	console.log(`  tool:    ${toolName}`);
	console.log(`  result:  ${preview.slice(0, 140)}`);
	console.log(`  elapsed: ${durationMs}ms`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	// Gate on setup
	if (!existsSync(MARKER_PATH)) {
		console.error("");
		console.error("  8gent Computer is not configured yet.");
		console.error("  Run setup first:");
		console.error("    bun run cua:setup");
		console.error("");
		process.exit(1);
	}

	// Goal from argv or interactive prompt
	let goal = process.argv.slice(2).join(" ").trim();
	if (!goal) {
		process.stdout.write("\n  Goal: ");
		goal = await new Promise<string>((resolve) => {
			let buf = "";
			process.stdin.setRawMode?.(false);
			process.stdin.resume();
			process.stdin.setEncoding("utf8");
			const onData = (chunk: string) => {
				if (chunk === "\r" || chunk === "\n" || chunk.includes("\n")) {
					process.stdin.pause();
					process.stdin.removeListener("data", onData);
					process.stdout.write("\n");
					resolve(buf.trim());
				} else {
					buf += chunk;
					process.stdout.write(chunk);
				}
			};
			process.stdin.on("data", onData);
		});
	}

	if (!goal) {
		console.error("  No goal provided. Exiting.");
		process.exit(1);
	}

	const maxSteps = Number(process.env.CUA_MAX_STEPS ?? DEFAULT_MAX_STEPS);
	const sessionId = `cua-run-${Date.now()}`;

	// Pre-warm the failover: skip cloud providers that have no API key configured
	// so the chain never attempts them and falls through to a hard error.
	const failover = new ModelFailover();
	if (!process.env.DEEPSEEK_API_KEY) {
		failover.markDown("deepseek-v4-flash", "deepseek");
	}
	if (!process.env.OPENROUTER_API_KEY) {
		failover.markDown("meta-llama/llama-3-8b-instruct:free", "openrouter");
	}
	// Skip apfel if bridge binary not present
	if (!existsSync(join(homedir(), ".8gent", "bin", "apple-foundation-bridge"))) {
		failover.markDown("apple-foundationmodel", "apfel");
	}

	console.log("");
	console.log("  ┌─────────────────────────────────────────────────────┐");
	console.log(`  │  Goal: ${goal.slice(0, 47).padEnd(47)} │`);
	console.log(`  │  Model: qwen3.6:27b (vision tier)                   │`);
	console.log(`  │  Max steps: ${String(maxSteps).padEnd(41)} │`);
	console.log("  └─────────────────────────────────────────────────────┘");
	console.log("");

	// Hands adapter: returns an instant placeholder for desktop_accessibility_tree
	// (no osascript enumeration in the perception phase - that call can hang on
	// unresponsive apps). The model sees "use desktop_windows to list windows"
	// and calls that tool on its own. All other tools pass through normally.
	const { executeHandsTool } = await import("../../daemon/tools/hands");
	const handsAdapter: HandsAdapter = async (toolName, args, ctx) => {
		if (toolName === "desktop_accessibility_tree") {
			return {
				ok: true,
				result: {
					pid: 0,
					appName: "desktop",
					windowTitle: "AX tree unavailable - call desktop_windows to list open windows",
					root: {
						role: "AXDesktop",
						title: "Native accessibility tree not available. Call desktop_windows tool to enumerate open windows, then proceed with your goal.",
						children: [],
					},
				},
			};
		}
		return executeHandsTool(toolName, args, ctx);
	};

	const config: CuaLoopConfig = {
		goal,
		maxSteps,
		sessionId,
		approve: approveInteractive,
		hostInfo: `macOS, Apple Silicon, Ghostty terminal`,
		pinnedModel: "qwen3.6:27b",
		failover,
		handsAdapter,
	};

	const t0 = Date.now();
	const result = await runComputerUseLoop(config);
	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

	// Print step trace
	console.log("\n  ── Step trace ──────────────────────────────────────────");
	for (const s of result.steps) {
		printStep(s.step, maxSteps, s.toolName, s.resultPreview, s.durationMs);
	}

	// Final verdict
	console.log("\n  ── Result ──────────────────────────────────────────────");
	console.log(`  outcome:  ${result.reason}`);
	console.log(`  steps:    ${result.steps.length}/${maxSteps}`);
	console.log(`  tokens:   ~${result.totalCost}`);
	console.log(`  elapsed:  ${elapsed}s`);
	if (result.finalMessage) {
		console.log(`\n  ${result.finalMessage}`);
	}
	console.log("");

	process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
	console.error("\n  Fatal:", err?.message ?? err);
	process.exit(1);
});
