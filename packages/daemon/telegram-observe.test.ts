/**
 * The bridge is an administrator of groups it does not answer in, so it
 * receives their messages and, before this, threw them away. Telegram gives
 * bots no history API, so a dropped update is gone permanently.
 *
 * These tests pin the two properties that matter:
 *   1. a readable group message is recorded
 *   2. observation can NEVER throw, because it runs inside the poll loop and
 *      a throw there kills polling while leaving the process alive
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { sep } from "node:path";
import { OBSERVED_LOG, observeUnauthorized } from "./telegram-bridge";

const readLines = () =>
	existsSync(OBSERVED_LOG)
		? readFileSync(OBSERVED_LOG, "utf8").trim().split("\n").filter(Boolean)
		: [];

afterEach(() => {
	try {
		rmSync(OBSERVED_LOG);
	} catch {}
});

describe("observeUnauthorized", () => {
	test("writes under the test's temp $HOME, never the real ~/.8gent (#3240)", () => {
		const realHome = homedir();
		expect(OBSERVED_LOG.startsWith(`${realHome}${sep}`)).toBe(false);
		expect(OBSERVED_LOG.startsWith(`${process.env.HOME}${sep}`)).toBe(true);
	});

	test("records a group message so another process can read it", () => {
		observeUnauthorized({
			update_id: 42,
			message: {
				date: 1756400000,
				message_id: 1864,
				text: "harness is booting, hitting a tool-call parse issue",
				chat: { id: -1003845259821, title: "8gi - agentics", type: "supergroup" },
				from: { username: "fullyhermybot", is_bot: true },
			},
		});

		const lines = readLines();
		expect(lines).toHaveLength(1);
		const row = JSON.parse(lines[0]);
		expect(row.chat_id).toBe(-1003845259821);
		expect(row.from).toBe("fullyhermybot");
		expect(row.is_bot).toBe(true);
		expect(row.text).toContain("tool-call parse issue");
		expect(row.at).toBe(new Date(1756400000 * 1000).toISOString());
	});

	test("keeps a photo caption, which is still readable content", () => {
		observeUnauthorized({
			update_id: 43,
			message: {
				date: 1756400001,
				caption: "screenshot of the failing run",
				chat: { id: -1003845259821 },
				from: { first_name: "Hermy" },
			},
		});
		expect(readLines()).toHaveLength(1);
	});

	test("skips updates with nothing readable rather than writing empty rows", () => {
		observeUnauthorized({ update_id: 44, message: { date: 1, chat: { id: -1 } } });
		observeUnauthorized({ update_id: 45 }); // no message at all
		expect(readLines()).toHaveLength(0);
	});

	test("never throws, whatever it is handed", () => {
		const hostile: unknown[] = [
			undefined,
			null,
			"a string",
			42,
			{ message: null },
			{ message: { text: "x", chat: null, from: null, date: null } },
			{ message: { get text(): string { throw new Error("boom"); } } },
		];
		for (const u of hostile) {
			expect(() => observeUnauthorized(u)).not.toThrow();
		}
	});

	test("appends rather than overwriting, so a thread accumulates", () => {
		for (const text of ["first", "second", "third"]) {
			observeUnauthorized({
				message: { date: 1756400000, text, chat: { id: -1 }, from: { username: "hermy" } },
			});
		}
		const lines = readLines();
		expect(lines).toHaveLength(3);
		expect(lines.map((l) => JSON.parse(l).text)).toEqual(["first", "second", "third"]);
	});
});
