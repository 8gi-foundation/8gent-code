import { describe, expect, it } from "bun:test";
import { DaemonClient, type WebSocketLike } from "./daemon-client";

class FakeSocket implements WebSocketLike {
	readyState = 0;
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

	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	receive(message: object): void {
		this.onmessage?.({ data: JSON.stringify(message) });
	}
}

describe("DaemonClient", () => {
	it("connects, creates a session, and resolves connect()", async () => {
		const sock = new FakeSocket();
		const client = new DaemonClient({
			url: "ws://test",
			channel: "telegram",
			socketFactory: () => sock,
		});
		const connecting = client.connect();
		sock.open();
		// The bridge sends session:create on open; respond with session:created.
		sock.receive({ type: "session:created", sessionId: "sess_1" });
		await connecting;
		expect(client.getSessionId()).toBe("sess_1");
		expect(sock.sent.some((s) => s.includes("session:create"))).toBe(true);
		client.close();
	});

	it("dispatches event payloads to subscribers", async () => {
		const sock = new FakeSocket();
		const client = new DaemonClient({ url: "ws://test", socketFactory: () => sock });
		const connecting = client.connect();
		sock.open();
		sock.receive({ type: "session:created", sessionId: "s" });
		await connecting;

		const seen: string[] = [];
		client.on("tool:start", (p) => seen.push(`start:${p.tool}`));
		client.on("agent:stream", (p) => seen.push(`stream:${p.chunk}`));

		sock.receive({
			type: "event",
			event: "tool:start",
			payload: { sessionId: "s", tool: "bash", input: { command: "ls" } },
		});
		sock.receive({
			type: "event",
			event: "agent:stream",
			payload: { sessionId: "s", chunk: "hi", final: true },
		});

		expect(seen).toEqual(["start:bash", "stream:hi"]);
		client.close();
	});

	it("sendPrompt is no-op when not open", () => {
		const sock = new FakeSocket();
		const client = new DaemonClient({ url: "ws://test", socketFactory: () => sock });
		// readyState is 0 (CONNECTING). Should not throw.
		expect(() => client.sendPrompt("hello")).not.toThrow();
		expect(sock.sent.length).toBe(0);
	});
});

describe("DaemonClient session lifecycle (#3538)", () => {
	const frames = (sock: FakeSocket) => sock.sent.map((s) => JSON.parse(s));
	const tick = () => new Promise((r) => setTimeout(r, 5));

	it("resumes the same session on reconnect instead of creating a new one", async () => {
		const sockets: FakeSocket[] = [];
		const client = new DaemonClient({
			url: "ws://test",
			channel: "telegram",
			reconnectDelayMs: 0,
			socketFactory: () => {
				const s = new FakeSocket();
				sockets.push(s);
				return s;
			},
		});
		const connecting = client.connect();
		sockets[0].open();
		sockets[0].receive({ type: "session:created", sessionId: "sess_A" });
		await connecting;

		// Network blip: the socket drops, the client redials.
		sockets[0].close();
		await tick();
		expect(sockets.length).toBe(2);
		sockets[1].open();

		expect(frames(sockets[1])).toEqual([
			{ type: "session:resume", sessionId: "sess_A", channel: "telegram" },
		]);
		sockets[1].receive({ type: "session:resumed", sessionId: "sess_A" });
		expect(client.getSessionId()).toBe("sess_A");
		client.close();
	});

	it("connect() resolves on session:resumed after a reconnect", async () => {
		const sockets: FakeSocket[] = [];
		const client = new DaemonClient({
			url: "ws://test",
			reconnectDelayMs: 0,
			socketFactory: () => {
				const s = new FakeSocket();
				sockets.push(s);
				return s;
			},
		});
		const first = client.connect();
		sockets[0].open();
		sockets[0].receive({ type: "session:created", sessionId: "sess_A" });
		await first;

		sockets[0].close();
		await tick();
		const again = client.connect();
		sockets[1].open();
		sockets[1].receive({ type: "session:resumed", sessionId: "sess_A" });
		const result = await Promise.race([
			again.then(() => "resolved"),
			new Promise((r) => setTimeout(() => r("timeout"), 200)),
		]);
		expect(result).toBe("resolved");
		client.close();
	});

	it("resetSession destroys the old session before creating a fresh one", async () => {
		const sock = new FakeSocket();
		const client = new DaemonClient({
			url: "ws://test",
			channel: "telegram",
			socketFactory: () => sock,
		});
		const connecting = client.connect();
		sock.open();
		sock.receive({ type: "session:created", sessionId: "sess_A" });
		await connecting;
		sock.sent.length = 0;

		client.resetSession();
		expect(frames(sock)).toEqual([
			{ type: "session:destroy", sessionId: "sess_A" },
			{ type: "session:create", channel: "telegram" },
		]);
		client.close();
	});
});

