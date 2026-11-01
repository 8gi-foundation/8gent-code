import { describe, expect, test } from "bun:test";
import { buildToolCatalogSegment, environmentNote } from "./system-prompt";

describe("environmentNote", () => {
	test("Git Bash on Windows says POSIX syntax and paths with /", () => {
		const note = environmentNote({ platform: "win32", shell: { kind: "git-bash", file: "bash.exe" }, cwd: "C:\\work" });
		expect(note).toContain("Windows");
		expect(note).toContain("Git Bash");
		expect(note).toContain("paths with /");
		expect(note).toContain("cwd C:\\work");
	});

	test("cmd.exe tells the model ls and grep are missing", () => {
		const note = environmentNote({ platform: "win32", shell: { kind: "cmd", file: "cmd.exe" } });
		expect(note).toContain("cmd.exe");
		expect(note).toContain("ls and grep are not installed");
		expect(note).not.toContain("cwd");
	});

	test("PowerShell names its syntax", () => {
		expect(environmentNote({ platform: "win32", shell: { kind: "powershell", file: "pwsh.exe" } })).toContain("PowerShell syntax");
	});

	test("macOS and Linux say sh and /", () => {
		expect(environmentNote({ platform: "darwin" })).toBe("**Environment: macOS, shell sh, paths use /.**");
		expect(environmentNote({ platform: "linux", cwd: "/w" })).toContain("Linux");
	});

	test("the tool catalog carries the environment line", () => {
		expect(buildToolCatalogSegment({ concise: true, cwd: "/proj" })).toContain("**Environment: ");
		expect(buildToolCatalogSegment({ concise: true, cwd: "/proj" })).toContain("cwd /proj");
	});
});
