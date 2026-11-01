import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionWriter } from "./writer.js";

let tmp: string | undefined;
afterEach(() => {
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	tmp = undefined;
});

const last = (file: string) =>
	JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").pop() ?? "{}");

describe("session_end carries read_cards_shown (#4897)", () => {
	test("the count handed to writeSessionEnd lands in the summary", () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sw-cards-"));
		const w = new SessionWriter("cards", tmp);
		w.writeSessionEnd("user_exit", null, 2);
		const end = last(w.getFilePath());
		expect(end.type).toBe("session_end");
		expect(end.summary.read_cards_shown).toBe(2);
	});

	test("zero is written as zero; a caller that passes nothing leaves the key out", () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sw-cards-"));
		const a = new SessionWriter("zero", tmp);
		a.writeSessionEnd("user_exit", null, 0);
		expect(last(a.getFilePath()).summary.read_cards_shown).toBe(0);
		const b = new SessionWriter("none", tmp);
		b.writeSessionEnd("user_exit", null);
		expect("read_cards_shown" in last(b.getFilePath()).summary).toBe(false);
	});
});
