/**
 * Smoke tests for the eyes CLI.
 *
 * These run the binary as a subprocess against the local checkout. Real
 * Peekaboo invocations are NOT exercised here (no binary in CI); we verify
 * argument parsing, exit codes, and the help/missing-backend paths.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(import.meta.dir, "index.ts");

function run(args: string[]): { code: number | null; stdout: string; stderr: string } {
	const r = spawnSync("bun", ["run", CLI, ...args], {
		encoding: "utf-8",
		env: { ...process.env, EIGHT_SESSION_ID: "test_session" },
	});
	return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("eyes CLI:usage", () => {
	it("prints help with no args (exit 0, JSON)", () => {
		const r = run([]);
		expect(r.code).toBe(0);
		expect(r.stdout.trim()).toBeTruthy();
		const lines = r.stdout.trim().split("\n");
		const last = JSON.parse(lines[lines.length - 1] ?? "{}");
		expect(last.ok).toBe(true);
		expect(Array.isArray(last.subcommands)).toBe(true);
		expect(last.subcommands).toContain("capture");
	});

	it("prints help with --help (exit 0)", () => {
		const r = run(["--help"]);
		expect(r.code).toBe(0);
	});

	it("rejects unknown subcommand with exit 64", () => {
		const r = run(["nonsense"]);
		expect(r.code).toBe(64);
		const lines = r.stdout.trim().split("\n");
		const last = JSON.parse(lines[lines.length - 1] ?? "{}");
		expect(last.ok).toBe(false);
		expect(last.reason).toContain("unknown subcommand");
	});
});

describe("eyes CLI:flag parsing", () => {
	it("locate without --kind exits 64", () => {
		const r = run(["locate"]);
		expect(r.code).toBe(64);
	});

	it("locate --kind=label without --text exits 64", () => {
		const r = run(["locate", "--kind", "label"]);
		expect(r.code).toBe(64);
		const lines = r.stdout.trim().split("\n");
		const last = JSON.parse(lines[lines.length - 1] ?? "{}");
		expect(last.reason).toContain("requires --text");
	});

	it("wait-for with bad predicate exits 64", () => {
		const r = run(["wait-for", "--predicate", "bogus"]);
		expect(r.code).toBe(64);
	});

	it("diff without two positional args exits 64", () => {
		const r = run(["diff", "/tmp/only-one.png"]);
		expect(r.code).toBe(64);
	});
});

describe("eyes CLI:backend unavailable path", () => {
	// When peekaboo is not installed (CI default), commands that need the
	// backend exit 3 with an actionable install prompt.
	it("capture exits 3 when peekaboo is missing", () => {
		// Skip on hosts where peekaboo is installed (would actually succeed).
		const probe = spawnSync("/usr/bin/which", ["peekaboo"], { encoding: "utf-8" });
		if (probe.status === 0) return;
		const r = run(["capture"]);
		expect(r.code).toBe(3);
		const lines = r.stdout.trim().split("\n");
		const last = JSON.parse(lines[lines.length - 1] ?? "{}");
		expect(last.ok).toBe(false);
		expect(last.reason).toContain("peekaboo");
	});
});

describe("eyes CLI:--intent routing", () => {
	it("\"describe the screen\" intent routes without crashing arg parser", () => {
		// Will exit 3 (no backend) but the routing must succeed first.
		const r = run(["--intent", "describe the screen"]);
		// Exit code 3 (backend unavailable) when peekaboo missing; 0 if installed.
		expect([0, 1, 3]).toContain(r.code ?? -1);
	});
});
