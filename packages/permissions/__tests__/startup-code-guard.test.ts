/**
 * 8SO F2 (#4009): what 8gent runs at start is read-only to model tools.
 *
 * ~/.8gent/hooks.yaml, hooks.json, extensions/, prompts/ and packages/ are code that
 * runs on the next start. validatePath refuses writes there (reads stay allowed) and
 * commandWritesStartupCode is the shell backstop. HOME is a throwaway dir.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commandWritesStartupCode, isStartupCodePath, validatePath } from "../path-guard";

const saved = {
	HOME: process.env.HOME,
	EIGHT_FAKE_HOME: process.env.EIGHT_FAKE_HOME,
	EIGHT_DATA_DIR: process.env.EIGHT_DATA_DIR,
	EIGHT_HOOKS_YAML: process.env.EIGHT_HOOKS_YAML,
};
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "startup-code-")));
const HOME = path.join(base, "home");
const PROJ = path.join(base, "work", "proj");
fs.mkdirSync(path.join(HOME, ".8gent", "extensions", "ext1"), { recursive: true });
fs.mkdirSync(path.join(HOME, ".8gent", "prompts"), { recursive: true });
fs.mkdirSync(path.join(HOME, ".8gent", "packages"), { recursive: true });
fs.writeFileSync(path.join(HOME, ".8gent", "hooks.yaml"), "[]\n");
fs.mkdirSync(path.join(PROJ, ".8gent", "extensions"), { recursive: true });
process.env.HOME = HOME;
process.env.EIGHT_FAKE_HOME = HOME;
delete process.env.EIGHT_DATA_DIR;
delete process.env.EIGHT_HOOKS_YAML;

afterAll(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(base, { recursive: true, force: true });
});

const PROTECTED = [
	".8gent/hooks.yaml",
	".8gent/hooks.json",
	".8gent/extensions/ext1/index.ts",
	".8gent/extensions/new/8gent-extension.json",
	".8gent/extensions",
	".8gent/prompts/system.md",
	".8gent/packages/8gent-packages.lock",
	".8gent/packages/pkg/index.js",
];

describe("validatePath: startup code is write-protected (#4009)", () => {
	for (const rel of PROTECTED) {
		test(`write refused, read allowed: ~/${rel}`, () => {
			for (const spelling of [`~/${rel}`, path.join(HOME, rel)]) {
				const w = validatePath(spelling, PROJ, {}, "write");
				expect(w.ok).toBe(false);
				if (!w.ok) expect(w.reason).toBe("protected 8gent startup code");
				expect(validatePath(spelling, PROJ, {}, "read").ok).toBe(true);
			}
		});
	}

	test("./ and .. spellings resolve to the same file", () => {
		expect(validatePath("./.8gent/hooks.yaml", HOME).ok).toBe(false);
		expect(validatePath("../../home/.8gent/extensions/x.ts", PROJ).ok).toBe(false);
		expect(validatePath(path.join(HOME, ".8gent", "prompts", "..", "hooks.yaml"), PROJ).ok).toBe(
			false,
		);
	});

	test("case does not slip past on macOS", () => {
		const host = { platform: "darwin" as const, home: HOME };
		expect(isStartupCodePath(path.join(HOME, ".8GENT", "Hooks.YAML"), host)).toBe(true);
		expect(isStartupCodePath(path.join(HOME, ".8gent", "EXTENSIONS", "a.ts"), host)).toBe(true);
		if (process.platform === "darwin")
			expect(validatePath("~/.8GENT/HOOKS.yaml", PROJ).ok).toBe(false);
		// Linux file systems are case-sensitive: a different name is a different file.
		expect(
			isStartupCodePath(path.join(HOME, ".8gent", "HOOKS.yaml"), { platform: "linux", home: HOME }),
		).toBe(false);
	});

	test("a symlinked HOME is compared on its realpath", () => {
		const link = path.join(base, "home-link");
		fs.symlinkSync(HOME, link);
		const host = { home: link };
		expect(validatePath(path.join(HOME, ".8gent", "hooks.yaml"), PROJ, host).ok).toBe(false);
		expect(validatePath(path.join(link, ".8gent", "hooks.yaml"), PROJ, host).ok).toBe(false);
		expect(validatePath(path.join(link, ".8gent", "prompts", "a.md"), PROJ).ok).toBe(false);
	});

	test("a symlink in the project that points into startup code is refused", () => {
		const l = path.join(PROJ, "ext-link");
		fs.symlinkSync(path.join(HOME, ".8gent", "extensions"), l);
		expect(validatePath(path.join(l, "evil.ts"), PROJ).ok).toBe(false);
		expect(validatePath(path.join(l, "evil.ts"), PROJ, {}, "read").ok).toBe(true);
		fs.unlinkSync(l);
	});

	test("EIGHT_DATA_DIR and EIGHT_HOOKS_YAML locations are protected too", () => {
		const dd = path.join(base, "data");
		fs.mkdirSync(dd);
		process.env.EIGHT_DATA_DIR = dd;
		process.env.EIGHT_HOOKS_YAML = path.join(base, "elsewhere-hooks.yaml");
		try {
			expect(validatePath(path.join(dd, "hooks.yaml"), PROJ).ok).toBe(false);
			expect(validatePath(path.join(dd, "extensions", "a.ts"), PROJ).ok).toBe(false);
			expect(validatePath(process.env.EIGHT_HOOKS_YAML, PROJ).ok).toBe(false);
		} finally {
			delete process.env.EIGHT_DATA_DIR;
			delete process.env.EIGHT_HOOKS_YAML;
		}
	});

	test("a project-local .8gent/ is not affected", () => {
		expect(validatePath(".8gent/hooks.yaml", PROJ).ok).toBe(true);
		expect(validatePath(".8gent/extensions/a.ts", PROJ).ok).toBe(true);
		expect(validatePath(path.join(PROJ, ".8gent", "prompts", "p.md"), PROJ).ok).toBe(true);
		// Other ~/.8gent files keep their old treatment.
		expect(validatePath("~/.8gent/notes.md", PROJ).ok).toBe(true);
		expect(validatePath("~/.8gent/extensions-notes.md", PROJ).ok).toBe(true);
	});
});

describe("commandWritesStartupCode: shell writes are refused (#4009)", () => {
	const WRITES = [
		"echo x > ~/.8gent/hooks.yaml",
		"echo x >> $HOME/.8gent/hooks.json",
		"echo x > ${HOME}/.8gent/prompts/system.md",
		"printf x &> ~/.8gent/packages/lock",
		"cp evil.ts ~/.8gent/extensions/",
		"cp -r evil ~/.8gent/extensions/evil",
		"cp -r extensions ~/.8gent/",
		"cp -t ~/.8gent/prompts a.md",
		"mv evil.yaml ~/.8gent/hooks.yaml",
		"mv ~/.8gent/hooks.yaml /tmp/x",
		"mv prompts ~/.8gent",
		"cat evil | tee ~/.8gent/hooks.yaml",
		"tee -a ~/.8gent/hooks.yaml < evil",
		"ln -s /tmp/evil.ts ~/.8gent/extensions/evil.ts",
		"ln -sf $PWD/evil ~/.8gent/packages/pkg",
		"touch ~/.8gent/extensions/x.ts",
		"rm -r ~/.8gent/extensions",
		"rm ~/.8gent/prompts/*",
		"sed -i '' s/a/b/ ~/.8gent/hooks.yaml",
		"dd if=evil of=~/.8gent/hooks.yaml",
		"tar -xf evil.tar -C ~/.8gent/packages",
		"cd ~/.8gent && echo x > hooks.yaml",
		"cd ~/.8gent/packages && npm install evil",
		"cd ~/.8gent/extensions; touch a.ts",
		"cd ~ && cp evil .8gent/hooks.yaml",
		"D=~/.8gent; echo x > $D/hooks.yaml",
		"export D=$HOME/.8gent/prompts && cp a.md $D/",
		'echo x > "$HOME"/".8gent"/hooks.yaml',
		"echo x > ~/.8GENT/HOOKS.yaml",
		"echo x > ~/.8g*/hooks.yaml",
		"cp evil ~/.8gent/ext*/evil.ts",
		"python3 -c \"open('/x/.8gent/hooks.yaml','w')\"",
		"node -e \"require('fs').writeFileSync(require('os').homedir()+'/.8gent/hooks.yaml','x')\"",
		"sudo cp evil ~/.8gent/hooks.yaml",
		"find ~/.8gent/extensions -name '*.ts' -delete",
		"echo x > ../../home/.8gent/hooks.yaml",
	];
	for (const c of WRITES) {
		test(c, () => expect(commandWritesStartupCode(c, PROJ)).toBe(true));
	}

	const ALLOWED = [
		"cat ~/.8gent/hooks.yaml",
		"ls -la ~/.8gent/extensions",
		"grep -r foo ~/.8gent/prompts",
		"cp ~/.8gent/hooks.yaml ./hooks-backup.yaml",
		"cat ~/.8gent/hooks.yaml > review.txt",
		"find ~/.8gent/extensions -name '*.ts'",
		"head ~/.8gent/packages/lock 2>&1",
		"echo x > .8gent/hooks.yaml",
		"cp evil.ts .8gent/extensions/",
		"mkdir -p .8gent/prompts && touch .8gent/prompts/a.md",
		"cd .8gent && echo x > hooks.yaml",
		"echo ~/.8gent/hooks.yaml",
		"ls src && bun test",
	];
	for (const c of ALLOWED) {
		test(`allowed: ${c}`, () => expect(commandWritesStartupCode(c, PROJ)).toBe(false));
	}

	test("a project-local .8gent/ write is refused when the project is HOME", () => {
		expect(commandWritesStartupCode("echo x > .8gent/hooks.yaml", HOME)).toBe(true);
		expect(commandWritesStartupCode("cp evil.ts .8gent/extensions/", HOME)).toBe(true);
		expect(commandWritesStartupCode("echo x > hooks.yaml", path.join(HOME, ".8gent"))).toBe(true);
		expect(commandWritesStartupCode("npm install", path.join(HOME, ".8gent", "packages"))).toBe(
			true,
		);
		expect(commandWritesStartupCode("cat hooks.yaml", path.join(HOME, ".8gent"))).toBe(false);
	});
});
