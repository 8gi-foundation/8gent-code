/**
 * post_message (#3595): posting to Telegram is an outward action. It goes
 * through the policy gate, then the person; only then does the local
 * tg-group / say-telegram helper run, with argv and never a shell string.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
} from "../permissions/tui-approval-channel";
import { type PostMessageDeps, postMessage } from "./post-message";

const CHAT = "-1004417730052";
const FAKE_TOKEN = "123456789:AAFakeTokenFakeTokenFakeTokenFake_0123";

let ran: Array<{ bin: string; argv: string[] }> = [];
let asked = 0;

function deps(over: Partial<PostMessageDeps> = {}): PostMessageDeps {
	ran = [];
	return {
		run: async (bin, argv) => {
			ran.push({ bin, argv });
			return { code: 0, stdout: "4242\n", stderr: "" };
		},
		gate: () => ({ allowed: true }),
		infinite: () => false,
		bins: { text: "/x/tg-group", voice: "/x/say-telegram" },
		...over,
	};
}

function person(decision: "approve" | "deny" | "unfit") {
	asked = 0;
	registerTuiApprovalHandler(async () => {
		asked++;
		return decision;
	});
}
afterEach(() => _resetTuiApprovalChannel());

describe("post_message", () => {
	test("approved: one argv call to tg-group, returns the message id", async () => {
		person("approve");
		const out = await postMessage({ chat: CHAT, text: "line one\nline two" }, deps());
		expect(asked).toBe(1);
		expect(ran).toEqual([
			{ bin: "/x/tg-group", argv: ["text", "--chat", CHAT, "--", "line one\nline two"] },
		]);
		expect(out).toContain("4242");
		expect(out).toStartWith("Posted");
	});

	test("text that looks like a flag is passed after --", async () => {
		person("approve");
		await postMessage({ chat: CHAT, text: "--chat 1" }, deps());
		expect(ran[0].argv.slice(-2)).toEqual(["--", "--chat 1"]);
	});

	test("voice uses say-telegram with the named voice", async () => {
		person("approve");
		await postMessage({ chat: CHAT, text: "hello", voice: "Rishi" }, deps());
		expect(ran[0]).toEqual({
			bin: "/x/say-telegram",
			argv: ["--voice", "Rishi", "--chat", CHAT, "--", "hello"],
		});
	});

	test("declined: nothing runs", async () => {
		person("deny");
		const out = await postMessage({ chat: CHAT, text: "hi" }, deps());
		expect(ran.length).toBe(0);
		expect(out).toContain("PERMISSION DENIED");
	});

	test("card does not fit: nothing runs", async () => {
		person("unfit");
		const out = await postMessage({ chat: CHAT, text: "hi" }, deps());
		expect(ran.length).toBe(0);
		expect(out).toStartWith("[BLOCKED]");
	});

	test("the card shows the chat and the whole text", async () => {
		let seen: { command?: string; full?: boolean } = {};
		registerTuiApprovalHandler(async (req) => {
			seen = req;
			return "deny";
		});
		await postMessage({ chat: CHAT, text: "the whole caption" }, deps());
		expect(seen.full).toBe(true);
		expect(seen.command).toContain(CHAT);
		expect(seen.command).toContain("the whole caption");
	});

	test("no one to ask (no handler, no TTY): refused, nothing runs", async () => {
		const out = await postMessage({ chat: CHAT, text: "hi" }, deps());
		expect(ran.length).toBe(0);
		expect(out).toStartWith("[BLOCKED]");
	});

	test("infinite mode runs without a card", async () => {
		person("deny");
		const out = await postMessage({ chat: CHAT, text: "hi" }, deps({ infinite: () => true }));
		expect(asked).toBe(0);
		expect(ran.length).toBe(1);
		expect(out).toStartWith("Posted");
	});

	test("policy block: nothing runs, no card", async () => {
		person("approve");
		const out = await postMessage(
			{ chat: CHAT, text: "hi" },
			deps({ gate: () => ({ allowed: false, reason: "blocked by rule" }) }),
		);
		expect(asked).toBe(0);
		expect(ran.length).toBe(0);
		expect(out).toContain("blocked by rule");
	});

	test("bad input is refused before any card or run", async () => {
		person("approve");
		for (const bad of [
			{ chat: "me; ls", text: "x" },
			{ chat: CHAT, text: "" },
			{ chat: CHAT, text: "x".repeat(4097) },
			{ chat: CHAT, text: "x".repeat(601), voice: "Rishi" },
			{ chat: CHAT, text: "x", voice: "Rishi; ls" },
		]) {
			expect(await postMessage(bad, deps())).toStartWith("[ERROR]");
		}
		expect(asked).toBe(0);
		expect(ran.length).toBe(0);
	});

	test("a failing helper is reported without any token", async () => {
		person("approve");
		const out = await postMessage(
			{ chat: CHAT, text: "hi" },
			deps({
				run: async () => ({
					code: 1,
					stdout: "",
					stderr: `tg-group: Bad Request https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`,
				}),
			}),
		);
		expect(out).toStartWith("[ERROR]");
		expect(out).not.toContain(FAKE_TOKEN);
		expect(out).not.toContain("AAFakeToken");
	});

	test("a helper that prints no message id is not reported as posted", async () => {
		person("approve");
		const out = await postMessage(
			{ chat: CHAT, text: "hi" },
			deps({ run: async () => ({ code: 0, stdout: "", stderr: "" }) }),
		);
		expect(out).toStartWith("[ERROR]");
	});
});
