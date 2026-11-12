import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { learnedPath, printLearned, readLearned, recordLearned } from "./learned-audit";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpFile(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "learned-"));
	dirs.push(d);
	return path.join(d, ".8gent", "learned.jsonl");
}
const at = () => new Date("2026-11-12T10:00:00Z");

describe("learned audit file (#232 slice 1)", () => {
	it("appends one line per lesson and prints them in plain words", () => {
		const f = tmpFile();
		expect(recordLearned({ source: "memory", text: "Prefers bun over npm", where: "session_1" }, f, at)).toBe(true);
		expect(recordLearned({ source: "skills", text: "Run tests\nbefore  pushing" }, f, at)).toBe(true);
		expect(fs.readFileSync(f, "utf8").trim().split("\n")).toHaveLength(2);
		expect(printLearned(f)).toEqual([
			`2 things learned (${f}):`,
			"2026-11-12  memory: Prefers bun over npm (from session_1)",
			"2026-11-12  skills: Run tests before pushing",
		]);
	});

	it("says so when nothing is learned yet", () => {
		const f = tmpFile();
		expect(printLearned(f)[0]).toStartWith("Nothing learned yet.");
	});

	it("redacts secrets before they reach disk", () => {
		const f = tmpFile();
		recordLearned({ source: "memory", text: "key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }, f, at);
		expect(fs.readFileSync(f, "utf8")).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
	});

	it("refuses empty lessons and skips damaged lines", () => {
		const f = tmpFile();
		expect(recordLearned({ source: "memory", text: "   " }, f, at)).toBe(false);
		recordLearned({ source: "memory", text: "ok" }, f, at);
		fs.appendFileSync(f, "{not json\n");
		expect(readLearned(f).map((e) => e.text)).toEqual(["ok"]);
	});

	it("a write failure returns false and never throws", () => {
		expect(recordLearned({ source: "memory", text: "x" }, "/dev/null/x/learned.jsonl", at)).toBe(false);
	});

	it("lives under the 8gent home, so EIGHT_HOME moves it", () => {
		expect(learnedPath({ EIGHT_HOME: "/h" })).toBe("/h/.8gent/learned.jsonl");
	});

	it("strips control characters from every field at write time", () => {
		const f = tmpFile();
		recordLearned({ source: "mem\x1b[31mory", text: "a\x07b\x1b]0;title\x07c\u009bd", where: "s\x1b1" }, f, at);
		const raw = fs.readFileSync(f, "utf8");
		expect(raw.trim().split("\n")).toHaveLength(1);
		expect(readLearned(f)[0]).toMatchObject({ source: "mem [31mory", text: "a b ]0;title c d", where: "s 1" });
		expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(JSON.stringify(readLearned(f)))).toBe(false);
	});

	it("strips control characters at print time, even from a hand-edited file", () => {
		const f = tmpFile();
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, `${JSON.stringify({ at: "2026-11-12T10:00:00Z", source: "x\x1b[2J", text: "hi\x07", where: "w\x1b]0;t\x07" })}\n`);
		const out = printLearned(f).join("\n");
		expect(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(out)).toBe(false);
		expect(out).toContain("hi");
	});

	it("redacts source and where, not only text", () => {
		const f = tmpFile();
		const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
		recordLearned({ source: key, text: "t", where: key }, f, at);
		expect(fs.readFileSync(f, "utf8")).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
	});

	it("a line with a non-string time is skipped, not fatal", () => {
		const f = tmpFile();
		recordLearned({ source: "memory", text: "ok" }, f, at);
		fs.appendFileSync(f, `${JSON.stringify({ at: 5, source: "m", text: "bad" })}\n`);
		expect(readLearned(f).map((e) => e.text)).toEqual(["ok"]);
		expect(() => printLearned(f)).not.toThrow();
	});

	it("creates the file 0600 and the directory 0700, and tightens a wider file", () => {
		const f = tmpFile();
		recordLearned({ source: "m", text: "t" }, f, at);
		expect(fs.statSync(f).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(f)).mode & 0o777).toBe(0o700);
		fs.chmodSync(f, 0o644);
		recordLearned({ source: "m", text: "u" }, f, at);
		expect(fs.statSync(f).mode & 0o777).toBe(0o600);
	});

	it("refuses to write through a symlink", () => {
		const f = tmpFile();
		fs.mkdirSync(path.dirname(f), { recursive: true });
		const target = path.join(path.dirname(f), "elsewhere");
		fs.writeFileSync(target, "");
		fs.symlinkSync(target, f);
		expect(recordLearned({ source: "m", text: "t" }, f, at)).toBe(false);
		expect(fs.readFileSync(target, "utf8")).toBe("");
	});
});
