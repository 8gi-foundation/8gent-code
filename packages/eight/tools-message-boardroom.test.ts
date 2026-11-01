/**
 * message_boardroom reaches the model through ToolExecutor (#4344): advertised by default,
 * withheld with EIGHT_MESSAGE_BOARDROOM=0, and executing it appends to the inbox.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "./tools";

const work = mkdtempSync(join(tmpdir(), "mb-work-"));
const inbox = mkdtempSync(join(tmpdir(), "mb-inbox-"));
const saved = { dir: process.env.EIGHT_INBOX_DIR, off: process.env.EIGHT_MESSAGE_BOARDROOM };
process.env.EIGHT_INBOX_DIR = inbox;
afterAll(() => {
	for (const [k, v] of [
		["EIGHT_INBOX_DIR", saved.dir],
		["EIGHT_MESSAGE_BOARDROOM", saved.off],
	] as const) {
		if (v === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = v;
	}
	rmSync(work, { recursive: true, force: true });
	rmSync(inbox, { recursive: true, force: true });
});
const names = (e: ToolExecutor) =>
	(e.getToolDefinitions() as Array<{ function: { name: string } }>).map((d) => d.function.name);

describe("message_boardroom through ToolExecutor", () => {
	test("advertised by default", () => {
		Reflect.deleteProperty(process.env, "EIGHT_MESSAGE_BOARDROOM");
		expect(names(new ToolExecutor(work, "mb-test"))).toContain("message_boardroom");
	});
	test("withheld and refused with EIGHT_MESSAGE_BOARDROOM=0", async () => {
		process.env.EIGHT_MESSAGE_BOARDROOM = "0";
		const e = new ToolExecutor(work, "mb-test");
		expect(names(e)).not.toContain("message_boardroom");
		expect(await e.execute("message_boardroom", { text: "hi" })).toContain("switched off");
		Reflect.deleteProperty(process.env, "EIGHT_MESSAGE_BOARDROOM");
	});
	test("execute appends one line carrying the session and the turn task", async () => {
		const e = new ToolExecutor(work, "mb-test", "sess-42");
		e.beginTurn("rebase the branch");
		const out = await e.execute("message_boardroom", { text: "main moved, force push ok?" });
		expect(out).toContain("Sent to the boardroom");
		const row = JSON.parse(readFileSync(join(inbox, "harness-messages.jsonl"), "utf8").trim());
		expect(row).toMatchObject({
			session: "sess-42",
			task: "rebase the branch",
			text: "main moved, force push ok?",
			needs_reply: false,
		});
	});
});
