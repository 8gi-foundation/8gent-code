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
import { type PostMessageDeps, postMessage, postMessageDeps } from "./post-message";

const CHAT = "-1004417730052";
const FAKE_TOKEN = "123456789:AAFakeTokenFakeTokenFakeTokenFake_0123";

let ran: Array<{ bin: string; argv: string[] }> = [];
let asked = 0;
let logged: Array<Record<string, unknown>> = [];

function deps(over: Partial<PostMessageDeps> = {}): PostMessageDeps {
	ran = [];
	logged = [];
	return {
		run: async (bin, argv) => {
			ran.push({ bin, argv });
			return { code: 0, stdout: "4242\n", stderr: "" };
		},
		gate: () => ({ allowed: true }),
		infinite: () => false,
		bins: { text: "/x/tg-group", voice: "/x/say-telegram" },
		allowedChats: () => [CHAT],
		log: (e) => logged.push(e),
		limit: 10,
		sent: { n: 0 },
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

	test("a chat not on the allowlist is refused in every mode, card or not", async () => {
		person("approve");
		for (const infinite of [false, true]) {
			const out = await postMessage(
				{ chat: "-100999", text: "hi" },
				deps({ infinite: () => infinite }),
			);
			expect(out).toContain("not on postMessage.allowedChats");
		}
		expect(asked).toBe(0);
		expect(ran.length).toBe(0);
	});

	test("an empty allowlist posts nothing", async () => {
		person("approve");
		const out = await postMessage({ chat: CHAT, text: "hi" }, deps({ allowedChats: () => [] }));
		expect(out).toStartWith("[BLOCKED]");
		expect(ran.length).toBe(0);
	});

	test("infinite mode: allowlisted chat posts without a card and is logged, text and token absent", async () => {
		const out = await postMessage(
			{ chat: CHAT, text: "secret caption" },
			deps({ infinite: () => true }),
		);
		expect(out).toStartWith("Posted");
		expect(logged.length).toBe(1);
		expect(logged[0]).toMatchObject({ chat: CHAT, length: 14, voice: false });
		expect(typeof logged[0].at).toBe("string");
		expect(JSON.stringify(logged[0])).not.toContain("secret caption");
	});

	test("outside infinite mode the card still shows and a decline logs nothing", async () => {
		person("deny");
		await postMessage({ chat: CHAT, text: "hi" }, deps());
		expect(asked).toBe(1);
		expect(logged.length).toBe(0);
	});

	test("session rate limit: the 11th post is refused", async () => {
		const d = deps({ infinite: () => true });
		for (let i = 0; i < 10; i++)
			expect(await postMessage({ chat: CHAT, text: "x" }, d)).toStartWith("Posted");
		expect(await postMessage({ chat: CHAT, text: "x" }, d)).toContain("used its 10 posts");
		expect(ran.length).toBe(10);
	});

	test("attempts count: failed, refused and declined posts spend the limit too", async () => {
		const d = deps({
			infinite: () => true,
			limit: 3,
			run: async () => ({ code: 1, stdout: "", stderr: "no" }),
		});
		await postMessage({ chat: CHAT, text: "x" }, d);
		await postMessage({ chat: "-100999", text: "x" }, d);
		await postMessage({ chat: CHAT, text: "x" }, d);
		expect(d.sent.n).toBe(3);
		expect(await postMessage({ chat: CHAT, text: "x" }, d)).toContain("used its 3 posts");
		expect(logged.length).toBe(0);
	});

	test("real deps: the counter is keyed by the session key, not the agent id", () => {
		const a = postMessageDeps("primary", "sess-a");
		const b = postMessageDeps("primary", "sess-b");
		a.sent.n = 5;
		expect(b.sent.n).toBe(0);
		expect(postMessageDeps("other", "sess-a").sent.n).toBe(5);
	});

	test("bot tokens are scrubbed from helper errors, stdout and stderr, bare or in a URL", async () => {
		for (const [stdout, stderr] of [
			["", `Bad Request bot${FAKE_TOKEN}/sendMessage`],
			[`token ${FAKE_TOKEN} rejected`, ""],
		]) {
			const out = await postMessage(
				{ chat: CHAT, text: "hi" },
				deps({ infinite: () => true, run: async () => ({ code: 1, stdout, stderr }) }),
			);
			expect(out).toStartWith("[ERROR]");
			expect(out).not.toContain(FAKE_TOKEN);
			expect(out).not.toContain("AAFakeToken");
		}
	});

	test("text cap holds exactly and no attachment flag can be passed", async () => {
		person("approve");
		const ok = await postMessage({ chat: CHAT, text: "x".repeat(4096) }, deps());
		expect(ok).toStartWith("Posted");
		const out = await postMessage(
			{ chat: CHAT, text: "hi", file: "/etc/hosts", caption: "c" } as never,
			deps(),
		);
		expect(out).toStartWith("Posted");
		expect(ran[0].argv.join(" ")).not.toMatch(/--file|--caption/);
		expect(ran[0].argv[0]).toBe("text");
	});
});
