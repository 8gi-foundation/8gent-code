import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyMention,
	listProjectFiles,
	mentionAtEnd,
	rankFiles,
	safeNames,
	scoreFile,
} from "./file-mention.js";

describe("@ file mention (#3918 D2)", () => {
	test("mentionAtEnd finds the @token being typed", () => {
		expect(mentionAtEnd("read @src/ap")).toEqual({ query: "src/ap", start: 5 });
		expect(mentionAtEnd("@")).toEqual({ query: "", start: 0 });
		expect(mentionAtEnd("read @src/app.tsx and")).toBeNull();
		expect(mentionAtEnd("mail me at a@b")).toBeNull();
		expect(mentionAtEnd("no mention")).toBeNull();
		expect(mentionAtEnd("!git log @{u")).toBeNull();
		expect(mentionAtEnd("  !!ls @src")).toBeNull();
	});

	test("applyMention replaces the token and adds a space", () => {
		expect(applyMention("read @ap", 5, "apps/tui/src/app.tsx")).toBe("read @apps/tui/src/app.tsx ");
		expect(applyMention("@my", 0, "my file.md")).toBe('@"my file.md" ');
	});

	test("ranking prefers file-name matches and shorter paths", () => {
		const files = [
			"apps/tui/src/app.tsx",
			"apps/tui/src/components/command-input.tsx",
			"packages/eight/agent.ts",
			"docs/application-notes.md",
			"README.md",
		];
		expect(rankFiles(files, "app")[0]).toBe("apps/tui/src/app.tsx");
		expect(rankFiles(files, "cmdinp")[0]).toBe("apps/tui/src/components/command-input.tsx");
		expect(rankFiles(files, "agent")[0]).toBe("packages/eight/agent.ts");
		expect(rankFiles(files, "zzz")).toEqual([]);
		expect(rankFiles(files, "", 2)).toHaveLength(2);
		expect(scoreFile("README.md", "rdme")).not.toBeNull();
	});

	test("listProjectFiles walks a folder that is not a git repo, skipping dot and build folders", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-mention-"));
		try {
			fs.mkdirSync(path.join(dir, "src"));
			fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
			fs.mkdirSync(path.join(dir, ".ssh"));
			fs.writeFileSync(path.join(dir, "src", "main.ts"), "");
			fs.writeFileSync(path.join(dir, ".env"), "");
			fs.writeFileSync(path.join(dir, "node_modules", "x", "index.js"), "");
			fs.writeFileSync(path.join(dir, ".ssh", "id_ed25519"), "");
			fs.writeFileSync(path.join(dir, "bad\x1b[2Jname.ts"), "");
			const files = await listProjectFiles(dir, "/nowhere");
			expect(files).toContain("src/main.ts");
			expect(files).toContain(".env");
			expect(files.some((f) => f.startsWith("node_modules"))).toBeFalse();
			expect(files.some((f) => f.startsWith(".ssh"))).toBeFalse();
			expect(files.some((f) => f.includes("\x1b"))).toBeFalse();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("listProjectFiles never walks the home directory", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-home-"));
		try {
			fs.writeFileSync(path.join(dir, "notes.txt"), "");
			expect(await listProjectFiles(dir, dir)).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("safeNames drops control characters and empties", () => {
		expect(safeNames(["a.ts", "", "b\x07.ts", "c\x7f", "d/e.ts"])).toEqual(["a.ts", "d/e.ts"]);
	});

	test("listProjectFiles uses git -z in a repo", async () => {
		const files = await listProjectFiles(path.join(import.meta.dir, "../../../.."));
		expect(files).toContain("apps/tui/src/lib/file-mention.ts");
		expect(files.some((f) => f.includes("node_modules/"))).toBeFalse();
		expect(files).not.toContain("");
	});
});
