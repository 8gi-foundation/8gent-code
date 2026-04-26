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
