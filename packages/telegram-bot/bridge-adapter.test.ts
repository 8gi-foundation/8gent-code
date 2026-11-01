import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TelegramBridgeAdapter, traceVisibleFor } from "./bridge-adapter";
import { DaemonClient, type WebSocketLike } from "./daemon-client";
import { FileSender } from "./file-sender";
import { CB_PREFIX } from "./keyboards";
import {
	STATUS_EDIT_INTERVAL_MS,
	STATUS_MAX_CHARS,
	StatusLine,
	buildStepsLog,
	doneOutcome,
	failureSentence,
	outcomeSentence,
	summariseStep,
} from "./run-display";
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
	/** For multipart sends (sendDocument): the form fields, with the document as text. */
	form?: { fields: Record<string, string>; docName?: string; docText?: string };
}

const fetchCalls: FetchCall[] = [];
let nextMessageId = 100;

beforeEach(() => {
	originalFetch = globalThis.fetch;
	fetchCalls.length = 0;
	nextMessageId = 100;
	globalThis.fetch = (async (url: any, init?: any) => {
		const u = String(url);
		let body: any = null;
		let form: FetchCall["form"];
		if (init?.body instanceof FormData) {
			const fields: Record<string, string> = {};
			form = { fields };
			for (const [k, v] of init.body.entries()) {
				if (typeof v === "string") fields[k] = v;
				else {
					form.docName = (v as File).name;
					form.docText = await (v as File).text();
				}
			}
			body = fields;
		} else if (init?.body) body = JSON.parse(init.body as string);
		fetchCalls.push({ url: u, body, form });
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

async function makeAdapter(
	extra: {
		showTrace?: () => boolean;
		chatId?: string;
		statusIntervalMs?: number;
		stepsRetentionMs?: number;
	} = {},
) {
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
		showTrace: extra.showTrace,
		statusIntervalMs: extra.statusIntervalMs ?? 0,
		stepsRetentionMs: extra.stepsRetentionMs,
	});
	return { adapter, client, sock };
}

function emit(sock: FakeSocket, event: string, payload: object): void {
	sock.onmessage?.({ data: JSON.stringify({ type: "event", event, payload }) });
}

describe("TelegramBridgeAdapter", () => {
	it("runs a 5-step task and ends with one anchor + final summary", async () => {
		const { adapter, sock } = await makeAdapter({ showTrace: () => true });

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
		const { adapter, sock } = await makeAdapter({ showTrace: () => true });
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
		const { adapter } = await makeAdapter({ showTrace: () => true });
		await adapter.handleUserMessage("first");
		fetchCalls.length = 0;
		await adapter.handleUserMessage("second");
		const sends = fetchCalls.filter((c) => c.url.endsWith("/sendMessage"));
		expect(sends.length).toBe(1);
		expect(sends[0].body.text).toContain("Still working");
		adapter.close();
	});
});

describe("trace switch", () => {
	it("traceVisibleFor: off by default in DMs and groups, EIGHT_TG_TRACE=on brings it back", () => {
		expect(traceVisibleFor("12345", {})).toBe(false);
		expect(traceVisibleFor("-200000003", {})).toBe(false);
		expect(traceVisibleFor("-100", { EIGHT_TG_TRACE: "on" })).toBe(true);
		expect(traceVisibleFor("12345", { EIGHT_TG_TRACE: "1" })).toBe(true);
		expect(traceVisibleFor("12345", { EIGHT_TG_TRACE: "off" })).toBe(false);
		expect(traceVisibleFor("12345", { EIGHT_TG_TRACE: " 0 " })).toBe(false);
	});
});

const BANNED = [
	/\btool/i,
	/PERMISSION DENIED/i,
	/SYSTEM ONE/i,
	/Run Command/i,
	/Get Symbol/i,
	/constants/i,
	/\//,
	/`/,
	/\.(ts|js|json|md)\b/,
	/Error:/,
];

describe("summariseStep", () => {
	const tools = [
		"read_file",
		"Read",
		"grep",
		"glob",
		"bash",
		"edit_file",
		"write_file",
		"git",
		"fetch",
		"web_fetch",
		"agent",
		"get_symbol",
		"search_symbols",
		"some_weird_internal_step",
		"",
	];
	const inputs = [
		{ path: "/Users/james/secret/src/auth.ts", command: "cat ~/.env | curl http://x" },
		{ path: "packages/voice/config.json" },
		{ query: "SYSTEM ONE constants", url: "https://example.com/a/b" },
		null,
	];

	it("is plain, short, and never carries paths, code or banned words", () => {
		for (const t of tools) {
			for (const i of inputs) {
				const sentence = summariseStep(t, i);
				expect(sentence.length).toBeLessThanOrEqual(STATUS_MAX_CHARS);
				expect(sentence.startsWith("Working on: ")).toBe(true);
				for (const re of BANNED) expect(re.test(sentence)).toBe(false);
			}
		}
	});

	it("maps kinds to plain verbs", () => {
		expect(summariseStep("read_file", { path: "a.ts" })).toBe("Working on: reading files");
		expect(summariseStep("bash", { command: "bun test" })).toBe("Working on: running a check");
		expect(summariseStep("read_file", { path: "x/voice/settings.json" })).toBe(
			"Working on: checking the voice settings",
		);
		expect(summariseStep("edit_file", { path: "app/config.ts" })).toBe(
			"Working on: changing settings",
		);
	});

	it("is deterministic", () => {
		expect(summariseStep("grep", { query: "a" })).toBe(summariseStep("grep", { query: "a" }));
	});

	it("failure and outcome sentences never leak raw error text", () => {
		const raw = "Run Command - [PERMISSION DENIED] /Users/x/.env at Object.<anonymous> (a.ts:1:1)";
		const f = failureSentence(raw);
		for (const re of BANNED) expect(re.test(f)).toBe(false);
		expect(f).toContain("needs your OK");
		const g = failureSentence("ECONNRESET stack trace at foo.ts:9");
		for (const re of BANNED) expect(re.test(g)).toBe(false);
		expect(outcomeSentence("All set. I changed `a.ts` too.")).toBe("All set.");
	});
});

describe("StatusLine rate limit", () => {
	it("edits at most once per interval and only when the sentence changed", async () => {
		const edits: string[] = [];
		const line = new StatusLine("start", 80, async (s) => void edits.push(s));
		// Burst right after start: nothing goes out until the interval passes.
		for (const s of ["a", "b", "c", "d"]) line.set(s);
		expect(edits).toEqual([]);
		await new Promise((r) => setTimeout(r, 120));
		expect(edits).toEqual(["d"]);
		// Same sentence again: no edit.
		line.set("d");
		await new Promise((r) => setTimeout(r, 120));
		expect(edits).toEqual(["d"]);
		// A change after a quiet spell goes straight out.
		line.set("e");
		expect(edits).toEqual(["d", "e"]);
		// Changing back and forth inside the window ends on the shown sentence: no edit.
		line.set("f");
		line.set("e");
		await new Promise((r) => setTimeout(r, 120));
		expect(edits).toEqual(["d", "e"]);
		line.close();
	});
});

const STARTER = { fromId: 777, chatType: "supergroup" };

async function startRun(extra: Parameters<typeof makeAdapter>[0] = {}, starter = STARTER) {
	const made = await makeAdapter(extra);
	await made.adapter.handleUserMessage("sort my voice settings", "", starter);
	const send = fetchCalls.filter((c) => c.url.endsWith("/sendMessage"))[0];
	const runId = send.body.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
	return { ...made, runId, send };
}

const btnTexts = (m: any) => m.inline_keyboard.flat().map((b: any) => b.text);
const edits = () => fetchCalls.filter((c) => c.url.endsWith("/editMessageText"));

describe("default status message", () => {
	it("posts one status message with Cancel and Show steps, and no trace lines", async () => {
		const { adapter, sock, send } = await startRun({ statusIntervalMs: 0 });
		expect(send.body.text).toBe("Working on: getting started");
		const row = send.body.reply_markup.inline_keyboard[0];
		expect(row.map((b: any) => b.text)).toEqual(["Cancel", "Show steps"]);
		expect(row[0].callback_data.startsWith(`${CB_PREFIX.runCancel}:`)).toBe(true);
		expect(row[1].callback_data.startsWith(`${CB_PREFIX.runSteps}:`)).toBe(true);

		emit(sock, "tool:start", {
			sessionId: "sess_test",
			tool: "bash",
			input: { command: "bun test packages/x" },
		});
		emit(sock, "tool:result", {
			sessionId: "sess_test",
			tool: "bash",
			output: "Run Command - [PERMISSION DENIED] /etc/passwd",
			durationMs: 5,
		});
		await new Promise((r) => setTimeout(r, 10));
		// Only edits to the one status message, edited in place; zero extra messages so far.
		expect(fetchCalls.filter((c) => c.url.endsWith("/sendMessage")).length).toBe(1);
		for (const e of edits()) {
			expect(e.body.message_id).toBe(101);
			for (const re of BANNED) expect(re.test(e.body.text)).toBe(false);
		}
		expect(edits().pop()?.body.text).toBe("Working on: running a check");
		adapter.close();
	});

	it("rate limits live edits to one per interval", async () => {
		const { adapter, sock } = await startRun({ statusIntervalMs: 100 });
		const kinds = ["read_file", "bash", "edit_file", "grep", "fetch", "read_file", "git"];
		for (const tool of kinds) {
			emit(sock, "tool:start", { sessionId: "sess_test", tool, input: {} });
			emit(sock, "tool:result", { sessionId: "sess_test", tool, output: "ok", durationMs: 1 });
		}
		expect(edits().length).toBe(0);
		await new Promise((r) => setTimeout(r, 160));
		expect(edits().length).toBe(1);
		expect(edits()[0].body.text).toBe("Working on: working with the project history");
		adapter.close();
	});

	it("finish edits to Done, drops Cancel, keeps Show steps, and sends the full reply", async () => {
		const { adapter, sock } = await startRun();
		emit(sock, "agent:stream", {
			sessionId: "sess_test",
			chunk: "Your voice is set to Ava. I also tidied the list.",
			final: true,
		});
		await new Promise((r) => setTimeout(r, 20));
		const last = edits().pop();
		expect(last?.body.text).toBe("Done: Your voice is set to Ava.");
		const row = last?.body.reply_markup.inline_keyboard[0];
		expect(row.map((b: any) => b.text)).toEqual(["Show steps"]);
		const sends = fetchCalls.filter((c) => c.url.endsWith("/sendMessage"));
		expect(sends.length).toBe(2);
		expect(sends[1].body.text).toBe("Your voice is set to Ava. I also tidied the list.");
		adapter.close();
	});

	it("failure edits to Stopped with a plain reason, never the raw error", async () => {
		const { adapter, sock } = await startRun();
		emit(sock, "tool:start", { sessionId: "sess_test", tool: "bash", input: { command: "x" } });
		emit(sock, "agent:error", {
			sessionId: "sess_test",
			error: "Run Command - [PERMISSION DENIED] /Users/x/settings.json",
		});
		await new Promise((r) => setTimeout(r, 20));
		const last = edits().pop();
		expect(last?.body.text).toBe(
			"Stopped: I could not finish because a step needs your OK. Reply yes to allow it.",
		);
		for (const re of BANNED) expect(re.test(last?.body.text)).toBe(false);
		expect(last?.body.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual([
			"Show steps",
		]);
		adapter.close();
	});

	it("a blocked step that the run copes with never shows on the status line", async () => {
		const { adapter, sock } = await startRun({ statusIntervalMs: 0 });
		emit(sock, "tool:start", { sessionId: "sess_test", tool: "bash", input: { command: "x" } });
		emit(sock, "tool:result", {
			sessionId: "sess_test",
			tool: "bash",
			output: "[PERMISSION DENIED]",
			durationMs: 1,
		});
		emit(sock, "agent:stream", {
			sessionId: "sess_test",
			chunk: "Done it another way.",
			final: true,
		});
		await new Promise((r) => setTimeout(r, 20));
		for (const e of edits()) expect(e.body.text).not.toMatch(/denied|blocked|OK/i);
		adapter.close();
	});
});

describe("buttons", () => {
	it("Cancel by the starter uses the abort path and edits to Stopped", async () => {
		const { adapter, sock, runId } = await startRun();
		emit(sock, "tool:start", { sessionId: "sess_test", tool: "read_file", input: {} });
		const res = await adapter.handleRunCallback(CB_PREFIX.runCancel, runId, {
			fromId: 777,
			chatType: "supergroup",
		});
		expect(res.text).toBeUndefined();
		const last = edits().pop();
		expect(last?.body.text).toBe("Stopped. Nothing was left half done.");
		expect(last?.body.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual([
			"Show steps",
		]);
		// The abort path destroys the agent session, as /cancel does.
		expect(sock.sent.some((m) => m.includes("session:destroy"))).toBe(true);
		// The run is over: a new message starts a new run.
		fetchCalls.length = 0;
		await adapter.handleUserMessage("again", "", STARTER);
		expect(fetchCalls.some((c) => String(c.body?.text).includes("Still working"))).toBe(false);
		adapter.close();
	});

	it("Cancel says plainly when a change was in progress", async () => {
		const { adapter, sock, runId } = await startRun();
		emit(sock, "tool:start", { sessionId: "sess_test", tool: "edit_file", input: { path: "a" } });
		await adapter.handleRunCallback(CB_PREFIX.runCancel, runId, { fromId: 777 });
		expect(edits().pop()?.body.text).toContain("may be half done");
		adapter.close();
	});

	it("only the starter may press: anyone else gets the private notice and nothing changes", async () => {
		const { adapter, runId } = await startRun();
		const before = fetchCalls.length;
		const cancel = await adapter.handleRunCallback(CB_PREFIX.runCancel, runId, {
			fromId: 999,
			chatType: "supergroup",
		});
		expect(cancel).toEqual({ text: "Only the person who started this can stop it.", alert: true });
		const steps = await adapter.handleRunCallback(CB_PREFIX.runSteps, runId, {
			fromId: 999,
			chatType: "supergroup",
		});
		expect(steps.alert).toBe(true);
		expect(steps.text).toContain("Only the person who started this");
		expect(fetchCalls.length).toBe(before);
		// The run is still live and the starter can still stop it.
		const ok = await adapter.handleRunCallback(CB_PREFIX.runCancel, runId, { fromId: 777 });
		expect(ok.text).toBeUndefined();
		adapter.close();
	});

	it("an unknown starter is honoured only in a private chat", async () => {
		const { adapter, runId } = await startRun({}, { chatType: "supergroup" } as any);
		const r = await adapter.handleRunCallback(CB_PREFIX.runCancel, runId, {
			fromId: 5,
			chatType: "supergroup",
		});
		expect(r.alert).toBe(true);
		adapter.close();
	});

	it("Show steps sends the full log as one .txt reply to the status message, built locally", async () => {
		const { adapter, sock, runId } = await startRun();
		emit(sock, "tool:start", {
			sessionId: "sess_test",
			tool: "bash",
			input: { command: "bun test" },
		});
		emit(sock, "tool:result", {
			sessionId: "sess_test",
			tool: "bash",
			output: "Run Command - [PERMISSION DENIED]",
			durationMs: 5,
		});
		const res = await adapter.handleRunCallback(CB_PREFIX.runSteps, runId, { fromId: 777 });
		expect(res).toEqual({});
		const docs = fetchCalls.filter((c) => c.url.endsWith("/sendDocument"));
		expect(docs.length).toBe(1);
		const f = docs[0].form!;
		expect(f.docName).toBe(`steps-${runId}.txt`);
		expect(JSON.parse(f.fields.reply_parameters).message_id).toBe(101);
		expect(f.docText).toContain("bun test");
		expect(f.docText).toContain("PERMISSION DENIED");
		expect(f.docText).toContain("sort my voice settings");
		// The status message itself was not edited to carry the trace.
		for (const e of edits()) expect(e.body.text).not.toContain("PERMISSION");
		// Snapshot at press time: a second press sends a fresh file with later steps.
		emit(sock, "tool:start", { sessionId: "sess_test", tool: "grep", input: { query: "later" } });
		await adapter.handleRunCallback(CB_PREFIX.runSteps, runId, { fromId: 777 });
		const docs2 = fetchCalls.filter((c) => c.url.endsWith("/sendDocument"));
		expect(docs2.length).toBe(2);
		expect(docs2[1].form!.docText).toContain("later");
		expect(docs[0].form!.docText).not.toContain("later");
		adapter.close();
	});

	it("Show steps keeps working after finish, then expires after the retention window", async () => {
		const { adapter, sock, runId } = await startRun({ stepsRetentionMs: 60 });
		emit(sock, "tool:start", { sessionId: "sess_test", tool: "read_file", input: {} });
		emit(sock, "agent:stream", { sessionId: "sess_test", chunk: "Done.", final: true });
		await new Promise((r) => setTimeout(r, 15));
		const during = await adapter.handleRunCallback(CB_PREFIX.runSteps, runId, { fromId: 777 });
		expect(during).toEqual({});
		// Cancel on a finished run is a polite no-op.
		const c = await adapter.handleRunCallback(CB_PREFIX.runCancel, runId, { fromId: 777 });
		expect(c.text).toBe("That run has already finished.");
		await new Promise((r) => setTimeout(r, 90));
		const after = await adapter.handleRunCallback(CB_PREFIX.runSteps, runId, { fromId: 777 });
		expect(after.text).toBe("Those steps are no longer available.");
		// Expiry strips Show steps from the message; the task buttons stay.
		const strip = fetchCalls.filter((x) => x.url.endsWith("/editMessageReplyMarkup"));
		expect(strip.length).toBe(1);
		expect(btnTexts(strip[0].body.reply_markup)).toEqual(["▶ Continue", "🆕 New task"]);
		adapter.close();
	});
});

describe("operator Cancel", () => {
	it("an operator may stop a run they did not start; Show steps stays starter-only", async () => {
		const { adapter, runId } = await startRun();
		const steps = await adapter.handleRunCallback(CB_PREFIX.runSteps, runId, {
			fromId: 1,
			operator: true,
		});
		expect(steps.text).toBe("Only the person who started this can see the steps.");
		const res = await adapter.handleRunCallback(CB_PREFIX.runCancel, runId, {
			fromId: 1,
			chatType: "supergroup",
			operator: true,
		});
		expect(res).toEqual({});
		expect(edits().pop()?.body.text).toContain("Stopped.");
		adapter.close();
	});

	it("a non-operator stranger still cannot", async () => {
		const { adapter, runId } = await startRun();
		const res = await adapter.handleRunCallback(CB_PREFIX.runCancel, runId, {
			fromId: 1,
			operator: false,
		});
		expect(res.text).toBe("Only the person who started this can stop it.");
		adapter.close();
	});
});

describe("reasoning never reaches the chat (#5221)", () => {
	it("a final reply with a think block posts only the answer, on every outbound body", async () => {
		const a = await startRun();
		fetchCalls.length = 0;
		emit(a.sock, "agent:stream", {
			sessionId: "sess_test",
			chunk: "<think>SECRET-REASONING</think>The answer is 42.",
			final: true,
		});
		await new Promise((r) => setTimeout(r, 20));
		const all = JSON.stringify(fetchCalls.map((c) => c.body));
		expect(all).not.toContain("SECRET-REASONING");
		expect(all).toContain("The answer is 42.");
		a.adapter.close();
	});
});

describe("finished-message task buttons", () => {
	it("done: Show steps plus Continue and New task, Resend files only when files were sent", async () => {
		const a = await startRun();
		emit(a.sock, "agent:stream", { sessionId: "sess_test", chunk: "All set.", final: true });
		await new Promise((r) => setTimeout(r, 20));
		expect(btnTexts(edits().pop()?.body.reply_markup)).toEqual([
			"Show steps",
			"▶ Continue",
			"🆕 New task",
		]);
		a.adapter.close();

		fetchCalls.length = 0;
		const sock = new FakeSocket();
		const client = new DaemonClient({
			url: "ws://t",
			channel: "telegram",
			socketFactory: () => sock,
		});
		const c = client.connect();
		sock.onopen?.();
		sock.onmessage?.({ data: JSON.stringify({ type: "session:created", sessionId: "sess_test" }) });
		await c;
		const adapter = new TelegramBridgeAdapter({
			telegramToken: "TEST_TOKEN",
			chatId: "CHAT_42",
			daemon: client,
			sessionStore: new SessionStore(),
			fileSender: new FileSender({ token: "TEST_TOKEN", chatId: "CHAT_42" }),
			autoAttachFiles: true,
			statusIntervalMs: 0,
		});
		await adapter.handleUserMessage("make a report", "", STARTER);
		emit(sock, "agent:stream", {
			sessionId: "sess_test",
			chunk: "Report saved. See /nonexistent/dir/report.pdf",
			final: true,
		});
		await new Promise((r) => setTimeout(r, 30));
		const last = edits().pop();
		expect(btnTexts(last?.body.reply_markup)).toEqual([
			"Show steps",
			"▶ Continue",
			"🆕 New task",
			"📎 Resend files",
		]);
		adapter.close();
	});

	it("failed: Show steps plus Retry and Drop", async () => {
		const { adapter, sock } = await startRun();
		emit(sock, "agent:error", { sessionId: "sess_test", error: "boom" });
		await new Promise((r) => setTimeout(r, 20));
		expect(btnTexts(edits().pop()?.body.reply_markup)).toEqual(["Show steps", "↻ Retry", "✕ Drop"]);
		adapter.close();
	});

	it("when Show steps expires the task buttons stay", async () => {
		const { adapter, sock } = await startRun({ stepsRetentionMs: 30 });
		emit(sock, "agent:stream", { sessionId: "sess_test", chunk: "Done.", final: true });
		await new Promise((r) => setTimeout(r, 80));
		const strip = fetchCalls.filter((x) => x.url.endsWith("/editMessageReplyMarkup"));
		expect(btnTexts(strip[0].body.reply_markup)).toEqual(["▶ Continue", "🆕 New task"]);
		adapter.close();
	});
});

describe("Done line outcome filter", () => {
	it("a first sentence with a path or the word tool falls back to plain Done.", async () => {
		expect(doneOutcome("I fixed /tmp/x.ts using the tool. More after.")).toBe("");
		expect(doneOutcome("Your voice is set to Ava. More.")).toBe("Your voice is set to Ava.");
		const { adapter, sock } = await startRun();
		emit(sock, "agent:stream", {
			sessionId: "sess_test",
			chunk: "I fixed /tmp/x.ts using the tool. Then I checked it.",
			final: true,
		});
		await new Promise((r) => setTimeout(r, 20));
		const t = edits().pop()?.body.text;
		expect(t).toBe("Done.");
		for (const re of BANNED) expect(re.test(t)).toBe(false);
		// The full reply still goes out as its own message.
		const sends = fetchCalls.filter((c) => c.url.endsWith("/sendMessage"));
		expect(sends.pop()?.body.text).toContain("/tmp/x.ts");
		adapter.close();
	});
});

describe("status edit rate", () => {
	it("defaults to 5000 ms and two changes 1 s apart make one edit", async () => {
		expect(STATUS_EDIT_INTERVAL_MS).toBe(5000);
		const edited: string[] = [];
		let t = 1_000_000;
		const realNow = Date.now;
		const realSet = globalThis.setTimeout;
		const timers: Array<{ at: number; fn: () => void }> = [];
		Date.now = () => t;
		globalThis.setTimeout = ((fn: () => void, ms: number) => {
			timers.push({ at: t + ms, fn });
			return timers.length as any;
		}) as any;
		try {
			const line = new StatusLine(
				"start",
				STATUS_EDIT_INTERVAL_MS,
				async (s) => void edited.push(s),
			);
			t += 1000;
			line.set("one");
			t += 1000;
			line.set("two");
			expect(edited).toEqual([]);
			t += 3000;
			for (const x of timers.splice(0)) if (x.at <= t) x.fn();
			expect(edited).toEqual(["two"]);
			line.close();
		} finally {
			Date.now = realNow;
			globalThis.setTimeout = realSet;
		}
	});
});

describe("step log redaction", () => {
	const BOT = "123456789:AAEhBOweik6ad9r_QXv45nQSzIuPDwF9wQy";
	const GHP = ["gh", "p_abcdefghijklmnopqrstuvwxyz0123456789"].join("");
	const secrets = [
		BOT,
		["sk", "-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"].join(""),
		"sk-abcdefghijklmnopqrstuvwxyz123456",
		["gh", "p_abcdefghijklmnopqrstuvwxyz0123456789"].join(""),
		["xo", "xb-123456789012-abcdefghijklmnop"].join(""),
		["AK", "IAABCDEFGHIJKLMNOP"].join(""),
		"Bearer abcdefghijklmnopqrstuvwxyz0123",
		"MY_SERVICE_TOKEN=hunter2hunter2",
		"DB_PASSWORD=p4ss",
		["AI", "zaSyA1234567890abcdefghijklmnop"].join(""),
	];
	const mark = (s: string) => s.replace(/^(Bearer |[A-Z_]+=)/, "");
	const needles = secrets.map(mark);

	it("plants every kind in request, command, output and error and none reaches the file", async () => {
		const blob = secrets.join("\n");
		const log = buildStepsLog({
			id: "r1",
			request: `please use ${blob}`,
			startedAt: 1,
			state: "failed",
			steps: [
				{
					at: 2,
					tool: "bash",
					label: `curl https://api.telegram.org/bot${BOT}/getMe ${blob}`,
					changes: true,
					done: true,
					result: `out: ${blob}`,
				},
			],
			error: `failed with ${blob}`,
		});
		for (const n of needles) expect(log).not.toContain(n);
		expect(log).toContain("[REDACTED");
	});

	it("the sent .txt document is redacted end to end", async () => {
		const { adapter, sock, runId } = await startRun();
		emit(sock, "tool:start", {
			sessionId: "sess_test",
			tool: "bash",
			input: { command: `curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123" ${BOT}` },
		});
		emit(sock, "tool:result", {
			sessionId: "sess_test",
			tool: "bash",
			output: `GITHUB_TOKEN=${GHP}`,
			durationMs: 1,
		});
		emit(sock, "agent:error", { sessionId: "sess_test", error: `bad ${BOT}` });
		await new Promise((r) => setTimeout(r, 20));
		await adapter.handleRunCallback(CB_PREFIX.runSteps, runId, { fromId: 777 });
		const doc = fetchCalls.filter((c) => c.url.endsWith("/sendDocument"))[0].form!.docText!;
		for (const n of [BOT, "abcdefghijklmnopqrstuvwxyz0123", GHP.slice(0, 16)]) {
			expect(doc).not.toContain(n);
		}
		adapter.close();
	});
});
