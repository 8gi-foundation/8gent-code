/**
 * `8gent memory stats` and `8gent export` as a user runs them, through the
 * real bin/8gent.ts in a child process with a throwaway HOME and project dir.
 *
 * Both commands were broken on main while tsconfig.harness.json was ungated
 * (#4135): export called a SessionSyncManager method that does not exist, and
 * memory stats read a 1-token context window, so it always reported 0.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const BIN = join(ROOT, "bin/8gent.ts");
const scratch = mkdtempSync(join(tmpdir(), "8gent-cli-memexp-"));
const home = join(scratch, "home");
const proj = join(scratch, "proj");

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(args: string[]): { code: number; out: string; err: string } {
	const r = Bun.spawnSync(["bun", ...args], {
		cwd: ROOT,
		env: { ...process.env, HOME: home, USERPROFILE: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("8gent memory stats", () => {
	test("counts what remember stored, not what fits in a context window", () => {
		for (const fact of ["the build uses bun for every script", "tests live next to source"]) {
			const r = run([BIN, "memory", "remember", `--cwd=${proj}`, fact]);
			expect(r.code).toBe(0);
		}
		const r = run([BIN, "memory", "stats", "--json", `--cwd=${proj}`]);
		expect(r.code).toBe(0);
		const { stats } = JSON.parse(r.out) as {
			stats: { totalMemories: number; byType: Record<string, number> };
		};
		expect(stats.totalMemories).toBe(2);
		expect(stats.byType.semantic).toBe(2);
	}, 60_000);
});

describe("8gent export", () => {
	test("an unknown session is a clean not-found, not a crash", () => {
		const r = run([BIN, "export", "no-such-session"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain("Session no-such-session not found or has no messages.");
		expect(r.err).not.toContain("is not a function");
	}, 60_000);

	test("a synced checkpoint is written to an HTML export", () => {
		// Stand in for Convex: the checkpoint is what restoreFromRemote decodes.
		const driver = join(scratch, "export-driver.ts");
		writeFileSync(
			driver,
			`const { SessionSyncManager } = await import(${JSON.stringify(join(ROOT, "packages/eight/session-sync.ts"))});
SessionSyncManager.prototype.restoreFromRemote = async (id) => ({
	sessionId: id, title: "t", model: "eight-1.0-q3:14b", workingDirectory: "/x",
	messages: [{ role: "user", content: "hello export" }, { role: "assistant", content: "hi back" }],
});
process.argv = [process.argv[0], ${JSON.stringify(BIN)}, "export", "e2e-session", "--json"];
await import(${JSON.stringify(BIN)});
`,
		);
		const r = run([driver]);
		expect(r.code).toBe(0);
		const { success, path } = JSON.parse(r.out) as { success: boolean; path: string };
		expect(success).toBe(true);
		expect(path).toBe(join(home, ".8gent/exports/e2e-session.html"));
		const html = readFileSync(path, "utf-8");
		expect(html).toContain("hello export");
		expect(html).toContain("hi back");
		expect(html).toContain("eight-1.0-q3:14b");
	}, 60_000);
});
