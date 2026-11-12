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
});
