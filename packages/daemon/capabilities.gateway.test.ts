/** The daemon advertises "input-gate" on session frames and /health so clients can gate slash sending. */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentPool, KNOWN_CHANNELS } from "./agent-pool";
import { startGateway } from "./gateway";
import { DAEMON_CAPABILITIES } from "./input-gate";

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
	getAgent() {
		return null;
	}
	getSessionInfo(id: string) {
		return this.live.has(id)
			? { channel: this.live.get(id), messageCount: 0, busy: false, createdAt: 1, lastActiveAt: 2 }
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
	async chat(_sessionId: string, text: string): Promise<string> {
		chatted.push(text);
		return "model reply";
	}
}

type Frame = Record<string, any>;
let server: ReturnType<typeof Bun.serve>;
let dataDir: string;
const savedData = process.env.EIGHT_DATA_DIR;

beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), "caps-gw-"));
	process.env.EIGHT_DATA_DIR = dataDir;
	process.env.DAEMON_HOSTNAME = "127.0.0.1";
	server = startGateway({ port: 0, authToken: null, pool: new StubPool() as unknown as AgentPool });
});

afterAll(() => {
	server.stop(true);
	if (savedData === undefined) Reflect.deleteProperty(process.env, "EIGHT_DATA_DIR");
	else process.env.EIGHT_DATA_DIR = savedData;
	rmSync(dataDir, { recursive: true, force: true });
});

async function open() {
	const frames: Frame[] = [];
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
	ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
	await new Promise((r) => {
		ws.onopen = () => r(null);
	});
	const next = async (type: string) => {
		for (let i = 0; i < 200; i++) {
			const f = frames.find((x) => x.type === type);
			if (f) return f;
			await new Promise((r) => setTimeout(r, 10));
		}
		throw new Error(`no ${type}: ${JSON.stringify(frames)}`);
	};
	let seen = 0;
	const nextEvent = async () => {
		for (let i = 0; i < 200; i++) {
			const hits = frames.filter((x) => x.type === "event" && x.event === "agent:stream");
			if (hits.length > seen) {
				seen++;
				return hits[seen - 1];
			}
			await new Promise((r) => setTimeout(r, 10));
		}
		throw new Error(`no stream event: ${JSON.stringify(frames)}`);
	};
	return { ws, next, nextEvent };
}

describe("daemon capabilities", () => {
	it("the constant includes input-gate", () => {
		expect(DAEMON_CAPABILITIES).toContain("input-gate");
	});

	it("session:created carries capabilities", async () => {
		const s = await open();
		s.ws.send(JSON.stringify({ type: "session:create", channel: "browser" }));
		const f = await s.next("session:created");
		expect(f.capabilities).toEqual([...DAEMON_CAPABILITIES]);
		s.ws.close();
	});

	it("session:resumed carries capabilities", async () => {
		const a = await open();
		a.ws.send(JSON.stringify({ type: "session:create", channel: "browser" }));
		const created = await a.next("session:created");
		const b = await open();
		b.ws.send(
			JSON.stringify({
				type: "session:resume",
				sessionId: created.sessionId,
				resumeSecret: created.resumeSecret,
				channel: "browser",
			}),
		);
		const f = await b.next("session:resumed");
		expect(f.capabilities).toEqual([...DAEMON_CAPABILITIES]);
		a.ws.close();
		b.ws.close();
	});

	it("/health carries capabilities", async () => {
		const body = (await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()) as Frame;
		expect(body.capabilities).toEqual([...DAEMON_CAPABILITIES]);
	});

	it("every channel that advertises input-gate gates /status and an unknown slash before the model", async () => {
		const checked: string[] = [];
		for (const channel of KNOWN_CHANNELS) {
			chatted.length = 0;
			const s = await open();
			s.ws.send(JSON.stringify({ type: "session:create", channel }));
			const created = await s.next("session:created");
			if (!created.capabilities?.includes("input-gate")) {
				s.ws.close();
				continue;
			}
			for (const text of ["/status", "/nosuchthing"]) {
				s.ws.send(JSON.stringify({ type: "prompt", text }));
				await s.nextEvent();
			}
			expect(chatted).toEqual([]);
			checked.push(channel);
			s.ws.close();
		}
		expect(checked).toEqual([...KNOWN_CHANNELS]);
	});
});
