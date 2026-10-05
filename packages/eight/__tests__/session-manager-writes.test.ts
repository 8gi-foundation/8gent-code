/**
 * SessionManager write-safety tests.
 *
 * Issue: 8gi-foundation/8gent-code#3522 (sessions part).
 *
 * 1. A truncated session file is moved aside to <id>.json.corrupt with one
 *    warning, and the next update() saves again instead of returning silently.
 * 2. A write that fails midway leaves the previous session file intact.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../session-manager";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-session-writes-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("SessionManager write safety (#3522)", () => {
	it("moves a truncated session file aside and resumes saving", () => {
		const sm = new SessionManager(dir);
		const info = sm.create({ model: "m", provider: "p" });
		const file = path.join(dir, `${info.id}.json`);
		const good = fs.readFileSync(file, "utf-8");
		fs.writeFileSync(file, good.slice(0, Math.floor(good.length / 2)));

		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const messages = [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			];
			sm.update(info.id, messages);

			expect(warn).toHaveBeenCalledTimes(1);
			expect(fs.existsSync(`${file}.corrupt`)).toBe(true);

			const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
			expect(saved.id).toBe(info.id);
			expect(saved.messages).toEqual(messages);
			expect(saved.messageCount).toBe(2);

			sm.update(info.id, [...messages, { role: "user", content: "again" }]);
			expect(JSON.parse(fs.readFileSync(file, "utf-8")).messageCount).toBe(3);
			expect(sm.list().map((s) => s.id)).toContain(info.id);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("resumes saving when list() quarantined the torn file before update()", () => {
		const sm = new SessionManager(dir);
		const info = sm.create({ model: "m", provider: "p" });
		const file = path.join(dir, `${info.id}.json`);
		const good = fs.readFileSync(file, "utf-8");
		fs.writeFileSync(file, good.slice(0, Math.floor(good.length / 2)));

		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(sm.list().map((s) => s.id)).not.toContain(info.id);
			expect(fs.existsSync(`${file}.corrupt`)).toBe(true);
			expect(fs.existsSync(file)).toBe(false);

			const messages = [{ role: "user", content: "after list" }];
			sm.update(info.id, messages);

			const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
			expect(saved.id).toBe(info.id);
			expect(saved.messages).toEqual(messages);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0][0])).toContain("session name was reset");
		} finally {
			warn.mockRestore();
		}
	});

	it("leaves the previous file intact when a write fails midway", () => {
		const sm = new SessionManager(dir);
		const info = sm.create({ model: "m", provider: "p" });
		sm.update(info.id, [{ role: "user", content: "first" }]);
		const file = path.join(dir, `${info.id}.json`);
		const before = fs.readFileSync(file, "utf-8");

		const real = fs.writeFileSync;
		const stub = spyOn(fs, "writeFileSync").mockImplementation(((
			target: fs.PathOrFileDescriptor,
			data: string | NodeJS.ArrayBufferView,
			...rest: unknown[]
		) => {
			const text = String(data);
			real(target, text.slice(0, Math.floor(text.length / 3)), ...(rest as []));
			throw new Error("ENOSPC: simulated disk full");
		}) as typeof fs.writeFileSync);
		try {
			expect(() =>
				sm.update(info.id, [
					{ role: "user", content: "first" },
					{ role: "assistant", content: "x".repeat(4096) },
				]),
			).toThrow("ENOSPC");
		} finally {
			stub.mockRestore();
		}

		expect(fs.readFileSync(file, "utf-8")).toBe(before);
		expect(JSON.parse(before).messageCount).toBe(1);
		expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("keeps resume(), update() and rename() inside the sessions directory", () => {
		const sessions = path.join(dir, "sessions");
		const outside = path.join(dir, "outside");
		fs.mkdirSync(outside);
		const target = path.join(outside, "x.json");
		const sibling = `${target}.corrupt`;
		const targetBody = "{ // not strict JSON\n}\n";
		const siblingBody = '{"keep": true}\n';
		fs.writeFileSync(target, targetBody);
		fs.writeFileSync(sibling, siblingBody);

		const sm = new SessionManager(sessions);
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			for (const id of ["../outside/x", "../OUTSIDE/X", `${outside}/x`]) {
				expect(sm.resume(id)).toBeNull();
				sm.update(id, [{ role: "user", content: "nope" }]);
				sm.rename(id, "nope");
			}
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}

		expect(fs.readdirSync(outside).sort()).toEqual(["x.json", "x.json.corrupt"]);
		expect(fs.readFileSync(target, "utf-8")).toBe(targetBody);
		expect(fs.readFileSync(sibling, "utf-8")).toBe(siblingBody);
		expect(fs.readdirSync(sessions)).toEqual([]);
	});

	it("writes session files owner-only and creates the directory owner-only", () => {
		const sessions = path.join(dir, "fresh", "sessions");
		const sm = new SessionManager(sessions);
		const info = sm.create();
		expect(fs.statSync(sessions).mode & 0o777).toBe(0o700);
		expect(fs.statSync(path.join(sessions, `${info.id}.json`)).mode & 0o777).toBe(0o600);
	});

	it("removes the temp file when the final rename fails", () => {
		const sm = new SessionManager(dir);
		const info = sm.create();
		const before = fs.readFileSync(path.join(dir, `${info.id}.json`), "utf-8");
		const stub = spyOn(fs, "renameSync").mockImplementation(() => {
			throw new Error("EXDEV: simulated rename failure");
		});
		try {
			expect(() => sm.update(info.id, [{ role: "user", content: "x" }])).toThrow("EXDEV");
		} finally {
			stub.mockRestore();
		}
		expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		expect(fs.readFileSync(path.join(dir, `${info.id}.json`), "utf-8")).toBe(before);
	});
});
