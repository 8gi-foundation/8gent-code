import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// #4135: a package.json script named "check" shadows Bun's builtin `bun check`
// (its native typechecker) and reads like a typecheck while it ran biome, a
// linter. The biome script is check:biome. This keeps the name free: no
// script called exactly "check", `bun check` never reaches biome, and the
// renamed script still does.
function repoRoot(from: string): string {
	let dir = from;
	while (!existsSync(join(dir, "biome.json"))) {
		const up = dirname(dir);
		if (up === dir) throw new Error(`no biome.json above ${from}`);
		dir = up;
	}
	return dir;
}
const root = repoRoot(import.meta.dir);

// Printed by `biome check --help` and nowhere else in either command's output.
const BIOME_CHECK_HELP = "Runs formatter, linter and import sorting";

function run(args: string[]): string {
	const proc = Bun.spawnSync(["bun", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
	return `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
}

describe("the check name stays free for Bun's builtin", () => {
	test('package.json has no script named exactly "check"', () => {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			scripts?: Record<string, string>;
		};
		expect(Object.keys(pkg.scripts ?? {})).not.toContain("check");
	});

	test("`bun check --help` does not run biome", () => {
		expect(run(["check", "--help"])).not.toContain(BIOME_CHECK_HELP);
	});

	test("`bun run check:biome --help` does run biome check", () => {
		expect(run(["run", "check:biome", "--help"])).toContain(BIOME_CHECK_HELP);
	});
});
