import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TelegramBridgeAdapter } from "./bridge-adapter";
import { DaemonClient, type WebSocketLike } from "./daemon-client";
import { FileSender } from "./file-sender";
import { SessionStore } from "./session-store";

class FakeSocket implements WebSocketLike {
	readyState = 1;
	sent: string[] = [];
	onopen: ((ev?: unknown) => void) | null = null;
	onclose: ((ev?: unknown) => void) | null = null;
	onerror: ((ev?: unknown) => void) | null = null;
	onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.readyState = 3;
		this.onclose?.();
	}
}

let originalFetch: typeof fetch;

interface FetchCall {
	url: string;
	body: any;
}

const fetchCalls: FetchCall[] = [];
let nextMessageId = 100;

beforeEach(() => {
	originalFetch = globalThis.fetch;
	fetchCalls.length = 0;
	nextMessageId = 100;
	globalThis.fetch = (async (url: any, init?: any) => {
		const u = String(url);
		const body = init?.body ? JSON.parse(init.body as string) : null;
		fetchCalls.push({ url: u, body });
		const messageId = ++nextMessageId;
		return {
			ok: true,
			status: 200,
			json: async () => ({ ok: true, result: { message_id: messageId } }),
		} as unknown as Response;
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

async function makeAdapter() {
	const sock = new FakeSocket();
	const client = new DaemonClient({
		url: "ws://test",
		channel: "telegram",
		socketFactory: () => sock,
	});
	const connecting = client.connect();
	sock.onopen?.();
	sock.onmessage?.({ data: JSON.stringify({ type: "session:created", sessionId: "sess_test" }) });
	await connecting;

	const adapter = new TelegramBridgeAdapter({
		telegramToken: "TEST_TOKEN",
		chatId: "CHAT_42",
		daemon: client,
		sessionStore: new SessionStore(),
		fileSender: new FileSender({ token: "TEST_TOKEN", chatId: "CHAT_42" }),
		autoAttachFiles: false,
		editThrottleMs: 0,
	});
	return { adapter, client, sock };
}

function emit(sock: FakeSocket, event: string, payload: object): void {
	sock.onmessage?.({ data: JSON.stringify({ type: "event", event, payload }) });
}

describe("TelegramBridgeAdapter", () => {
	it("runs a 5-step task and ends with one anchor + final summary", async () => {
		const { adapter, sock } = await makeAdapter();

		await adapter.handleUserMessage("Read auth.ts, edit it, run tests, commit, push");

		// Initial sendMessage establishes the anchor.
		const initialSends = fetchCalls.filter((c) => c.url.endsWith("/sendMessage"));
		expect(initialSends.length).toBe(1);

		// Drive 5 tool start/result events.
		const tools = ["read_file", "edit_file", "bash", "git", "git"];
		for (const tool of tools) {
			emit(sock, "tool:start", {
				sessionId: "sess_test",
				tool,
				input: { path: `f-${tool}.ts`, command: "go" },
			});
			emit(sock, "tool:result", {
				sessionId: "sess_test",
				tool,
				output: "ok",
				durationMs: 50,
			});
			// Yield so any throttled flush fires.
			await new Promise((r) => setTimeout(r, 5));
		}

		// Final stream event.
		emit(sock, "agent:stream", {
			sessionId: "sess_test",
			chunk: "All five steps complete.",
			final: true,
		});

		await new Promise((r) => setTimeout(r, 20));

		const editCalls = fetchCalls.filter((c) => c.url.endsWith("/editMessageText"));
		expect(editCalls.length).toBeGreaterThan(0);
		const final = editCalls[editCalls.length - 1];
		expect(final.body.text).toContain("Done");
		expect(final.body.text).toContain("All five steps complete.");
		// The anchor message id was the one returned from the original sendMessage.
		expect(final.body.message_id).toBe(101);

		adapter.close();
	});

	it("transitions to failed state on agent:error", async () => {
		const { adapter, sock } = await makeAdapter();
		await adapter.handleUserMessage("do thing");
		emit(sock, "tool:start", {
			sessionId: "sess_test",
			tool: "bash",
			input: { command: "false" },
		});
		emit(sock, "agent:error", { sessionId: "sess_test", error: "boom" });
		await new Promise((r) => setTimeout(r, 5));

		const last = fetchCalls.filter((c) => c.url.endsWith("/editMessageText")).pop();
		expect(last?.body.text).toContain("Failed");
		expect(last?.body.text).toContain("boom");
		expect(last?.body.reply_markup).toBeDefined();
		adapter.close();
	});

	it("rejects a second user message while a task is in flight", async () => {
		const { adapter } = await makeAdapter();
		await adapter.handleUserMessage("first");
		fetchCalls.length = 0;
		await adapter.handleUserMessage("second");
		const sends = fetchCalls.filter((c) => c.url.endsWith("/sendMessage"));
		expect(sends.length).toBe(1);
		expect(sends[0].body.text).toContain("Still working");
		adapter.close();
	});
});
