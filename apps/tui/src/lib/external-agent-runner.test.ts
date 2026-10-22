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
import {
	getPreset,
	presetEnv,
	presetPath,
	resolvePresetBinary,
	runExternalAgent,
} from "./external-agent-runner";

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

describe("presetPath / presetEnv", () => {
	test("drops '.', relative and in-project entries; keeps absolute outside ones", () => {
		const project = dir("term-proj-");
		const outside = dir("term-outside-");
		const home = dir("term-home-");
		const path = [".", "bin", join(project, "node_modules", ".bin"), outside, "/usr/bin"].join(
			delimiter,
		);
		expect(presetPath(path, project, home)).toBe([outside, "/usr/bin"].join(delimiter));
		const env = presetEnv(project, { PATH: path, KEEP: "1", GONE: undefined }, home);
		expect(env.PATH).toBe([outside, "/usr/bin"].join(delimiter));
		expect(env.KEEP).toBe("1");
		expect("GONE" in env).toBe(false);
	});

	test("launched from home, a real claude under ~/.npm-global/bin is not refused", () => {
		const home = dir("term-home-");
		plant(join(home, ".npm-global", "bin"), join(home, "ran"));
		const env = { PATH: [".", join(home, ".npm-global", "bin"), "/usr/bin"].join(delimiter) };
		expect(presetPath(env.PATH, home, home)).toBe(
			[join(home, ".npm-global", "bin"), "/usr/bin"].join(delimiter),
		);
		expect(resolvePresetBinary("pi", home, env, home)).toEqual({
			ok: true,
			path: join(home, ".npm-global", "bin", "pi"),
		});
	});

	test("launched from home, a pi planted only on '.' is still refused", () => {
		const home = dir("term-home-");
		plant(home, join(home, "ran"));
		const result = resolvePresetBinary(
			"pi",
			home,
			{ PATH: [".", "/usr/bin"].join(delimiter) },
			home,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("inside");
	});
});

describe("runExternalAgent PATH hand-off", () => {
	test("the preset runs with a PATH that has no '.' or in-project entry", async () => {
		const project = dir("term-proj-");
		const outside = dir("term-outside-");
		mkdirSync(join(project, "bin"), { recursive: true });
		const bin = join(outside, "pi");
		writeFileSync(bin, '#!/bin/sh\nprintf "PATH=%s\\n" "$PATH"\n');
		chmodSync(bin, 0o755);
		const savedPath = process.env.PATH;
		const savedCwd = process.cwd();
		process.chdir(project);
		process.env.PATH = [".", "bin", join(project, "bin"), outside, "/usr/bin", "/bin"].join(
			delimiter,
		);
		try {
			const result = await runExternalAgent(getPreset("pi")!, "hello");
			const line = result.text.split("\n").find((l) => l.startsWith("PATH=")) ?? "";
			const entries = line.slice("PATH=".length).split(delimiter);
			expect(entries).toContain(outside);
			expect(entries).not.toContain(".");
			expect(entries).not.toContain("bin");
			expect(entries).not.toContain(join(project, "bin"));
		} finally {
			process.chdir(savedCwd);
			process.env.PATH = savedPath;
		}
	});
});