describe("DaemonClient on a session the TUI can join (#4834)", () => {
	async function connected(config: { home?: boolean } = {}) {
		const sock = new FakeSocket();
		const client = new DaemonClient({ url: "ws://test", socketFactory: () => sock, ...config });
		const connecting = client.connect();
		sock.open();
		sock.receive({ type: "session:created", sessionId: "s" });
		await connecting;
		return { sock, client };
	}
	const stream = (sock: FakeSocket, chunk: string) =>
		sock.receive({
			type: "event",
			event: "agent:stream",
			payload: { sessionId: "s", chunk, final: true },
		});
	const types = (sock: FakeSocket) => sock.sent.map((s) => JSON.parse(s).type);

	it("declares its session home only when asked to, and only after the session exists", async () => {
		const yes = await connected({ home: true });
		expect(types(yes.sock)).toContain("home:declare");
		expect(types(yes.sock).indexOf("home:declare")).toBeGreaterThan(
			types(yes.sock).indexOf("session:create"),
		);
		const no = await connected();
		expect(types(no.sock)).not.toContain("home:declare");
	});

	it("a TUI turn's reply never reaches the adapter, the bridge's own does", async () => {
		const { sock, client } = await connected({ home: true });
		const seen: string[] = [];
		const ends: number[] = [];
		client.on("agent:stream", (p) => seen.push(p.chunk));
		client.on("session:end", () => ends.push(1));
		sock.receive({
			type: "event",
			event: "user:message",
			payload: { sessionId: "s", text: "typed in the TUI", channel: "tui" },
		});
		stream(sock, "reply to the TUI");
		sock.receive({
			type: "event",
			event: "session:end",
			payload: { sessionId: "s", reason: "turn-complete" },
		});
		client.sendPrompt("typed in Telegram");
		stream(sock, "reply to Telegram");
		sock.receive({
			type: "event",
			event: "session:end",
			payload: { sessionId: "s", reason: "turn-complete" },
		});
		expect(seen).toEqual(["reply to Telegram"]);
		expect(ends).toEqual([1]);
	});

	it("a reconnect in the middle of a TUI turn delivers nothing more from that turn (tagging daemon)", async () => {
		const sock = new FakeSocket();
		const client = new DaemonClient({ url: "ws://test", socketFactory: () => sock, home: true });
		const connecting = client.connect();
		sock.open();
		const caps = ["input-gate", "turn-origin"];
		sock.receive({ type: "session:created", sessionId: "s", capabilities: caps });
		await connecting;
		const seen: string[] = [];
		client.on("agent:stream", (p) => seen.push(p.chunk));
		client.on("tool:start", (p) => seen.push(`tool:${p.tool}`));
		const ev = (event: string, payload: Record<string, unknown>) =>
			sock.receive({ type: "event", event, payload: { sessionId: "s", ...payload } });
		ev("tool:start", { tool: "read_file", origin: "tui" });
		// The bridge's socket drops and resumes while the TUI's turn is still running.
		sock.receive({ type: "session:resumed", sessionId: "s", capabilities: caps });
		ev("agent:stream", { chunk: "rest of the TUI turn", final: true, origin: "tui" });
		ev("session:end", { reason: "turn-complete", origin: "tui" });
		ev("agent:stream", { chunk: "untagged", final: true });
		ev("agent:stream", { chunk: "telegram's own", final: true, origin: "telegram" });
		expect(seen).toEqual(["telegram's own"]);
	});
});
