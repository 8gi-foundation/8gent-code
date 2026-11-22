/**
 * The bridge is an administrator of groups it does not answer in, so it
 * receives their messages and, before this, threw them away. Telegram gives
 * bots no history API, so a dropped update is gone permanently.
 *
 * These tests pin the three properties that matter:
 *   1. a readable group message is recorded, as sender id, time and a hash
 *   2. a stranger's words never reach the file (8SO ruling, gov #1156 s3, #339)
 *   3. observation can NEVER throw, because it runs inside the poll loop and
 *      a throw there kills polling while leaving the process alive
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { sep } from "node:path";
import { OBSERVED_LOG, observeUnauthorized } from "./telegram-bridge";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

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
		expect(
			OBSERVED_LOG.startsWith(`${process.env.HOME}${sep}`),
			`${OBSERVED_LOG} vs HOME=${process.env.HOME} EIGHT_HOME=${process.env.EIGHT_HOME}`,
		).toBe(true);
	});

	test("records a group message as sender id, time and a hash of the text, nothing else", () => {
		const text = "harness is booting, hitting a tool-call parse issue";
		observeUnauthorized({
			update_id: 42,
			message: {
				date: 1756400000,
				message_id: 1864,
				text,
				chat: { id: -200000003, title: "8gi - agentics", type: "supergroup" },
				from: { id: 777000123, username: "fullyhermybot", is_bot: true },
			},
		});

		const lines = readLines();
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({
			id: 777000123,
			ts: new Date(1756400000 * 1000).toISOString(),
			sha256: sha256(text),
		});
	});

	test("a stranger's message text, name and chat title never appear in the log (#339)", () => {
		const words = "my home address is 12 Example Street, call me on 0870000000";
		observeUnauthorized({
			update_id: 46,
			message: {
				date: 1756400002,
				message_id: 9,
				text: words,
				chat: { id: 555, title: "Private Family Chat", type: "private" },
				from: { id: 555, username: "a_stranger", first_name: "Stranger" },
			},
		});
		const raw = existsSync(OBSERVED_LOG) ? readFileSync(OBSERVED_LOG, "utf8") : "";
		expect(raw.length).toBeGreaterThan(0);
		for (const leak of [
			"12 Example Street",
			"0870000000",
			"a_stranger",
			"Stranger",
			"Private Family Chat",
		]) {
			expect(raw).not.toContain(leak);
		}
		expect(JSON.parse(raw.trim()).sha256).toBe(sha256(words));
	});

	test("keeps a photo caption, which is still readable content", () => {
		observeUnauthorized({
			update_id: 43,
			message: {
				date: 1756400001,
				caption: "screenshot of the failing run",
				chat: { id: -200000003 },
				from: { id: 4, first_name: "Hermy" },
			},
		});
		const lines = readLines();
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).sha256).toBe(sha256("screenshot of the failing run"));
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
			{
				message: {
					get text(): string {
						throw new Error("boom");
					},
				},
			},
		];
		for (const u of hostile) {
			expect(() => observeUnauthorized(u)).not.toThrow();
		}
	});

	test("appends rather than overwriting, so a thread accumulates", () => {
		for (const text of ["first", "second", "third"]) {
			observeUnauthorized({
				message: { date: 1756400000, text, chat: { id: -1 }, from: { id: 9, username: "hermy" } },
			});
		}
		const lines = readLines();
		expect(lines).toHaveLength(3);
		expect(lines.map((l) => JSON.parse(l).sha256)).toEqual(
			["first", "second", "third"].map(sha256),
		);
	});
});
