/** #4530: session.message passes the shared input gate before Agent.chat. Spy-order test, as agent-pool-gate. */

import { afterEach, describe, expect, test } from "bun:test";
import { setClassifyObserver } from "../daemon/input-gate";
import { handleLine, sessions } from "./rpc-server";

const order: string[] = [];
const out: any[] = [];
const realWrite = process.stdout.write.bind(process.stdout);

function setup(id: string) {
	order.length = 0;
	out.length = 0;
	const reached: string[] = [];
	// biome-ignore lint/suspicious/noExplicitAny: fake Agent
	const agent: any = {
		async chat(t: string) {
			reached.push(t);
			order.push("model");
			return `model:${t}`;
		},
	};
	sessions.set(id, { agent, id });
	setClassifyObserver((_t, _c, r) => order.push(`classify:${r.kind}`));
	process.stdout.write = ((s: string) => {
		out.push(JSON.parse(s));
		return true;
	}) as typeof process.stdout.write;
	return reached;
}
afterEach(() => {
	process.stdout.write = realWrite;
	setClassifyObserver();
	sessions.clear();
});

async function send(id: string, content: string) {
	await handleLine(
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "session.message",
			params: { sessionId: id, content },
		}),
	);
}

describe("rpc session.message gate", () => {
	test("a known slash line is answered locally and never reaches the model", async () => {
		const reached = setup("r1");
		await send("r1", "/status");
		expect(reached).toEqual([]);
		expect(order).toEqual(["classify:slash"]);
		expect(out[0].result.response).toContain("channel rpc");
	});
	test("a blocked (unknown) slash line is refused with the gate message and never reaches the model", async () => {
		const reached = setup("r2");
		await send("r2", "/nosuchthing now");
		expect(reached).toEqual([]);
		expect(out[0].result.response).toBe("Unknown command /nosuchthing. Type /help.");
	});
	test("plain text reaches the model, classified first", async () => {
		const reached = setup("r3");
		await send("r3", "hello");
		expect(reached).toEqual(["hello"]);
		expect(order).toEqual(["classify:pass", "model"]);
		expect(out.find((m) => m.result)?.result.response).toBe("model:hello");
	});
	test("non-string or blank content is rejected and never reaches the model", async () => {
		const reached = setup("r4");
		for (const content of [["/status"], { a: 1 }, 5, "   "]) {
			out.length = 0;
			await handleLine(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "session.message",
					params: { sessionId: "r4", content },
				}),
			);
			expect(out[0].error.code).toBe(-32602);
		}
		expect(reached).toEqual([]);
	});
	test("session.create rejects a bad systemPrompt before any Agent is built", async () => {
		setup("r5");
		for (const systemPrompt of [["x"], 5, "/status", "  /nosuchthing", "a\0b", "x".repeat(65537)]) {
			out.length = 0;
			await handleLine(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "session.create",
					params: { systemPrompt },
				}),
			);
			expect(out[0].error.code).toBe(-32602);
		}
		expect(sessions.size).toBe(1);
	});
});
