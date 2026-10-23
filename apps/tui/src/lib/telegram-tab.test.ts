/**
 * #4834: `/sessions attach home` opens one dedicated Telegram tab. Real gateway, real
 * sockets; the host is a fake set of tabs so the test can see exactly what was touched.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPool } from "../../../../packages/daemon/agent-pool";
import { bridgeSecret } from "../../../../packages/daemon/channel-approvals";
import { bus } from "../../../../packages/daemon/events";
import { startGateway } from "../../../../packages/daemon/gateway";
import { ensureTokenFile } from "../../../../packages/daemon/local-link";
import { DaemonSessionClient } from "./daemon-sessions";
import {
	TELEGRAM_TAB_DATA_KEY,
	type TabMsg,
	TelegramTab,
	type TelegramTabHost,
	telegramTabTitle,
} from "./telegram-tab";

class Agent {
	history: Array<{ role: string; content: string }> = [{ role: "system", content: "sys" }];
	getMessageHistory() {
		return [...this.history];
	}
	restoreFromCheckpoint() {}
	abort() {}
	getWorkingDirectory() {
		return "/work";
	}
}
class Pool {
	live = new Map<string, { channel: string; agent: Agent }>();
	get size() {
		return this.live.size;
	}
	createSession(id: string, channel: string) {
		this.live.set(id, { channel, agent: new Agent() });
	}
	hasSession(id: string) {
		return this.live.has(id);
	}
	destroySession(id: string) {
		this.live.delete(id);
	}
	getAgent(id: string) {
		return this.live.get(id)?.agent ?? null;
	}
	getSessionInfo(id: string) {
		const e = this.live.get(id);
		return e
			? { channel: e.channel, messageCount: 0, busy: false, createdAt: 1, lastActiveAt: 2 }
			: null;
	}
	getActiveSessions() {
		return [...this.live].map(([sessionId, e]) => ({ sessionId, channel: e.channel }));
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
	async chat(sessionId: string, text: string) {
		bus.emit("agent:stream", { sessionId, chunk: `echo: ${text}`, final: true });
		return "ok";
	}
}

/** The TUI's tabs, as plain data. */
class FakeTabs implements TelegramTabHost {
	tabs = new Map<string, { title: string; messages: TabMsg[]; data: Record<string, unknown> }>();
	active = "";
	notes: string[] = [];
	added = 0;
	limit = 20;
	private n = 0;
	constructor(initial: Record<string, string[]>) {
		for (const [id, lines] of Object.entries(initial)) {
			this.tabs.set(id, {
				title: id,
				data: {},
				messages: lines.map((content, i) => ({
					id: `${id}-${i}`,
					role: "user" as const,
					content,
					timestamp: new Date(0),
				})),
			});
			this.active ||= id;
		}
	}
	addTab(title: string, data: Record<string, unknown>) {
		if (this.tabs.size >= this.limit) return null;
		this.added++;
		const id = `tab-new-${this.n++}`;
		this.tabs.set(id, { title, data, messages: [] });
		this.active = id;
		return { id };
	}
	hasTab(id: string) {
		return this.tabs.has(id);
	}
	switchTab(id: string) {
		this.active = id;
	}
	renameTab(id: string, title: string) {
		const t = this.tabs.get(id);
		if (t) t.title = title;
	}
	setMessages(id: string, messages: TabMsg[]) {
		const t = this.tabs.get(id);
		if (t) t.messages = messages;
	}
	append(id: string, message: TabMsg) {
		this.tabs.get(id)?.messages.push(message);
	}
	notify(text: string) {
		this.notes.push(text);
	}
	removeTab(id: string) {
		this.tabs.delete(id);
	}
	/** A deep snapshot of every tab except `except`. */
	snapshot(except?: string) {
		return JSON.stringify(
			[...this.tabs].filter(([id]) => id !== except).map(([id, t]) => [id, t.title, t.messages]),
		);
	}
}

