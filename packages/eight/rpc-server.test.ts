/**
 * Behaviour tests for the JSON-RPC server (#3918 N3) and the SDK (F6).
 * They start the real program (`bun bin/8gent.ts --rpc`) and talk to it over
 * a stdin/stdout pipe. The model is a stub server: the CI one
 * (scripts/ci/stub-model-server.ts) for the plain path, and a slow copy of its
 * protocol for the tests that need a turn to still be running when a second
 * request arrives.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const BASE = mkdtempSync(join(tmpdir(), "rpc-test-"));
const HOME = join(BASE, "home");
const DATA = join(BASE, "data");
const WORK = join(BASE, "work");

type Msg = {
	id?: number | string;
	method?: string;
	params?: Record<string, any>;
	result?: any;
	error?: { code: number; message: string };
};

// ── stubs ─────────────────────────────────────────────────────────

/** Same wire protocol as scripts/ci/stub-model-server.ts, but slow and recording. */
function slowStub(delayMs: number) {
	const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname.endsWith("/models")) {
				return Response.json({ object: "list", data: [{ id: "stub", object: "model" }] });
			}
			if (!url.pathname.endsWith("/chat/completions")) return new Response("nope", { status: 404 });
			const body = (await req.json()) as { stream?: boolean; messages: any[] };
			requests.push({ messages: body.messages });
			const seenAssistant = body.messages.some((m) => m.role === "assistant");
			await new Promise((r) => setTimeout(r, delayMs));
			const content = seenAssistant
				? "DONE: wrote slow.txt"
				: "```tool_call\n" +
					JSON.stringify({ name: "write_file", arguments: { path: "slow.txt", content: "slow" } }) +
					"\n```";
			if (body.stream) {
				const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
				return new Response(
					frame({ id: "s", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }) +
						frame({ id: "s", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
						"data: [DONE]\n\n",
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			return Response.json({
				id: "s",
				object: "chat.completion",
				model: "stub",
				choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	return { server, requests, url: `http://127.0.0.1:${server.port}` };
}

// ── RPC client over the pipe ──────────────────────────────────────

class Rpc {
	private proc: ReturnType<typeof Bun.spawn>;
	private nextId = 1;
	private waiting = new Map<number, (m: Msg) => void>();
	readonly notifications: Msg[] = [];
	private onNotify: Array<() => void> = [];

	constructor(ollamaHost: string) {
		this.proc = Bun.spawn(["bun", join(ROOT, "bin/8gent.ts"), "--rpc"], {
			cwd: ROOT,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME,
				EIGHT_DATA_DIR: DATA,
				OLLAMA_HOST: ollamaHost,
				EIGHT_DECIDE_OLLAMA_HOST: "http://127.0.0.1:9",
			},
		});
		void this.read();
		// Drain stderr so the child never blocks on a full pipe.
		void new Response(this.proc.stderr as ReadableStream).text();
	}

	private async read() {
		const dec = new TextDecoder();
		let buf = "";
		const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
		for (;;) {
			const { value: chunk, done } = await reader.read();
			if (done || !chunk) break;
			buf += dec.decode(chunk, { stream: true });
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
				if (!line) continue;
				let m: Msg;
				try {
					m = JSON.parse(line);
				} catch {
					continue;
				}
				if (m.id != null && this.waiting.has(m.id as number)) {
					this.waiting.get(m.id as number)?.(m);
					this.waiting.delete(m.id as number);
				} else {
					this.notifications.push(m);
					for (const f of this.onNotify) f();
				}
			}
		}
	}

	/** Send a request; resolves with the whole response (result or error). */
	call(method: string, params: Record<string, unknown> = {}): Promise<Msg> {
		const id = this.nextId++;
		const p = new Promise<Msg>((res) => this.waiting.set(id, res));
		(this.proc.stdin as any).write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		(this.proc.stdin as any).flush?.();
		return p;
	}

	async ok(method: string, params: Record<string, unknown> = {}): Promise<any> {
		const r = await this.call(method, params);
		if (r.error) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
		return r.result;
	}

	waitFor(pred: () => boolean, ms = 20000): Promise<void> {
		return new Promise((res, rej) => {
			const t = setTimeout(() => rej(new Error("timeout waiting for condition")), ms);
			const check = () => {
				if (pred()) {
					clearTimeout(t);
					res();
				}
			};
			this.onNotify.push(check);
			check();
		});
	}

	methods(name: string): Msg[] {
		return this.notifications.filter((n) => n.method === name);
	}

	close() {
		try {
			(this.proc.stdin as any).end();
		} catch {}
		setTimeout(() => this.proc.kill(), 3000).unref?.();
	}
}

async function until(pred: () => boolean, ms = 15000) {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 25));
	}
}

