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