let root: string;
const saved = {
	data: process.env.EIGHT_DATA_DIR,
	host: process.env.DAEMON_HOSTNAME,
	url: process.env.EIGHT_DAEMON_URL,
	tok: process.env.EIGHT_DAEMON_TOKEN,
};
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const sockets: WebSocket[] = [];
const controllers: TelegramTab[] = [];

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "tg-tab-"));
	process.env.EIGHT_DATA_DIR = join(root, "sessions-data");
	process.env.DAEMON_HOSTNAME = "127.0.0.1";
	Reflect.deleteProperty(process.env, "EIGHT_DAEMON_URL");
	Reflect.deleteProperty(process.env, "EIGHT_DAEMON_TOKEN");
});
afterEach(() => {
	for (const c of controllers.splice(0)) c.dispose();
	for (const s of sockets.splice(0)) s.close();
	for (const s of servers.splice(0)) s.stop(true);
});
afterAll(() => {
	for (const [k, v] of [
		["EIGHT_DATA_DIR", saved.data],
		["DAEMON_HOSTNAME", saved.host],
		["EIGHT_DAEMON_URL", saved.url],
		["EIGHT_DAEMON_TOKEN", saved.tok],
	] as const) {
		if (v === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = v;
	}
	rmSync(root, { recursive: true, force: true });
});

function daemon(dir: string, port = 0) {
	mkdirSync(dir, { recursive: true });
	const operatorToken = ensureTokenFile(dir);
	const pool = new Pool();
	const server = startGateway({
		port,
		authToken: null,
		operatorToken,
		pool: pool as unknown as AgentPool,
	});
	servers.push(server);
	return { server, pool, url: `ws://127.0.0.1:${server.port}`, dir };
}

async function bridge(url: string) {
	const ws = new WebSocket(url);
	sockets.push(ws);
	const frames: Array<Record<string, unknown>> = [];
	ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
	await new Promise<void>((r) => {
		ws.onopen = () => r();
	});
	ws.send(JSON.stringify({ type: "approvals:register", secret: bridgeSecret() }));
	ws.send(JSON.stringify({ type: "session:create", channel: "telegram" }));
	let created: Record<string, unknown> | undefined;
	for (let i = 0; i < 200 && !created; i++) {
		created = frames.find((f) => f.type === "session:created");
		if (!created) await new Promise((r) => setTimeout(r, 10));
	}
	ws.send(JSON.stringify({ type: "home:declare" }));
	return { ws, frames, sessionId: String(created?.sessionId) };
}

const wait = async (ok: () => boolean, ms = 3000) => {
	const t = Date.now();
	while (!ok()) {
		if (Date.now() - t > ms) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 15));
	}
};

function controller(host: FakeTabs, d: { url: string; dir: string }, retry = [20, 20, 40]) {
	const c = new TelegramTab(host, () =>
		DaemonSessionClient.connectHome({ retryDelaysMs: retry }, [{ url: d.url, dir: d.dir }]),
	);
	controllers.push(c);
	return c;
}

