/**
 * #3199: one leading `cd <folder> &&` / `cd <folder>;` on run_command. The folder
 * becomes the working directory and only the rest runs; every other shape stays refused.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { cdPrefix, cdPrefixShape, commandAfterCdPrefix, commandInFolder } from "./cd-prefix";
import { sanitizeShellCommand } from "./shell-sanitizer";

afterAll(cleanupTempDirs);

let root = "";
let outside = "";

beforeEach(() => {
	root = realpathSync(tempDir("cd-prefix-root-"));
	outside = realpathSync(tempDir("cd-prefix-out-"));
	mkdirSync(join(root, "video", "frames"), { recursive: true });
	mkdirSync(join(root, "site"));
	mkdirSync(join(root, ".git"));
	mkdirSync(join(root, "video", ".cache"));
	writeFileSync(join(root, "notes.txt"), "x");
	symlinkSync(outside, join(root, "escape"));
	symlinkSync(root, join(root, "self"));
	symlinkSync(join(root, ".git"), join(root, "gitlink"));
	symlinkSync(join(root, "video"), join(root, "videolink"));
});

const accepted = (command: string) => {
	const cd = cdPrefix(command, root);
	if (cd.kind !== "cd") throw new Error(`expected cd for ${command}, got ${JSON.stringify(cd)}`);
	return cd;
};
const refusedWhy = (command: string): string => {
	const cd = cdPrefix(command, root);
	if (cd.kind !== "refused")
		throw new Error(`expected refused for ${command}, got ${JSON.stringify(cd)}`);
	return cd.message;
};

describe("accepted shapes", () => {
	test("`cd video && bash build.sh` runs bash build.sh in video", () => {
		expect(accepted("cd video && bash build.sh")).toEqual({
			kind: "cd",
			dir: join(root, "video"),
			rest: "bash build.sh",
		});
	});
	test("`cd site; npm init -y` (the semicolon form) is the same", () => {
		expect(accepted("cd site; npm init -y")).toMatchObject({
			dir: join(root, "site"),
			rest: "npm init -y",
		});
	});
	test("no spaces, a leading ./, a trailing /, nested folders", () => {
		expect(accepted("cd video&&ls").rest).toBe("ls");
		expect(accepted("cd ./video && ls").dir).toBe(join(root, "video"));
		expect(accepted("cd video/ && ls").dir).toBe(join(root, "video"));
		expect(accepted("cd video/frames && ls -la").dir).toBe(join(root, "video", "frames"));
	});
	test("a symlink to a folder inside the project runs in its real folder", () => {
		expect(accepted("cd videolink && ls").dir).toBe(join(root, "video"));
	});
	test("the rest is handed on whole, quotes and all", () => {
		expect(accepted(`cd video && magick -size 1280x720 caption:"a; b" out.png`).rest).toBe(
			`magick -size 1280x720 caption:"a; b" out.png`,
		);
	});
});

describe("refused shapes", () => {
	test("going up: cd .. && and cd a/../b &&", () => {
		expect(refusedWhy("cd .. && ls")).toContain("may not go up with ..");
		expect(refusedWhy("cd video/../site && ls")).toContain("may not go up with ..");
	});
	test("an absolute folder outside the project", () => {
		expect(refusedWhy(`cd ${outside} && ls`)).toContain("outside the project");
		expect(refusedWhy("cd /tmp && ls")).toContain("outside the project");
		expect(refusedWhy("cd /Users/x/.8gent/state && ls")).toBeTruthy();
		expect(refusedWhy("cd ~/.8gent && ls")).toContain("plain name");
		expect(refusedWhy("cd $HOME && ls")).toContain("plain name");
		expect(refusedWhy("cd /tmp/* && ls")).toContain("plain name");
		expect(refusedWhy(`cd ${root}/.. && ls`)).toContain("..");
		expect(refusedWhy(`cd ${root}/escape && ls`)).toContain("outside the project");
		expect(refusedWhy(`cd ${root}/.git && ls`)).toContain("dot directory");
		expect(refusedWhy(`cd ${root}/gitlink && ls`)).toContain("dot directory");
		expect(refusedWhy(`cd ${root}/nope && ls`)).toBeTruthy();
		expect(cdPrefixShape(`cd ${root} && ls`)).toBeNull();
	});
	test("$, ~, quotes, globs, spaces, a leading -", () => {
		for (const command of [
			"cd $X && ls",
			"cd ${HOME} && ls",
			"cd ~ && ls",
			"cd ~/video && ls",
			'cd "a b" && ls',
			"cd 'video' && ls",
			"cd vid* && ls",
			"cd vid? && ls",
			"cd a b && ls",
			"cd - && ls",
			"cd video\\ x && ls",
		])
			expect(refusedWhy(command), command).toContain("plain name");
	});
	test("a dot directory, named or nested", () => {
		expect(refusedWhy("cd .git && ls")).toContain("may not be a dot directory");
		expect(refusedWhy("cd video/.cache && ls")).toContain("may not be a dot directory");
		expect(refusedWhy("cd . && ls")).toContain("may not be a dot directory");
	});
	test("a symlink out of the project", () => {
		expect(refusedWhy("cd escape && ls")).toContain("resolves outside the project");
	});
	test("a symlink back to the project root", () => {
		expect(refusedWhy("cd self && ls")).toContain("resolves outside the project");
	});
	test("a plain-named symlink onto a dot directory", () => {
		expect(refusedWhy("cd gitlink && ls")).toContain("resolves into a dot directory");
	});
	// #4178 (8SO): the card shows `cd <real folder> && <rest>`, so a plain-named symlink
	// onto a folder whose real name would read as more shell is refused, not shown.
	test("a plain-named symlink onto a folder whose name is not plain", () => {
		const names = ["a && touch pwn", "a; curl x", "a\nrm -r old", "x\u001b[8m", "a\u00a0b", "-rf"];
		names.forEach((name, i) => {
			mkdirSync(join(root, name));
			symlinkSync(join(root, name), join(root, `odd${i}`));
			expect(refusedWhy(`cd odd${i} && ls`), JSON.stringify(name)).toContain(
				"resolves to a name that is not plain",
			);
		});
	});
	test("two cds", () => {
		expect(refusedWhy("cd video && cd frames && ls")).toContain("only one cd");
		expect(refusedWhy("cd video && cd frames")).toContain("only one cd");
		expect(refusedWhy("cd video; cd frames")).toContain("only one cd");
	});
	test("a missing folder, a file, and nothing after the cd", () => {
		expect(refusedWhy("cd nope && ls")).toContain("no folder nope");
		// #4421: the refusal names the working alternative in one plain sentence.
		expect(refusedWhy("cd nope && ls")).toContain("run the command without the cd");
		expect(refusedWhy("cd notes.txt && ls")).toContain("is not a folder");
		expect(refusedWhy("cd video && ")).toContain("nothing follows");
		expect(refusedWhy("cd ./ && ls")).toContain("name a folder");
	});
	test("every refusal reads as a chaining refusal, with the command", () => {
		const msg = refusedWhy("cd .. && ls");
		expect(msg).toStartWith("[BLOCKED] Command chaining is not allowed.");
		expect(msg).toEndWith("Command: cd .. && ls");
	});
});

describe("what the prefix does not change", () => {
	test("a line that does not start with cd is left alone", () => {
		for (const command of [
			"ls video",
			"bash video/build.sh",
			"echo cd video && ls",
			"cd video",
			"cd video || ls",
			"cd video & ls",
		])
			expect(cdPrefix(command, root), command).toEqual({ kind: "none" });
	});
	test("`cd a && b; c`: the prefix comes off, and the rest is still refused for chaining", () => {
		const cd = accepted("cd video && ls; rm -rf frames");
		expect(cd.rest).toBe("ls; rm -rf frames");
		expect(sanitizeShellCommand(cd.rest).safe).toBe(false);
	});
	test("`cd a && b && c` and `cd a && b || c`: the rest is still refused", () => {
		expect(sanitizeShellCommand(accepted("cd video && ls && rm x").rest).safe).toBe(false);
		expect(sanitizeShellCommand(accepted("cd video && ls || rm x").rest).safe).toBe(false);
		expect(sanitizeShellCommand(accepted("cd video && ls $(rm x)").rest).safe).toBe(false);
		expect(sanitizeShellCommand(accepted("cd video && ls\nrm x").rest).safe).toBe(false);
	});
	test("PowerShell and cmd are left alone", () => {
		expect(cdPrefix("cd video && ls", root, "powershell")).toEqual({ kind: "none" });
		expect(cdPrefix("cd video; ls", root, "cmd")).toEqual({ kind: "none" });
		expect(cdPrefix("cd video && ls", root, "git-bash").kind).toBe("cd");
	});
	test("commandAfterCdPrefix: the rest for an accepted prefix, the line otherwise", () => {
		expect(commandAfterCdPrefix("cd video && git commit -m x", root)).toBe("git commit -m x");
		expect(commandAfterCdPrefix("cd .. && git commit -m x", root)).toBe("cd .. && git commit -m x");
		expect(commandAfterCdPrefix("git status", root)).toBe("git status");
	});
});

describe("cdPrefixShape (no filesystem, for the loop breaker)", () => {
	test("plain folder words pass on shape alone", () => {
		expect(cdPrefixShape("cd video && bash build.sh")).toEqual({
			folder: "video",
			rest: "bash build.sh",
		});
		expect(cdPrefixShape("cd nope; ls")).toEqual({ folder: "nope", rest: "ls" });
	});
	test("every text-level refusal is refused by shape too", () => {
		for (const command of [
			"cd .. && ls",
			"cd /tmp && ls",
			"cd $X && ls",
			'cd "a b" && ls',
			"cd .git && ls",
			"cd a && cd b && ls",
		])
			expect(cdPrefixShape(command), command).toBeNull();
		expect(cdPrefixShape("cd video && ls", "powershell")).toBeNull();
	});
});

// #4178: every card cuts a long command at its end, so the folder goes first.
describe("commandInFolder: the folder leads the card", () => {
	const LONG = `magick -size 1280x720 xc:'#0f2b3d' -fill white caption:@t2.txt slide2.png ${"-quality 92 ".repeat(30)}`;

	test("`rm -rf old` in video is shown as `cd video && rm -rf old`", () => {
		expect(commandInFolder("rm -rf old", "video")).toBe("cd video && rm -rf old");
		expect(commandInFolder("rm -rf old")).toBe("rm -rf old");
	});
	test("a 300-character command shows its folder in the first 20 characters", () => {
		expect(LONG.length).toBeGreaterThan(300);
		const shown = commandInFolder(LONG, "video");
		expect(shown.indexOf("video")).toBeGreaterThanOrEqual(0);
		expect(shown.indexOf("video")).toBeLessThan(20);
	});
	test("cut to any card width from 20 up, the folder survives", () => {
		const shown = commandInFolder(LONG, "video/frames");
		for (const width of [20, 40, 60, 76, 120]) {
			expect(`${shown.slice(0, width - 1)}…`, String(width)).toContain("cd video/frames &&");
		}
	});
	test("a folder that is not plain is shown quoted and escaped, never raw (8SO)", () => {
		expect(commandInFolder("ls", "a && touch pwn")).toBe('cd "a && touch pwn" && ls');
		expect(commandInFolder("ls", "a\nb")).toBe('cd "a\\nb" && ls');
		expect(commandInFolder("rm -rf old", "x\u001b[8m")).toBe('cd "x\\u001b[8m" && rm -rf old');
		expect(commandInFolder("ls", "a\u00a0b")).toBe('cd "a\\u00a0b" && ls');
		for (const w of ["a && b", "a\nb", "x\u001b[8m", "a\u00a0b", "a\u2028b"])
			expect(commandInFolder("ls", w), JSON.stringify(w)).toMatch(/^[\x20-\x7e]*$/);
	});
	test("the shown text parses back to the same folder and rest", () => {
		const cd = cdPrefix(commandInFolder("bash build.sh", "video/frames"), root);
		expect(cd).toEqual({ kind: "cd", dir: join(root, "video", "frames"), rest: "bash build.sh" });
	});
});

describe("absolute folders that resolve inside the project", () => {
	test("the project root itself", () => {
		expect(accepted(`cd ${root} && python3 x.py`)).toEqual({
			kind: "cd",
			dir: root,
			rest: "python3 x.py",
		});
	});
	test("an absolute subfolder", () => {
		expect(accepted(`cd ${root}/video/frames && ls`)).toMatchObject({
			dir: join(root, "video", "frames"),
			rest: "ls",
		});
	});
	test("an absolute symlink inside that stays inside", () => {
		expect(accepted(`cd ${root}/videolink && ls`).dir).toBe(join(root, "video"));
	});
});
