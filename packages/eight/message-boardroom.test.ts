import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_WAIT_SECONDS,
	MESSAGE_BOARDROOM_TOOL_DEF,
	MESSAGE_LIMIT_PER_SESSION,
	_resetMessageCounts,
	messageBoardroom,
} from "./message-boardroom";

const dir = mkdtempSync(join(tmpdir(), "msg-boardroom-"));
const saved = process.env.EIGHT_INBOX_DIR;
process.env.EIGHT_INBOX_DIR = dir;
const msgs = join(dir, "harness-messages.jsonl");
const replies = join(dir, "harness-replies.jsonl");
const rows = () =>
	readFileSync(msgs, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
afterAll(() => {
	if (saved === undefined) Reflect.deleteProperty(process.env, "EIGHT_INBOX_DIR");
	else process.env.EIGHT_INBOX_DIR = saved;
	rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
	_resetMessageCounts();
	rmSync(msgs, { force: true });
	rmSync(replies, { force: true });
});
const ctx = (over = {}) => ({ session: "s1", task: "fix\nthe  thing", ...over });

describe("message_boardroom", () => {
	test("appends one JSON line with ts, id, session, task, text, needs_reply", async () => {
		const out = await messageBoardroom({ text: "  which port?  " }, ctx());
		expect(out).toContain("Sent to the boardroom");
		const [r] = rows();
		expect(Object.keys(r).sort()).toEqual(["id", "needs_reply", "session", "task", "text", "ts"]);
		expect(r).toMatchObject({
			session: "s1",
			task: "fix the thing",
			text: "which port?",
			needs_reply: false,
		});
		expect(Number.isNaN(Date.parse(r.ts))).toBe(false);
		expect(out).toContain(r.id);
	});
	test("file is private (0600)", async () => {
		await messageBoardroom({ text: "hi" }, ctx());
		expect(statSync(msgs).mode & 0o777).toBe(0o600);
	});
	test("empty and oversized text are refused and nothing is written", async () => {
		expect(await messageBoardroom({ text: "   " }, ctx())).toContain("[ERROR]");
		expect(await messageBoardroom({}, ctx())).toContain("[ERROR]");
		expect(await messageBoardroom({ text: "x".repeat(2001) }, ctx())).toContain("limit is 2000");
		expect(existsSync(msgs)).toBe(false);
	});
	test("a credential in the text is refused", async () => {
		const out = await messageBoardroom(
			{ text: "key is 123456789:AAH7k2mQ9xYzB3nC4dE5fG6hJ7kL8mN9pQr" },
			ctx(),
		);
		expect(out).toContain("[BLOCKED]");
		expect(existsSync(msgs)).toBe(false);
	});
	test("session limit: the 21st note is blocked, other sessions are unaffected", async () => {
		for (let i = 0; i < MESSAGE_LIMIT_PER_SESSION; i++)
			await messageBoardroom({ text: `n${i}` }, ctx());
		expect(await messageBoardroom({ text: "one more" }, ctx())).toContain("[BLOCKED]");
		expect(rows().length).toBe(MESSAGE_LIMIT_PER_SESSION);
		expect(await messageBoardroom({ text: "other" }, ctx({ session: "s2" }))).toContain("Sent");
	});
	test("needs_reply without wait_seconds does not wait", async () => {
		const out = await messageBoardroom(
			{ text: "q", needs_reply: true },
			ctx({ sleep: () => Promise.reject(new Error("must not sleep")) }),
		);
		expect(out).toContain("none is awaited");
		expect(rows()[0].needs_reply).toBe(true);
	});
	test("returns the reply that matches the id, ignoring other ids", async () => {
		let polls = 0;
		const out = await messageBoardroom(
			{ text: "q", needs_reply: true, wait_seconds: 30 },
			ctx({
				sleep: async () => {
					polls++;
					const id = rows()[0].id;
					writeFileSync(
						replies,
						`${JSON.stringify({ reply_to: "hm-other", text: "WRONG" })}\nnot json\n${JSON.stringify({ reply_to: id, text: "use 8790" })}\n`,
					);
				},
			}),
		);
		expect(polls).toBe(1);
		expect(out).toContain("use 8790");
		expect(out).toContain("not an approval");
		expect(out).not.toContain("WRONG");
	});
	test("times out with a clear no-reply line and never hangs", async () => {
		let t = 1_000_000;
		let slept = 0;
		const out = await messageBoardroom(
			{ text: "q", needs_reply: true, wait_seconds: 5 },
			ctx({
				now: () => t,
				sleep: async (ms: number) => {
					slept += ms;
					t += ms;
				},
			}),
		);
		expect(out).toContain("[NO REPLY]");
		expect(slept).toBeLessThanOrEqual(5_500);
	});
	test("wait is capped at 300 seconds", async () => {
		let t = 0;
		const out = await messageBoardroom(
			{ text: "q", needs_reply: true, wait_seconds: 99999 },
			ctx({
				now: () => t,
				sleep: async (ms: number) => {
					t += ms;
				},
			}),
		);
		expect(out).toContain(`within ${MAX_WAIT_SECONDS}s`);
	});
	test("an unwritable inbox returns an error, not a throw", async () => {
		writeFileSync(join(dir, "blocker"), "x");
		process.env.EIGHT_INBOX_DIR = join(dir, "blocker", "sub");
		const out = await messageBoardroom({ text: "x" }, ctx());
		process.env.EIGHT_INBOX_DIR = dir;
		expect(out).toContain("[ERROR]");
	});
	test("tool definition names the tool and requires text", () => {
		expect(MESSAGE_BOARDROOM_TOOL_DEF.function.name).toBe("message_boardroom");
		expect(MESSAGE_BOARDROOM_TOOL_DEF.function.parameters.required).toEqual(["text"]);
	});
});

describe("message_boardroom task field", () => {
	test("a credential in the task prompt is scrubbed before it is written", async () => {
		await messageBoardroom(
			{ text: "q" },
			{ session: "s9", task: "use 123456789:AAH7k2mQ9xYzB3nC4dE5fG6hJ7kL8mN9pQr to post" },
		);
		const raw = readFileSync(msgs, "utf8");
		expect(raw).not.toContain("AAH7k2mQ9xYz");
	});
});
