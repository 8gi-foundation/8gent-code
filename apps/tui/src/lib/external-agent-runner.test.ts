import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { getPreset, resolvePresetBinary, runExternalAgent } from "./external-agent-runner";

// #4769: a repo must not get its own `pi` run by /term pi, "run pi" or /spawn.
const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dir(prefix: string): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	made.push(d);
	return d;
}

function plant(folder: string, marker: string): void {
	mkdirSync(folder, { recursive: true });
	const bin = join(folder, "pi");
	writeFileSync(bin, `#!/bin/sh\necho planted > "${marker}"\necho planted\n`);
	chmodSync(bin, 0o755);
}

describe("resolvePresetBinary", () => {
	test("a pi planted in the project, reachable via '.' and ./bin, is refused by name", () => {
		const project = dir("term-proj-");
		plant(project, join(project, "ran-dot"));
		plant(join(project, "bin"), join(project, "ran-bin"));
		const env = { PATH: [".", "bin", join(project, "bin"), "/usr/bin", "/bin"].join(delimiter) };
		expect(resolvePresetBinary("pi", project, env)).toEqual({
			ok: false,
			reason: "inside",
			message: "pi found only inside this project; not running it",
		});
	});

	test("a real pi outside the folder resolves to its absolute path, even after '.'", () => {
		const project = dir("term-proj-");
		const outside = dir("term-outside-");
		plant(project, join(project, "ran"));
		plant(outside, join(outside, "ran"));
		const env = { PATH: [".", join(project, "bin"), outside].join(delimiter) };
		expect(resolvePresetBinary("pi", project, env)).toEqual({
			ok: true,
			path: join(outside, "pi"),
		});
	});

	test("no pi anywhere is reported as missing, not inside", () => {
		const project = dir("term-proj-");
		const result = resolvePresetBinary("pi", project, { PATH: "/nonexistent-4769" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("missing");
	});
});

describe("runExternalAgent with a planted pi", () => {
	test("opening the pi preset does not run the project's binary", async () => {
		const project = dir("term-proj-");
		const marker = join(project, "ran");
		plant(project, marker);
		const savedPath = process.env.PATH;
		const savedCwd = process.cwd();
		process.chdir(project);
		process.env.PATH = [".", join(project, "bin"), "/usr/bin", "/bin"].join(delimiter);
		try {
			const preset = getPreset("pi");
			expect(preset).not.toBeNull();
			const result = await runExternalAgent(preset!, "hello");
			expect(result.ok).toBe(false);
			expect(result.error).toBe("pi found only inside this project; not running it");
			expect(existsSync(marker)).toBe(false);
		} finally {
			process.chdir(savedCwd);
			process.env.PATH = savedPath;
		}
	});
});
