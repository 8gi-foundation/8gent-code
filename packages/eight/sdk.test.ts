/**
 * SDK behaviour (#3918 F6): createSession drives the real Agent against a stub
 * model server that speaks the same protocol as scripts/ci/stub-model-server.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusyError, UnsupportedError, createSession, listSessions, type SessionEvent } from "./sdk";

const BASE = mkdtempSync(join(tmpdir(), "sdk-test-"));
const WORK = join(BASE, "work");
const SESSIONS = join(BASE, "sessions");
const requests: Array<Array<{ role: string; content: unknown }>> = [];
let server: ReturnType<typeof Bun.serve>;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
	Bun.spawnSync(["mkdir", "-p", WORK, join(BASE, "home")]);
	for (const k of ["HOME", "OLLAMA_HOST"]) saved[k] = process.env[k];
	process.env.HOME = join(BASE, "home");
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname.endsWith("/models")) {
				return Response.json({ object: "list", data: [{ id: "stub", object: "model" }] });
			}
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
			const body = (await req.json()) as { stream?: boolean; messages: any[] };
			requests.push(body.messages);
			await new Promise((r) => setTimeout(r, 300));
			const seen = body.messages.some((m) => m.role === "assistant");
			const content = seen
				? "DONE: all done"
				: "```tool_call\n" +
					JSON.stringify({ name: "write_file", arguments: { path: "sdk.txt", content: "sdk" } }) +
					"\n```";
			const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
			return new Response(
				frame({ id: "s", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }) +
					frame({ id: "s", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
					"data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
	server.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(BASE, { recursive: true, force: true });
});

describe("sdk", () => {
	test("prompt returns the final text, subscribe sees tool events, fork and dispose work", async () => {
		const s = createSession({ model: "stub", cwd: WORK, sessionsDir: SESSIONS });
		const events: SessionEvent[] = [];
		const off = s.subscribe((e) => events.push(e));

		const text = await s.prompt("Create sdk.txt");
		expect(text).toContain("all done");
		expect(readFileSync(join(WORK, "sdk.txt"), "utf8")).toBe("sdk");
		expect(events.map((e) => e.type)).toContain("tool_start");
		expect(events.some((e) => e.type === "tool_end" && e.tool === "write_file")).toBe(true);
		expect(events[events.length - 1]).toEqual({ type: "done" });
		expect(s.getState()).toMatchObject({ busy: false, queueLength: 0, persisted: true });
		expect(s.getLastAssistantText()).toContain("all done");

		off();
		const before = events.length;
		const child = s.fork({ name: "b" });
		expect(child.id).not.toBe(s.id);
		expect(child.getMessages()).toEqual(s.getMessages());
		expect(listSessions({ sessionsDir: SESSIONS }).find((x) => x.id === child.id)?.parentSession?.id).toBe(s.id);
		expect(events.length).toBe(before); // unsubscribed

		expect(() => s.compact()).toThrow(UnsupportedError);
		await child.dispose();
		await s.dispose();
		await s.dispose(); // idempotent
		await expect(s.prompt("again")).rejects.toThrow("disposed");
	}, 60000);

	test("steer reaches the model after the running tool call; a second prompt while busy is refused", async () => {
		requests.length = 0;
		const s = createSession({ model: "stub", cwd: WORK, persist: false });
		const run = s.prompt("Create sdk.txt");
		while (requests.length < 1) await new Promise((r) => setTimeout(r, 10));
		expect(s.getState().busy).toBe(true);
		expect(s.steer("SDK-STEER")).toBe(true);
		expect(s.steer("   ")).toBe(false);
		expect(s.getState().queueLength).toBe(1);
		await expect(s.turn("x")).rejects.toBeInstanceOf(BusyError);
		await run;
		expect(JSON.stringify(requests[1])).toContain("SDK-STEER");
		expect(s.getState()).toMatchObject({ busy: false, queueLength: 0, persisted: false });
		expect(() => s.fork()).toThrow(UnsupportedError);
		await s.dispose();
	}, 60000);
});
