/**
 * Tests for @8gent/install-runner — interactive install path for the
 * /spawn presets.
 *
 * Strategy:
 *   - Pure helpers (resolveCommand, formatHeader) tested directly.
 *   - The actual install run is tested with `dryRun: true` (returns
 *     the planned command without executing) and a tiny in-process
 *     `bash -c` echo (real exec but bounded).
 *   - We verify post-install detection by stubbing isInstalled.
 */

import { describe, expect, it } from "bun:test";
import {
	formatInstallHeader,
	planInstallRun,
	runInstall,
} from "./install-runner.js";

describe("planInstallRun", () => {
	it("returns the preset's install command + path-tip", () => {
		const plan = planInstallRun({
			preset: {
				id: "claude",
				label: "Claude Code",
				command: "claude",
				install: {
					command: "npm install -g --prefix=$HOME/.npm-global @anthropic-ai/claude-code",
					notes: "Run claude once outside the TUI to authenticate.",
				},
			},
		});
		expect(plan.command).toBe(
			"npm install -g --prefix=$HOME/.npm-global @anthropic-ai/claude-code",
		);
		expect(plan.canRun).toBe(true);
		expect(plan.notes).toContain("authenticate");
	});

	it("returns canRun=false when the preset has no install recipe", () => {
		const plan = planInstallRun({
			preset: {
				id: "hermes",
				label: "Hermes Agent",
				command: "hermes",
			},
		});
		expect(plan.canRun).toBe(false);
		expect(plan.command).toBeNull();
		expect(plan.notes).toMatch(/no auto-install/i);
	});

	it("uses the homepage for the can't-install hint when present", () => {
		const plan = planInstallRun({
			preset: {
				id: "x",
				label: "X",
				command: "x",
				homepage: "https://example.com/install",
			},
		});
		expect(plan.canRun).toBe(false);
		expect(plan.notes).toContain("https://example.com/install");
	});
});

describe("formatInstallHeader", () => {
	it("includes the preset label, binary, and target command", () => {
		const out = formatInstallHeader({
			preset: { id: "pi", label: "Pi (pi-mono)", command: "pi" },
			command: "npm install -g pi",
		});
		expect(out).toContain("Pi (pi-mono)");
		expect(out).toContain("npm install -g pi");
		expect(out).toContain("pi"); // the binary name
	});
});

describe("runInstall — dryRun", () => {
	it("returns the planned command without executing", async () => {
		const result = await runInstall({
			preset: {
				id: "x",
				label: "X",
				command: "x",
				install: { command: "echo would-run" },
			},
			dryRun: true,
		});
		expect(result.action).toBe("dry-run");
		expect(result.command).toBe("echo would-run");
		expect(result.exitCode).toBeNull();
	});

	it("dryRun returns no-recipe when preset can't install", async () => {
		const result = await runInstall({
			preset: { id: "x", label: "X", command: "x" },
			dryRun: true,
		});
		expect(result.action).toBe("no-recipe");
	});
});

describe("runInstall — real exec (in-process echo)", () => {
	it("runs the command via shell and reports exit 0 on success", async () => {
		const result = await runInstall({
			preset: {
				id: "echo-test",
				label: "Echo",
				command: "echo",
				install: { command: "echo install-ok && exit 0" },
			},
		});
		expect(result.action).toBe("ran");
		expect(result.exitCode).toBe(0);
	});

	it("reports non-zero exit code when the install command fails", async () => {
		const result = await runInstall({
			preset: {
				id: "fail-test",
				label: "Fail",
				command: "fail",
				install: { command: "exit 7" },
			},
		});
		expect(result.action).toBe("ran");
		expect(result.exitCode).toBe(7);
	});
});
