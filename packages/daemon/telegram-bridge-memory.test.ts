/**
 * Bridge wiring for operator memory, Phase 1 (#4391): the path that ships, not just the module.
 * Recall rides only in the prompt prefix; the default config touches no disk; commands are
 * operator-DM only; a group never reaches memory. Same fetch-stub shape as the routing test (no
 * describe/beforeEach).
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramMemory, seedMatrix } from "../memory/telegram-memory";
import { OPERATOR_COMMANDS, TelegramDaemonBridge } from "./telegram-bridge";

const OP = 111111111;
const KEY = Buffer.alloc(32, 3);

async function withBridge(
	envOver: Record<string, string | undefined>,
	fn: (h: {
		send: (text: string, chatId?: number, chatType?: string) => Promise<void>;
		prompts: Array<[string, string | undefined]>;
		replies: string[];
		dir: string;
	}) => Promise<void>,
) {
	const root = mkdtempSync(join(tmpdir(), "tgbridge-mem-"));
	const dir = join(root, "memory");
	const real = globalThis.fetch;
	const replies: string[] = [];
	globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
		if (String(url).includes("sendMessage") && init?.body) replies.push(JSON.parse(init.body).text);
		return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
	try {
		const env = { TELEGRAM_OPERATOR_USER_IDS: String(OP), ...envOver };
		const bridge = new TelegramDaemonBridge({
			telegramToken: "test-token",
			chatId: String(OP),
			daemonUrl: "ws://127.0.0.1:1",
			authorizedChatIds: [String(OP), "-1001"],
			authorizedUserIds: [String(OP)],
			operatorUserIds: [String(OP)],
			env,
		});
		// biome-ignore lint/suspicious/noExplicitAny: reaching private state is the point of the test.
		const b = bridge as any;
		const prompts: Array<[string, string | undefined]> = [];
		b.multiStepEnabled = true;
		b.adapter = { handleUserMessage: async (t: string, p?: string) => void prompts.push([t, p]) };
		b.memoryStore = new TelegramMemory({ dir, env, keyProvider: () => KEY, log: () => {} });
		seedMatrix(dir, [String(OP)]);
		await fn({
			send: (text, chatId = OP, chatType = "private") =>
				b.handleTelegramMessage(text, chatId, { chatType, fromId: OP }),
			prompts,
			replies,
			dir,
		});
	} finally {
		globalThis.fetch = real;
		rmSync(root, { recursive: true, force: true });
	}
}

test("a fact said in the operator DM comes back in the next prompt prefix, quoted, and not in the text", async () => {
	await withBridge({ TELEGRAM_MEMORY_CHAT_IDS: String(OP) }, async ({ send, prompts }) => {
		await send("my cat is called Biscuit");
		await send("what is my cat called");
		expect(prompts[0]).toEqual(["my cat is called Biscuit", undefined]);
		expect(prompts[1][0]).toBe("what is my cat called");
		expect(prompts[1][1]).toContain("Untrusted recalled content");
		expect(prompts[1][1]).toContain('"my cat is called Biscuit"');
	});
});

test("default config (list empty): no recall, no disk, prompt text unchanged", async () => {
	await withBridge({}, async ({ send, prompts, dir }) => {
		await send("my cat is called Biscuit");
		await send("what is my cat called");
		expect(prompts.map((p) => p[1])).toEqual([undefined, undefined]);
		expect(existsSync(join(dir, "memory.db.enc"))).toBe(false);
	});
});

test("a group message never reaches memory, even from the operator in a listed group", async () => {
	await withBridge({ TELEGRAM_MEMORY_CHAT_IDS: `${OP},-1001` }, async ({ send, prompts, dir }) => {
		await send("my cat is called Biscuit", -1001, "supergroup");
		expect(existsSync(join(dir, "memory.db.enc"))).toBe(false);
		expect(prompts.every((p) => p[1] === undefined)).toBe(true);
	});
});

test("/memoff, /memon and /memwipe are answered in the DM and never reach the agent", async () => {
	await withBridge({ TELEGRAM_MEMORY_CHAT_IDS: String(OP) }, async ({ send, prompts, replies }) => {
		await send("my cat is called Biscuit");
		await send("/memoff");
		expect(replies.at(-1)).toMatch(/Memory is off/);
		await send("what is my cat called");
		expect(prompts.at(-1)?.[1]).toBeUndefined(); // off: no recall
		await send("/memon");
		await send("/memwipe");
		const code = replies.at(-1)?.match(/\d{6}/)?.[0] ?? "";
		expect(code).toHaveLength(6);
		await send(`/memwipe ${code}`);
		expect(replies.at(-1)).toMatch(/^Erased\./);
		const n = prompts.length;
		await send("what is my cat called");
		expect(prompts.length).toBe(n + 1);
		expect(prompts.at(-1)?.[1]).toBeUndefined(); // wiped: nothing to recall
		for (const p of prompts) expect(p[0].startsWith("/mem")).toBe(false);
	});
});

test("memory commands in a group are refused", async () => {
	await withBridge({ TELEGRAM_MEMORY_CHAT_IDS: String(OP) }, async ({ send, replies }) => {
		await send("/memwipe", -1001, "supergroup");
		expect(replies.at(-1)).toMatch(/private chat only/);
	});
});

test("the three commands are operator commands", () => {
	for (const c of ["/memoff", "/memon", "/memwipe"]) {
		expect((OPERATOR_COMMANDS as readonly string[]).includes(c)).toBe(true);
	}
});