beforeAll(() => {
	Bun.spawnSync(["mkdir", "-p", HOME, DATA, WORK]);
});
afterAll(() => {
	rmSync(BASE, { recursive: true, force: true });
});

// ── tests ─────────────────────────────────────────────────────────

describe("rpc-server over a pipe, CI stub model", () => {
	let stubProc: ReturnType<typeof Bun.spawn>;
	let rpc: Rpc;
	const port = 20000 + Math.floor(Math.random() * 20000);

	beforeAll(async () => {
		stubProc = Bun.spawn(["bun", join(ROOT, "scripts/ci/stub-model-server.ts"), String(port)], {
			env: { ...process.env, STUB_TARGET_FILE: "hello.txt", STUB_TARGET_CONTENT: "hi from rpc" },
			stdout: "ignore",
			stderr: "ignore",
		});
		await until(() => {
			try {
				return Bun.spawnSync(["curl", "-sf", `http://127.0.0.1:${port}/v1/models`]).exitCode === 0;
			} catch {
				return false;
			}
		});
		rpc = new Rpc(`http://127.0.0.1:${port}`);
	});
	afterAll(() => {
		rpc.close();
		stubProc.kill();
	});

	test("the original five methods still work", async () => {
		const tools = await rpc.ok("tools.list");
		expect(tools.tools.length).toBeGreaterThan(5);
		const { sessionId } = await rpc.ok("session.create", { model: "stub", cwd: WORK });
		expect(sessionId).toMatch(/^rpc_/);
		const r = await rpc.ok("session.message", { sessionId, content: "Create hello.txt" });
		expect(r.response).toContain("wrote hello.txt");
		expect(readFileSync(join(WORK, "hello.txt"), "utf8")).toBe("hi from rpc");
		expect(rpc.methods("stream.toolCall").some((n) => n.params?.tool === "write_file")).toBe(true);
		expect(rpc.methods("stream.done").length).toBeGreaterThan(0);
		expect(await rpc.ok("session.abort", { sessionId })).toEqual({ ok: true });
		expect(await rpc.ok("session.destroy", { sessionId })).toEqual({ ok: true });
		const gone = await rpc.call("session.getState", { sessionId });
		expect(gone.error?.code).toBe(-32602);
	}, 60000);

	test("an unknown method is -32601", async () => {
		const r = await rpc.call("session.nope", {});
		expect(r.error?.code).toBe(-32601);
	});

	test("getState, getMessages, getLastAssistantText, setModel, list, fork", async () => {
		const { sessionId } = await rpc.ok("session.create", { model: "stub", cwd: WORK });
		let st = await rpc.ok("session.getState", { sessionId });
		expect(st).toMatchObject({ sessionId, model: "stub", provider: "ollama", busy: false, queueLength: 0 });
		expect(await rpc.ok("session.getLastAssistantText", { sessionId })).toEqual({ text: null });

		await rpc.ok("session.message", { sessionId, content: "Create hello.txt" });
		const last = await rpc.ok("session.getLastAssistantText", { sessionId });
		expect(last.text).toContain("wrote hello.txt");
		const { messages } = await rpc.ok("session.getMessages", { sessionId });
		expect(messages[0]).toMatchObject({ role: "user" });
		expect(messages.some((m: any) => m.role === "system")).toBe(false);

		const sm = await rpc.ok("session.setModel", { sessionId, model: "stub-2" });
		expect(sm).toEqual({ model: "stub-2", provider: "ollama" });
		st = await rpc.ok("session.getState", { sessionId });
		expect(st.model).toBe("stub-2");
		const bad = await rpc.call("session.setModel", { sessionId, model: "openrouter:auto" });
		expect(bad.error?.code).toBe(-32602);

		// session.list reads the store the session wrote into the temp data dir.
		const { sessions } = await rpc.ok("session.list", {});
		const mine = sessions.find((s: any) => s.id === sessionId);
		expect(mine).toBeTruthy();
		expect(mine.messageCount).toBe(messages.length);
		expect(mine.file.startsWith(DATA)).toBe(true);

		// session.fork makes a new, live session with the same conversation.
		const before = readdirSync(join(DATA, "sessions", "tree")).length;
		const fork = await rpc.ok("session.fork", { sessionId, name: "branch" });
		expect(fork.sessionId).not.toBe(sessionId);
		expect(fork.parentSessionId).toBe(sessionId);
		expect(fork.messageCount).toBe(messages.length);
		expect(readdirSync(join(DATA, "sessions", "tree")).length).toBe(before + 1);
		expect(existsSync(join(DATA, "sessions", "tree", `${fork.sessionId}.jsonl`))).toBe(true);
		const forked = (await rpc.ok("session.getMessages", { sessionId: fork.sessionId })).messages;
		expect(forked).toEqual(messages);
		const listed = (await rpc.ok("session.list", {})).sessions.find((s: any) => s.id === fork.sessionId);
		expect(listed.parentSession.id).toBe(sessionId);
		// The fork is its own session: a turn on it does not touch the parent.
		await rpc.ok("session.message", { sessionId: fork.sessionId, content: "again" });
		expect((await rpc.ok("session.getMessages", { sessionId })).messages.length).toBe(messages.length);
		expect((await rpc.ok("session.getMessages", { sessionId: fork.sessionId })).messages.length).toBeGreaterThan(
			messages.length,
		);
	}, 90000);

	test("compact says it is unsupported instead of pretending", async () => {
		const { sessionId } = await rpc.ok("session.create", { model: "stub", cwd: WORK });
		const r = await rpc.call("session.compact", { sessionId });
		expect(r.error?.code).toBe(-32001);
	});
});

