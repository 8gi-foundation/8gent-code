import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BUILT_IN_SLASH_COMMANDS } from "./slash-commands.js";
import { SessionChanges, diffBody, isDiffText } from "./session-changes.js";

let dir: string;
let sc: SessionChanges;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-changes-"));
	sc = new SessionChanges(() => dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const edit = (id: string, file: string, next: string, ok = true) => {
	sc.begin(id, "edit_file", { path: file });
	fs.writeFileSync(path.join(dir, file), next);
	return sc.finish(id, ok);
};

describe("inline diff after an edit", () => {
	test("shows the removed and added lines with a header", () => {
		fs.writeFileSync(path.join(dir, "math.ts"), "a\nb\nc\n");
		const out = edit("1", "math.ts", "a\nB\nc\n");
		expect(out).not.toBeNull();
		expect(out).toContain("diff math.ts  +1 -1");
		expect(out).toContain("-b");
		expect(out).toContain("+B");
		expect(isDiffText(out as string)).toBe(true);
	});
	test("a new file is all additions", () => {
		sc.begin("1", "write_file", { path: "new.ts" });
		fs.writeFileSync(path.join(dir, "new.ts"), "x\ny\n");
		const out = sc.finish("1", true);
		expect(out).toContain("(new file)");
		expect(out).toContain("+x");
	});
	test("a failed call, a non-file tool and a no-op edit show nothing", () => {
		fs.writeFileSync(path.join(dir, "f.ts"), "a\n");
		expect(edit("1", "f.ts", "b\n", false)).toBeNull();
		sc.begin("2", "run_command", { path: "f.ts" });
		expect(sc.finish("2", true)).toBeNull();
		expect(edit("3", "f.ts", "b\n")).toBeNull(); // already "b" on disk
	});
	test("a long diff is capped and points at /diff", () => {
		fs.writeFileSync(path.join(dir, "big.ts"), "");
		const out = edit("1", "big.ts", `${Array.from({ length: 300 }, (_, i) => `l${i}`).join("\n")}\n`);
		expect((out as string).split("\n").length).toBeLessThan(50);
		expect(out).toContain("more lines");
	});
});

describe("/diff report", () => {
	test("says so when nothing changed", () => {
		expect(sc.report()).toBe("No file changes in this session yet.");
	});
	test("covers every edited file against where it started, across several edits", () => {
		fs.writeFileSync(path.join(dir, "a.ts"), "1\n2\n3\n");
		fs.writeFileSync(path.join(dir, "b.ts"), "x\n");
		edit("1", "a.ts", "1\n2b\n3\n");
		edit("2", "a.ts", "1\n2c\n3\n");
		edit("3", "b.ts", "y\n");
		const r = sc.report();
		expect(r).toContain("diff a.ts  +1 -1");
		expect(r).toContain("-2\n+2c");
		expect(r).not.toContain("2b");
		expect(r).toContain("diff b.ts");
	});
	test("a file edited back to its start drops out", () => {
		fs.writeFileSync(path.join(dir, "a.ts"), "1\n");
		edit("1", "a.ts", "2\n");
		edit("2", "a.ts", "1\n");
		expect(sc.report()).toBe("No file changes in this session yet.");
	});
});

describe("what is drawn is safe (security review of #109)", () => {
	const SECRET = "hunter2hunter2xyz";

	test("a secret value in a file is never drawn, inline or in /diff", () => {
		fs.writeFileSync(path.join(dir, "app.env.txt"), "DEBUG=1\n");
		const inline = edit("1", "app.env.txt", `DEBUG=1\nDATABASE_PASSWORD=${SECRET}\nAPI_KEY=abcd1234efgh5678ijkl\n`);
		expect(inline).not.toBeNull();
		expect(inline).not.toContain(SECRET);
		expect(inline).not.toContain("abcd1234efgh5678ijkl");
		expect(inline).toContain("[REDACTED");
		const report = sc.report();
		expect(report).not.toContain(SECRET);
		expect(report).toContain("[REDACTED");
	});

	test("a workspace .env is never drawn", () => {
		fs.writeFileSync(path.join(dir, ".env"), "A=1\n");
		const out = edit("1", ".env", `A=1\nDATABASE_PASSWORD=${SECRET}\n`);
		expect(out ?? "").not.toContain(SECRET);
		expect(sc.report()).not.toContain(SECRET);
	});

	test("an ESC, OSC or C1 byte in a file is never drawn", () => {
		fs.writeFileSync(path.join(dir, "n.txt"), "a\n");
		const evil = "\x1b]0;pwned\x07\x1b[31mred\x1b[0m\u009b2J\x1b]8;;http://x\x1b\\link\u202e\n";
		const inline = edit("1", "n.txt", evil) as string;
		expect(inline).not.toBeNull();
		for (const bad of ["\x1b", "\x07", "\u009b", "\u202e"]) {
			expect(inline).not.toContain(bad);
			expect(sc.report()).not.toContain(bad);
		}
	});

	test("a ../ path, an absolute outside path and a symlink out are never read", () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "session-outside-"));
		try {
			const target = path.join(outside, "x.ts");
			fs.writeFileSync(target, "one\n");
			fs.symlinkSync(outside, path.join(dir, "link"));
			const rel = path.relative(dir, target);
			for (const p of [rel, target, "link/x.ts"]) {
				sc.begin("c", "edit_file", { path: p });
				fs.writeFileSync(target, `two-${p.length}\n`);
				// A read at begin() would have recorded "one" and produced a diff here.
				expect(sc.finish("c", true)).toBeNull();
			}
			expect(sc.report()).toBe("No file changes in this session yet.");
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("diffBody", () => {
	test("keeps two lines of context and numbers the hunk", () => {
		const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
		const b = a.replace("l10", "X");
		const { body, stat } = diffBody(a, b);
		expect(stat).toEqual({ added: 1, removed: 1 });
		expect(body[0]).toBe("@@ -9,5 +9,5 @@");
		expect(body).toContain(" l8");
		expect(body).not.toContain(" l7");
	});
});

describe("/diff is a registered command", () => {
	test("in the built-in registry", () => {
		expect(BUILT_IN_SLASH_COMMANDS.some((c) => c.name === "diff")).toBe(true);
	});
});
