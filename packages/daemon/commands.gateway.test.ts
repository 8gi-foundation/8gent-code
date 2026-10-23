/** The daemon advertises the slash names its gate accepts, so clients need no local copy. */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_SLASH_COMMANDS } from "../../apps/tui/src/lib/slash-commands";
import type { AgentPool } from "./agent-pool";
import { startGateway } from "./gateway";
import { daemonCommands, isAcceptedSlashName } from "./input-gate";

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
}

type Frame = Record<string, any>;
let server: ReturnType<typeof Bun.serve>;
let dataDir: string;
const savedData = process.env.EIGHT_DATA_DIR;

beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), "cmds-gw-"));
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
	return { ws, next };
}

describe("daemon commands", () => {
	it("the list equals the registry's accepted names, sorted and unique", () => {
		const expected = [
			...new Set(BUILT_IN_SLASH_COMMANDS.flatMap((c) => [c.name, ...c.aliases])),
		].sort();
		expect(daemonCommands()).toEqual(expected);
		expect(daemonCommands().length).toBeGreaterThan(0);
	});

	it("a listed name is accepted, a made-up name is not", () => {
		for (const n of daemonCommands()) expect(isAcceptedSlashName(n)).toBe(true);
		expect(isAcceptedSlashName("nosuchthing")).toBe(false);
	});

	it("session:created carries commands", async () => {
		const s = await open();
		s.ws.send(JSON.stringify({ type: "session:create", channel: "browser" }));
		expect((await s.next("session:created")).commands).toEqual(daemonCommands());
		s.ws.close();
	});

	it("session:resumed carries commands", async () => {
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
		expect((await b.next("session:resumed")).commands).toEqual(daemonCommands());
		a.ws.close();
		b.ws.close();
	});

	it("/health carries commands", async () => {
		const body = (await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()) as Frame;
		expect(body.commands).toEqual(daemonCommands());
	});
});