describe("rpc-server, a turn that is still running", () => {
	test("steer lands after the current tool call; getState shows busy and queue; follow-up runs after", async () => {
		const stub = slowStub(700);
		const rpc = new Rpc(stub.url);
		try {
			const { sessionId } = await rpc.ok("session.create", { model: "stub", cwd: WORK });
			const turn = rpc.call("session.prompt", { sessionId, content: "Create slow.txt" });
			await until(() => stub.requests.length === 1); // the first model call is in flight

			let st = await rpc.ok("session.getState", { sessionId });
			expect(st.busy).toBe(true);
			expect(st.queueLength).toBe(0);

			// A second turn on a busy session is refused, not interleaved.
			const refused = await rpc.call("session.message", { sessionId, content: "x" });
			expect(refused.error?.code).toBe(-32000);

			expect(await rpc.ok("session.steer", { sessionId, content: "STEER-MARKER use two spaces" })).toMatchObject({
				queued: true,
				busy: true,
				queueLength: 1,
			});
			expect(await rpc.ok("session.followUp", { sessionId, content: "FOLLOWUP-MARKER thanks" })).toMatchObject({
				queued: true,
				queueLength: 2,
			});
			st = await rpc.ok("session.getState", { sessionId });
			expect(st).toMatchObject({ busy: true, steerQueue: 1, followUpQueue: 1, queueLength: 2 });

			const done = await turn;
			expect(done.error).toBeUndefined();
			expect(readFileSync(join(WORK, "slow.txt"), "utf8")).toBe("slow");

			// Request 2 is the model call after the tool ran: it carries the steer,
			// and the steer comes after the tool result in the conversation.
			const second = stub.requests[1].messages.map((m) => `${m.role}:${JSON.stringify(m.content)}`);
			const steerAt = second.findIndex((m) => m.includes("STEER-MARKER"));
			const toolAt = second.findIndex((m) => m.includes("slow.txt") && !m.includes("STEER-MARKER") && !m.startsWith("system"));
			expect(steerAt).toBeGreaterThan(-1);
			expect(toolAt).toBeGreaterThan(-1);
			expect(steerAt).toBeGreaterThan(toolAt);
			expect(rpc.methods("stream.steer").map((n) => n.params?.text)).toEqual(["STEER-MARKER use two spaces"]);

			// The follow-up ran as its own turn after the first one ended.
			expect(rpc.methods("stream.followUp").map((n) => n.params?.text)).toEqual(["FOLLOWUP-MARKER thanks"]);
			const all = JSON.stringify(stub.requests[stub.requests.length - 1].messages);
			expect(all).toContain("FOLLOWUP-MARKER");

			st = await rpc.ok("session.getState", { sessionId });
			expect(st).toMatchObject({ busy: false, queueLength: 0 });
		} finally {
			rpc.close();
			stub.server.stop(true);
		}
	}, 60000);

	test("abort stops the turn, drops follow-ups, and the session is idle again", async () => {
		const stub = slowStub(1500);
		const rpc = new Rpc(stub.url);
		try {
			const { sessionId } = await rpc.ok("session.create", { model: "stub", cwd: WORK });
			const turn = rpc.call("session.prompt", { sessionId, content: "Create slow.txt" });
			await until(() => stub.requests.length === 1);
			await rpc.ok("session.followUp", { sessionId, content: "never runs" });
			await rpc.ok("session.abort", { sessionId });
			await turn;
			const st = await rpc.ok("session.getState", { sessionId });
			expect(st).toMatchObject({ busy: false, followUpQueue: 0 });
			expect(JSON.stringify(stub.requests)).not.toContain("never runs");
		} finally {
			rpc.close();
			stub.server.stop(true);
		}
	}, 60000);
});
