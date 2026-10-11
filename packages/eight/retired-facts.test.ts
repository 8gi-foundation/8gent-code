import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { RetiredFacts } from "./retired-facts";
import { ToolExecutor } from "./tools";

const NOTES = [
	"- Delivery date: 24 November 2026.",
	"- Support hours: weekdays 09:00 to 17:00.",
	"Superseded, do not use:",
	"- ~~Delivery date: 3 November 2026~~ (superseded, the date moved)",
].join("\n");

describe("RetiredFacts (#3811)", () => {
	test("a retired date copied into a draft warns, in one short line", () => {
		const r = new RetiredFacts();
		r.noteRead("/w/NOTES.md", NOTES);
		const w = r.warn("/w/out.txt", "Hi Dana, delivery is 3 November 2026.");
		expect(w).toContain('"3 november 2026"');
		expect(w).toContain("NOTES.md:4");
		expect(w.includes("\n")).toBe(false);
	});

	test("the same date also present as current does not warn", () => {
		const r = new RetiredFacts();
		r.noteRead("/w/NOTES.md", `${NOTES}\n- Kickoff: 3 November 2026.`);
		expect(r.warn("/w/out.txt", "Kickoff is 3 November 2026.")).toBe("");
	});

	test("the live date and unrelated numbers do not warn", () => {
		const r = new RetiredFacts();
		r.noteRead("/w/NOTES.md", NOTES);
		expect(
			r.warn("/w/out.txt", "Due 24 November 2026. Call 3 people, or 12 of them, at 17:00."),
		).toBe("");
	});

	test("nothing read means no warning", () => {
		expect(new RetiredFacts().warn("/w/out.txt", "3 November 2026")).toBe("");
	});

	test("word markers retire a whole line; a struck span retires only the span", () => {
		const r = new RetiredFacts();
		r.noteRead("/w/N.md", "Version 1.4 is obsolete.\nPrice ~~49.00~~ 59.00 now.");
		expect(r.warn("/w/o.txt", "Use 1.4")).toContain("1.4");
		expect(r.warn("/w/o.txt", "Price 49.00")).toContain("49.00");
		expect(r.warn("/w/o.txt", "Price 59.00")).toBe("");
	});

	test("the file that holds the marker is not warned about, and reset forgets", () => {
		const r = new RetiredFacts();
		r.noteRead("/w/NOTES.md", NOTES);
		expect(r.warn("/w/NOTES.md", NOTES)).toBe("");
		r.reset();
		expect(r.warn("/w/out.txt", "3 November 2026")).toBe("");
	});

	test("caps the list at five tokens", () => {
		const r = new RetiredFacts();
		r.noteRead("/w/N.md", "obsolete: 111 222 333 444 555 666 777");
		expect((r.warn("/w/o.txt", "111 222 333 444 555 666 777").match(/"/g) ?? []).length).toBe(10);
	});
});

describe("write_file result carries the warning (#3811)", () => {
	const dir = tempDir("retired-facts-");
	afterAll(() => cleanupTempDirs());
	fs.writeFileSync(path.join(dir, "NOTES.md"), NOTES);

	test("read NOTES.md, write a draft with the retired date: warned, file still written unchanged", async () => {
		const ex = new ToolExecutor(dir);
		await ex.execute("read_file", { path: "NOTES.md" });
		const body = "Delivery: 24 November 2026 (not 3 November 2026).";
		const out = await ex.execute("write_file", { path: "outbox/d.txt", content: body });
		expect(out).toContain("File written");
		expect(out).toContain("[Retired fact]");
		expect(fs.readFileSync(path.join(dir, "outbox/d.txt"), "utf-8")).toBe(body);
	});

	test("a write with no earlier read has no warning", async () => {
		const out = await new ToolExecutor(dir).execute("write_file", {
			path: "outbox/e.txt",
			content: "3 November 2026",
		});
		expect(out).not.toContain("[Retired fact]");
	});
});
