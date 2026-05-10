/**
 * Smoke tests for the eyes CLI.
 *
 * These run the binary as a subprocess against the local checkout. Real
 * AX bridge invocations are NOT exercised here (no binary in CI); we
 * verify argument parsing, exit codes, and the help/missing-backend paths.
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
	// When the bridge is not built (CI default), commands that need the
	// backend exit 3 with an actionable build prompt.
	it("capture exits 3 when 8gent-ax-bridge is missing", () => {
		// Skip on hosts where the bridge is already built (would actually succeed).
		const candidates = [
			`${process.env.HOME}/.8gent/bin/8gent-ax-bridge`,
			process.env.EIGHT_AX_BRIDGE_BIN ?? "",
		].filter(Boolean);
		for (const c of candidates) {
			const probe = spawnSync(c, ["--version"], { encoding: "utf-8" });
			if (probe.status === 0) return;
		}
		const r = run(["capture"]);
		expect(r.code).toBe(3);
		const lines = r.stdout.trim().split("\n");
		const last = JSON.parse(lines[lines.length - 1] ?? "{}");
		expect(last.ok).toBe(false);
		expect(last.reason).toMatch(/bridge|build/i);
	});
});

describe("eyes CLI:--intent routing", () => {
	it("\"describe the screen\" intent routes without crashing arg parser", () => {
		// Possible outcomes:
		//   0 -> bridge installed + perception:remote granted, real describe ran
		//   1 -> backend error
		//   2 -> bridge installed but perception:remote tier denied
		//   3 -> bridge missing (CI default)
		const r = run(["--intent", "describe the screen"]);
		expect([0, 1, 2, 3]).toContain(r.code ?? -1);
	});
});