describe("attach home opens a dedicated Telegram tab", () => {
	it("opens one tab, labelled by state, and never touches another tab's messages", async () => {
		const d = daemon(join(root, "d1"));
		const br = await bridge(d.url);
		d.pool.getAgent(br.sessionId)?.history.push({ role: "user", content: "said on telegram" });
		const host = new FakeTabs({ "tab-one": ["my work 1", "my work 2"], "tab-two": ["other work"] });
		const before = host.snapshot();
		const c = controller(host, d);
		expect(await c.open()).toBe(true);
		const id = c.id as string;
		expect(host.tabs.get(id)?.title).toBe("Telegram linked");
		expect(host.tabs.get(id)?.data[TELEGRAM_TAB_DATA_KEY]).toBe(true);
		expect(host.tabs.get(id)?.messages.map((m) => m.content)[0]).toBe("said on telegram");
		expect(host.active).toBe(id);
		// Every other tab is byte-for-byte what it was.
		expect(host.snapshot(id)).toBe(before);
		expect(c.owns("tab-one")).toBe(false);
	});

	it("reuses the tab when it is already open: no second tab, and still nothing else touched", async () => {
		const d = daemon(join(root, "d2"));
		await bridge(d.url);
		const host = new FakeTabs({ "tab-one": ["keep me"] });
		const c = controller(host, d);
		await c.open();
		const first = c.id as string;
		host.switchTab("tab-one");
		const before = host.snapshot(first);
		expect(await c.open()).toBe(true);
		expect(c.id).toBe(first);
		expect(host.added).toBe(1);
		expect(host.active).toBe(first);
		expect(host.snapshot(first)).toBe(before);
	});

	it("a daemon with no home session opens no tab and touches nothing", async () => {
		const d = daemon(join(root, "d3"));
		const host = new FakeTabs({ "tab-one": ["keep me"] });
		const before = host.snapshot();
		const c = controller(host, d);
		expect(await c.open()).toBe(false);
		expect(host.added).toBe(0);
		expect(host.notes.join(" ")).toMatch(/no home session/);
		expect(host.snapshot()).toBe(before);
		expect(host.active).toBe("tab-one");
	});

	it("the tab limit opens nothing, closes the link, and says so", async () => {
		const d = daemon(join(root, "d4"));
		await bridge(d.url);
		const host = new FakeTabs({ "tab-one": ["keep me"] });
		host.limit = 1;
		const before = host.snapshot();
		const c = controller(host, d);
		expect(await c.open()).toBe(false);
		expect(host.notes.join(" ")).toMatch(/too many tabs/);
		expect(c.linked).toBe(false);
		expect(host.snapshot()).toBe(before);
	});

	it("Telegram traffic lands in the Telegram tab only", async () => {
		const d = daemon(join(root, "d5"));
		const br = await bridge(d.url);
		const host = new FakeTabs({ "tab-one": ["mine"], "tab-two": ["also mine"] });
		const c = controller(host, d);
		await c.open();
		const id = c.id as string;
		host.switchTab("tab-one");
		const before = host.snapshot(id);
		br.ws.send(JSON.stringify({ type: "prompt", text: "typed in telegram" }));
		await wait(() => (host.tabs.get(id)?.messages.length ?? 0) >= 3);
		const texts = host.tabs.get(id)?.messages.map((m) => m.content) ?? [];
		expect(texts).toContain("[Telegram] typed in telegram");
		expect(texts).toContain("echo: typed in telegram");
		expect(host.snapshot(id)).toBe(before);
	});

	it("what is typed in the tab reaches the daemon labelled as the terminal; a detached tab refuses sends", async () => {
		const d = daemon(join(root, "d6"));
		const br = await bridge(d.url);
		const host = new FakeTabs({ "tab-one": ["mine"] });
		const c = controller(host, d);
		await c.open();
		c.send("typed in the tui");
		await wait(() =>
			br.frames.some(
				(f) =>
					f.type === "event" &&
					f.event === "user:message" &&
					(f.payload as { channel?: string }).channel === "tui",
			),
		);
		const id = c.id as string;
		const history = host.tabs.get(id)?.messages.map((m) => m.content) ?? [];
		expect(await c.detach()).toBe(true);
		expect(host.tabs.get(id)?.title).toBe(telegramTabTitle("detached"));
		// History is kept; the tab is still the Telegram tab; other tabs untouched.
		expect(host.tabs.get(id)?.messages.map((m) => m.content)).toEqual(history);
		expect(c.owns(id)).toBe(true);
		expect(() => c.send("lost?")).toThrow(/detached from Telegram/);
		expect(host.tabs.get("tab-one")?.messages.map((m) => m.content)).toEqual(["mine"]);
	});

	it("attach again after a detach relinks the same tab and replaces only that tab's messages", async () => {
		const d = daemon(join(root, "d7"));
		const br = await bridge(d.url);
		d.pool.getAgent(br.sessionId)?.history.push({ role: "user", content: "fresh from telegram" });
		const host = new FakeTabs({ "tab-one": ["mine"] });
		const c = controller(host, d);
		await c.open();
		const id = c.id as string;
		await c.detach();
		host.switchTab("tab-one");
		const before = host.snapshot(id);
		expect(await c.open()).toBe(true);
		expect(c.id).toBe(id);
		expect(host.added).toBe(1);
		expect(host.tabs.get(id)?.title).toBe("Telegram linked");
		expect(host.tabs.get(id)?.messages[0]?.content).toBe("fresh from telegram");
		expect(host.snapshot(id)).toBe(before);
	});

	it("closing the tab detaches it, and a later attach opens a fresh tab", async () => {
		const d = daemon(join(root, "d8"));
		await bridge(d.url);
		const host = new FakeTabs({ "tab-one": ["mine"] });
		const c = controller(host, d);
		await c.open();
		const id = c.id as string;
		host.removeTab(id);
		c.tabsChanged();
		expect(c.linked).toBe(false);
		expect(c.id).toBeNull();
		expect(() => c.send("x")).toThrow(/detached/);
		expect(await c.open()).toBe(true);
		expect(c.id).not.toBe(id);
		expect(host.added).toBe(2);
	});

	it("the label follows a daemon restart: reconnecting, then linked, and only that tab changes", async () => {
		const dir = join(root, "d9");
		const first = daemon(dir);
		const port = first.server.port as number;
		const br1 = await bridge(first.url);
		first.pool.getAgent(br1.sessionId)?.history.push({ role: "user", content: "before" });
		const host = new FakeTabs({ "tab-one": ["mine"] });
		const c = controller(host, first);
		await c.open();
		const id = c.id as string;
		host.switchTab("tab-one");
		const before = host.snapshot(id);
		br1.ws.close();
		first.server.stop(true);
		await wait(() => host.tabs.get(id)?.title === "Telegram reconnecting");
		const second = daemon(dir, port);
		const br2 = await bridge(second.url);
		second.pool.getAgent(br2.sessionId)?.history.push({ role: "user", content: "after" });
		await wait(() => host.tabs.get(id)?.title === "Telegram linked");
		expect(host.tabs.get(id)?.messages[0]?.content).toBe("after");
		expect(host.snapshot(id)).toBe(before);
	});
});
