/** #4530: every channel's prompt passes the input gate; a plain prompt still reaches the model. */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentPool, KNOWN_CHANNELS } from "./agent-pool";
import { bus } from "./events";
import { startGateway } from "./gateway";

const chatted: string[] = [];

class StubPool {
	live = new Map<string, string>();
	get size() {
		return this.live.size;
	}
	createSession(id: string, channel: string) {
		this.live.set(id, channel);
	}
	hasSession(id: string) {
		return this.live.has(id);
	}
	destroySession(id: string) {
		this.live.delete(id);
	}
	getAgent(id: string) {
		return this.live.has(id) ? { getModel: () => "stub-model", getRuntime: () => "stub-rt" } : null;
	}
	getSessionInfo(id: string) {
		return this.live.has(id)
			? { channel: this.live.get(id), messageCount: 7, busy: false, createdAt: 1, lastActiveAt: 2 }
			: null;
	}
	getActiveSessions() {
		return [];
	}
	getStatus() {
		return {};
	}
	canCreate() {
		return true;
	}
	abort() {
		return false;
	}
	async chat(sessionId: string, text: string): Promise<string> {
		chatted.push(text);
		bus.emit("agent:stream", { sessionId, chunk: "model reply", final: true });
		return "model reply";
	}
}

type Frame = Record<string, any>;
const pool = new StubPool();
let server: ReturnType<typeof Bun.serve>;
let dataDir: string;
const savedData = process.env.EIGHT_DATA_DIR;

beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), "slash-gw-"));
	process.env.EIGHT_DATA_DIR = dataDir;
	process.env.DAEMON_HOSTNAME = "127.0.0.1";
	server = startGateway({ port: 0, authToken: null, pool: pool as unknown as AgentPool });
});

afterAll(() => {
	server.stop(true);
	if (savedData === undefined) Reflect.deleteProperty(process.env, "EIGHT_DATA_DIR");
	else process.env.EIGHT_DATA_DIR = savedData;
	rmSync(dataDir, { recursive: true, force: true });
});

async function session(channel: string) {
	const frames: Frame[] = [];
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
	ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
	await new Promise((r) => {
		ws.onopen = () => r(null);
	});
	ws.send(JSON.stringify({ type: "session:create", channel }));
	const next = async (pred: (f: Frame) => boolean) => {
		for (let i = 0; i < 200; i++) {
			const f = frames.find(pred);
			if (f) return f;
			await new Promise((r) => setTimeout(r, 10));
		}
		throw new Error(`no frame: ${JSON.stringify(frames)}`);
	};
	await next((f) => f.type === "session:created");
	return { ws, next, frames };
}

const streamed = (f: Frame) => f.type === "event" && f.event === "agent:stream";

describe("gateway input gate", () => {
	it("browser channel: /status is answered by the daemon, the model never sees it", async () => {
		chatted.length = 0;
		const s = await session("browser");
		s.ws.send(JSON.stringify({ type: "prompt", text: "/status" }));
		const f = await s.next(streamed);
		expect(f.payload.chunk).toContain("7 messages");
		expect(chatted).toEqual([]);
		s.ws.close();
	});

	it("browser channel: a plain prompt still reaches the model", async () => {
		chatted.length = 0;
		const s = await session("browser");
		s.ws.send(JSON.stringify({ type: "prompt", text: "what is 2+2" }));
		const f = await s.next(streamed);
		expect(f.payload.chunk).toBe("model reply");
		expect(chatted).toEqual(["what is 2+2"]);
		s.ws.close();
	});

	it("browser channel: an unknown slash name falls through to the model", async () => {
		chatted.length = 0;
		const s = await session("browser");
		s.ws.send(JSON.stringify({ type: "prompt", text: "/nosuchthing hi" }));
		await s.next(streamed);
		expect(chatted).toEqual(["/nosuchthing hi"]);
		s.ws.close();
	});

	it("every channel in the protocol enum passes the gate: /status never reaches the model", async () => {
		const reached: string[] = [];
		for (const channel of KNOWN_CHANNELS) {
			chatted.length = 0;
			const s = await session(channel);
			s.ws.send(JSON.stringify({ type: "prompt", text: "/status" }));
			const f = await s.next(streamed);
			expect(f.payload.chunk).toContain("7 messages");
			expect(chatted).toEqual([]);
			reached.push(channel);
			s.ws.close();
		}
		expect(reached).toEqual([...KNOWN_CHANNELS]);
	});

	it("the gateway has exactly one model call for a prompt frame, behind gateInput", () => {
		const src = readFileSync(join(import.meta.dir, "gateway.ts"), "utf8");
		expect(src.match(/\.chat\(sid, msg\.text/g)?.length).toBe(1);
		expect(src.indexOf("gateInput(")).toBeGreaterThan(0);
		expect(src.indexOf("gateInput(")).toBeLessThan(src.indexOf("runModelTurn();\n"));
	});
});
