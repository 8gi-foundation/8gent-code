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

function lines(file: string): string[] {
	return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

describe("SessionWriter with a lost file descriptor (#4774)", () => {
	test("a closed fd is reopened, so the next turn's write neither throws EBADF nor is lost", () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sw-ebadf-"));
		const w = new SessionWriter("ebadf", tmp);
		w.writeUserMessage("first");
		fs.closeSync((w as unknown as { fd: number }).fd);
		expect(() => w.writeUserMessage("what is going on")).not.toThrow();
		expect(() => w.writeUserMessage("continue")).not.toThrow();
		const got = lines(w.getFilePath()).map((l) => JSON.parse(l).message.content);
		expect(got).toEqual(["first", "what is going on", "continue"]);
		expect(w.lastWriteError).toBeNull();
	});

	test("a closed fd number reused by another file is left alone", () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sw-ebadf-"));
		const w = new SessionWriter("reuse", tmp);
		const old = (w as unknown as { fd: number }).fd;
		fs.closeSync(old);
		const other = path.join(tmp, "other.txt");
		const otherFd = fs.openSync(other, "a");
		try {
			w.writeUserMessage("after reuse");
			expect(fs.readFileSync(other, "utf8")).toBe("");
			expect(lines(w.getFilePath())).toHaveLength(1);
		} finally {
			fs.closeSync(otherFd);
		}
	});

	test("a session path swapped for a symlink is not followed on reopen; the skip is counted", () => {
		if (process.platform === "win32") return;
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sw-ebadf-"));
		const w = new SessionWriter("link", tmp);
		const target = path.join(tmp, "secret.txt");
		fs.writeFileSync(target, "");
		fs.closeSync((w as unknown as { fd: number }).fd);
		fs.rmSync(w.getFilePath());
		fs.symlinkSync(target, w.getFilePath());
		expect(() => w.writeUserMessage("must not land")).not.toThrow();
		expect(fs.readFileSync(target, "utf8")).toBe("");
		expect(w.skippedWrites).toBe(1);
		expect(w.lastWriteError).not.toBeNull();
	});
});
