import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { safeSpawn } from "./safe-spawn";

const ROOT = resolve(import.meta.dir, "../..");

describe("safeSpawn", () => {
	test("a missing binary returns a result, never throws, never emits an unhandled error", async () => {
		const seen: Error[] = [];
		const r = safeSpawn("/nonexistent/8gent-no-such-binary", ["x"], {
			stdio: "ignore",
			onError: (e) => seen.push(e),
		});
		// spawn() itself succeeds for ENOENT; the error arrives on the next ticks.
		await new Promise((res) => setTimeout(res, 50));
		expect(r.ok === true || r.error instanceof Error).toBe(true);
		expect(seen.length).toBe(1);
		expect((seen[0] as NodeJS.ErrnoException).code).toBe("ENOENT");
	});

	test("with no onError the ENOENT is still swallowed", async () => {
		safeSpawn("/nonexistent/8gent-no-such-binary", [], { stdio: "ignore" });
		await new Promise((res) => setTimeout(res, 50));
		expect(true).toBe(true);
	});

	test("a real binary runs", async () => {
		const r = safeSpawn("true", [], { stdio: "ignore" });
		expect(r.ok).toBe(true);
		if (r.ok) {
			const code = await new Promise((res) => r.child.on("exit", res));
			expect(code).toBe(0);
		}
	});

	test("a synchronous spawn throw becomes { ok: false }", () => {
		const r = safeSpawn("true", [], { cwd: 42 as unknown as string });
		expect(r.ok).toBe(false);
	});
});

/**
 * Guard: a node child_process spawn()/execFile() with no error handling takes
 * the whole TUI down on the first ENOENT (#4721). New code uses safeSpawn or
 * attaches an "error" listener (or an execFile callback) within the call's
 * window. Existing offenders are allowlisted below, each with a reason.
 */
const ALLOW: Record<string, string> = {
	"bin/8gent.ts":
		"dev-only benchmark/demo subcommands, child inherits stdio; outside the TUI and goal path of #4721",
	"packages/core/win-path.ts":
		"spawnSafe returns the ChildProcess to its caller, who owns the listener",
	"packages/eight/clients/apple-foundation.ts":
		"macOS-only bridge, gated on the binary existing; follow-up to convert",
	"packages/eight/harness/spawn.ts":
		"false positive: a local async function named spawn, not child_process",
	"packages/eight/open-on-write.ts":
		"not on the TUI or goal path; wrapped by the caller's try; follow-up to convert",
	"packages/eyes/marlin/jsonrpc-client.ts":
		"eyes package, listener attached by the caller; follow-up to convert",
	"packages/orchestration/universal-spawner.ts":
		"orchestration package, outside #4721; follow-up to convert",
	"packages/orchestration/worktree-pool-agent.ts":
		"spawns bun, always present; follow-up to convert",
	"packages/pet/terminal-pet.ts": "macOS dock pet, optional feature; follow-up to convert",
	"packages/secrets/keys.ts":
		"opener spawn sits inside try/catch; async ENOENT still unhandled; follow-up to convert",
	"packages/voice/backends/moshi-mlx.ts": "opt-in MLX backend, needs python; follow-up to convert",
};

const CALL =
	/(^|[^A-Za-z0-9_.$])(spawn|execFile)\(|(^|[^A-Za-z0-9_$])(cp|child_process|childProcess)\.(spawn|execFile)\(/;
const WINDOW = 60;

function findUnguardedSpawns(files: string[], read: (f: string) => string): string[] {
	const bad: string[] = [];
	for (const f of files) {
		if (ALLOW[f]) continue;
		const src = read(f);
		if (!/node:child_process|["']child_process["']/.test(src)) continue;
		// Only files that take spawn/execFile from node, not Bun.spawn or a local function.
		if (
			!/\b(spawn|execFile)\b[^;\n]*node:child_process|import\(["']node:child_process|child_process["']\)/.test(
				src,
			) &&
			!/import[^;]*\b(spawn|execFile)\b[^;]*from ["'](node:)?child_process["']/.test(src) &&
			!/\b(cp|childProcess)\.(spawn|execFile)\(/.test(src)
		)
			continue;
		const lines = src.split("\n");
		lines.forEach((line, i) => {
			if (/^\s*(\/\/|\*)/.test(line) || !CALL.test(line)) return;
			if (/function\s+(spawn|execFile)\b/.test(line)) return;
			// A method declaration (spawn(task: string): Handle {), not a call.
			if (/^\s*(async\s+)?(spawn|execFile)\([^)]*:[^)]*\)\s*(:[^{=]*)?\{?\s*;?\s*$/.test(line))
				return;
			// Bun's spawn throws synchronously, no 'error' event: not this class of bug.
			if (
				/import\("bun"\)|from ["']bun["']/.test(lines.slice(Math.max(0, i - 8), i + 1).join("\n"))
			)
				return;
			const win = lines.slice(i, i + WINDOW).join("\n");
			const execFileWithCallback = /execFile\(/.test(line) && /(=>|function\s*\()/.test(win);
			if (/safeSpawn|["']error["']/.test(win) || execFileWithCallback) return;
			bad.push(`${f}:${i + 1}`);
		});
	}
	return bad;
}

describe("repo scan: no bare spawn without an error handler", () => {
	const files = execFileSync("git", ["ls-files", "apps", "packages", "bin"], {
		cwd: ROOT,
		encoding: "utf8",
	})
		.split("\n")
		.filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.|__tests__|node_modules/.test(f));

	test("no unguarded spawn( / execFile( outside the allowlist", () => {
		const bad = findUnguardedSpawns(files, (f) => readFileSync(join(ROOT, f), "utf8"));
		expect(bad).toEqual([]);
	});

	test("the scanner flags a bare spawn and passes a guarded one", () => {
		const bare = 'import { spawn } from "node:child_process";\nspawn("x", []);\n';
		const ok =
			'import { spawn } from "node:child_process";\nconst c = spawn("x", []);\nc.on("error", () => {});\n';
		expect(findUnguardedSpawns(["a.ts"], () => bare)).toEqual(["a.ts:2"]);
		expect(findUnguardedSpawns(["a.ts"], () => ok)).toEqual([]);
	});

	test("every allowlist entry still exists in the tree", () => {
		for (const f of Object.keys(ALLOW)) expect(files).toContain(f);
	});
});
