/** #4530: the Telegram control bot passes the shared input gate before agent.chat and agent.btw. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setClassifyObserver } from "../daemon/input-gate";
import { TelegramBot } from "./index";

const realFetch = globalThis.fetch;
let sent: string[];
const order: string[] = [];

beforeEach(() => {
	sent = [];
	order.length = 0;
	globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
		try {
			const b = init?.body ? JSON.parse(init.body) : {};
			if (typeof b.text === "string") sent.push(b.text);
		} catch {}
		return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
	}) as unknown as typeof fetch;
	setClassifyObserver((_t, _c, r) => order.push(`classify:${r.kind}`));
});
afterEach(() => {
	globalThis.fetch = realFetch;
	setClassifyObserver();
});

function make() {
	const reached: string[] = [];
	const bot = new TelegramBot({ token: "tok", rateLimit: 100, maxMessageLength: 15000 }) as any;
	bot.agent = {
		async chat(t: string) {
			reached.push(`chat:${t}`);
			order.push("model");
			return `model:${t}`;
		},
		async btw(t: string) {
			reached.push(`btw:${t}`);
			order.push("model");
			return `btw:${t}`;
		},
	};
	const say = (text: string) =>
		bot.handleMessage({
			update_id: 1,
			message: {
				message_id: 1,
				from: { id: 7, first_name: "J" },
				chat: { id: 7, type: "private" },
				text,
				date: 0,
			},
		});
	return { reached, say };
}

describe("telegram bot input gate", () => {
	test("a slash line is answered locally and never reaches the model", async () => {
		const t = make();
		await t.say("/session");
		expect(t.reached).toEqual([]);
		expect(order).toEqual(["classify:slash"]);
		expect(sent.some((s) => s.includes("tg-7"))).toBe(true);
	});
	test("a blocked (unknown) slash line is refused with the gate message, never the model", async () => {
		const t = make();
		await t.say("/nosuchthing now");
		expect(t.reached).toEqual([]);
		expect(sent).toContain("Unknown command /nosuchthing. Type /help.");
	});
	test("a slash line inside /btw never reaches the model", async () => {
		const t = make();
		await t.say("/btw /nosuchthing");
		expect(t.reached).toEqual([]);
		expect(sent).toContain("Unknown command /nosuchthing. Type /help.");
	});
	test("plain text reaches the model, classified first", async () => {
		const t = make();
		await t.say("hello there");
		expect(t.reached).toEqual(["chat:hello there"]);
		expect(order).toEqual(["classify:pass", "model"]);
	});
});
