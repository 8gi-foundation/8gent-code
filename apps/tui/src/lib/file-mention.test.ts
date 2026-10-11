import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyMention,
	listProjectFiles,
	mentionAtEnd,
	rankFiles,
	scoreFile,
} from "./file-mention.js";

describe("@ file mention (#3918 D2)", () => {
	test("mentionAtEnd finds the @token being typed", () => {
		expect(mentionAtEnd("read @src/ap")).toEqual({ query: "src/ap", start: 5 });
		expect(mentionAtEnd("@")).toEqual({ query: "", start: 0 });
		expect(mentionAtEnd("read @src/app.tsx and")).toBeNull();
		expect(mentionAtEnd("mail me at a@b")).toBeNull();
		expect(mentionAtEnd("no mention")).toBeNull();
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

	test("listProjectFiles walks a folder that is not a git repo", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-mention-"));
		try {
			fs.mkdirSync(path.join(dir, "src"));
			fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
			fs.writeFileSync(path.join(dir, "src", "main.ts"), "");
			fs.writeFileSync(path.join(dir, "node_modules", "x", "index.js"), "");
			const files = listProjectFiles(dir);
			expect(files).toContain("src/main.ts");
			expect(files.some((f) => f.startsWith("node_modules"))).toBeFalse();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("listProjectFiles uses git in a repo", () => {
		const files = listProjectFiles(path.join(import.meta.dir, "../../../.."));
		expect(files).toContain("apps/tui/src/lib/file-mention.ts");
		expect(files.some((f) => f.includes("node_modules/"))).toBeFalse();
	});
});
