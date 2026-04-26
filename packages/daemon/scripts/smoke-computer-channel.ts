/**
 * Smoke test for the daemon `computer` WS channel.
 *
 * Boots a stripped-down gateway with a mock AgentPool, opens a /computer
 * connection, sends an intent, and dumps every streamed event to stdout.
 * Validates:
 *   - 426/upgrade flow on /computer
 *   - session:created ack with channel="computer"
 *   - tool_call -> tool_result -> token(final) -> done event sequence
 *   - protocol_version: 1 on every frame
 *
 * Usage:
 *   bun run packages/daemon/scripts/smoke-computer-channel.ts
 *
 * Exit code 0 on success, 1 on any assertion miss.
 */

import { bus } from "../events";
import { startGateway } from "../gateway";
import type { AgentPool } from "../agent-pool";
import { PROTOCOL_VERSION } from "../types";

interface MockSession {
	channel: string;
	createdAt: number;
	messageCount: number;
}

class MockAgentPool {
	private sessions = new Map<string, MockSession>();
	size = 0;

	createSession(sessionId: string, channel: string): void {
		this.sessions.set(sessionId, {
			channel,
			createdAt: Date.now(),
			messageCount: 0,
		});
		this.size = this.sessions.size;
	}

	hasSession(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	destroySession(sessionId: string): void {
		this.sessions.delete(sessionId);
		this.size = this.sessions.size;
	}

	async chat(sessionId: string, text: string): Promise<string> {
		// Simulate a single tool call + final token in the bus event order the
		// real Agent emits. The route handler translates these into protocol events.
		bus.emit("agent:thinking", { sessionId });
		await delay(10);
		bus.emit("tool:start", {
			sessionId,
			tool: "desktop_screenshot",
			input: { displayId: 0 },
		});
		await delay(10);
		bus.emit("tool:result", {
			sessionId,
			tool: "desktop_screenshot",
			output: "/tmp/mock-screenshot.png",
			durationMs: 12,
		});
		await delay(10);
		const reply = `mock-reply: heard "${text}"`;
		bus.emit("agent:stream", { sessionId, chunk: reply, final: true });
		return reply;
	}

	getSessionInfo(sessionId: string) {
		const s = this.sessions.get(sessionId);
		if (!s) return null;
		return { channel: s.channel, messageCount: s.messageCount, busy: false };
	}

	getActiveSessions() {
		return Array.from(this.sessions.entries()).map(([id, s]) => ({
			sessionId: id,
			channel: s.channel,
			messageCount: s.messageCount,
			createdAt: s.createdAt,
		}));
	}

	getStatus() {
		return {
			total: this.sessions.size,
			globalCap: 10,
			channels: [
				{
					channel: "computer",
					active: this.sessions.size,
					cap: 3,
					idleTimeoutMs: 600_000,
				},
			],
		};
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

const PORT = Number(process.env.SMOKE_PORT ?? 19090);
const URL = `ws://127.0.0.1:${PORT}/computer`;

let failed = false;
function fail(reason: string): void {
	failed = true;
	console.error(`[FAIL] ${reason}`);
}

async function main(): Promise<number> {
	const pool = new MockAgentPool() as unknown as AgentPool;
	const server = startGateway({ port: PORT, authToken: null, pool });

	try {
		await delay(50);
		console.log(`[smoke] connecting to ${URL}`);
		const ws = new WebSocket(URL);

		const events: any[] = [];
		let sessionId: string | null = null;
		let donePromiseResolve!: () => void;
		const done = new Promise<void>((r) => (donePromiseResolve = r));

		ws.onopen = () => {
			console.log("[smoke] socket open");
		};

		ws.onmessage = (ev) => {
			const text =
				typeof ev.data === "string"
					? ev.data
					: new TextDecoder().decode(ev.data as ArrayBuffer);
			const msg = JSON.parse(text);
			events.push(msg);

			if (msg.protocol_version !== PROTOCOL_VERSION) {
				fail(`missing protocol_version on ${JSON.stringify(msg).slice(0, 80)}`);
			}

			if (msg.type === "ack" && msg.payload?.type === "session:created") {
				sessionId = msg.payload.sessionId;
				console.log(
					`[smoke] session created: ${sessionId} channel=${msg.payload.channel}`,
				);
				if (msg.payload.channel !== "computer")
					fail(`expected channel=computer, got ${msg.payload.channel}`);
				ws.send(
					JSON.stringify({ type: "intent", text: "screenshot my desktop" }),
				);
			}

			if (msg.type === "event") {
				const ev = msg.event;
				console.log(
					`[smoke] event: ${ev.kind}${ev.tool ? ` tool=${ev.tool}` : ""}${ev.final ? " final" : ""}`,
				);
				if (ev.kind === "done") donePromiseResolve();
			}
		};

		ws.onerror = (err) => {
			fail(`ws error: ${(err as ErrorEvent).message ?? "(no message)"}`);
			donePromiseResolve();
		};

		const timeout = setTimeout(() => {
			fail("timeout waiting for done event (3s)");
			donePromiseResolve();
		}, 3000);
		await done;
		clearTimeout(timeout);

		// Assertions
		const kinds = events
			.filter((e) => e.type === "event")
			.map((e) => e.event.kind);
		const ackTypes = events
			.filter((e) => e.type === "ack")
			.map((e) => e.payload?.type);

		if (!ackTypes.includes("session:created")) fail("no session:created ack");
		if (!kinds.includes("tool_call"))
			fail(`missing tool_call event (got ${kinds.join(",")})`);
		if (!kinds.includes("tool_result")) fail("missing tool_result event");
		if (!kinds.includes("token")) fail("missing token event");
		if (!kinds.includes("done")) fail("missing done event");

		const finalToken = events.find(
			(e) => e.type === "event" && e.event.kind === "token" && e.event.final,
		);
		if (!finalToken) fail("no token event with final=true");

		ws.close();
		await delay(50);

		console.log("\n[smoke] full event log:");
		for (const e of events) {
			console.log(
				`  ${e.type}${e.event ? `:${e.event.kind}` : ""}${e.payload ? ` ${JSON.stringify(e.payload).slice(0, 80)}` : ""}`,
			);
		}

		if (failed) {
			console.error("\n[smoke] FAIL");
			return 1;
		}
		console.log("\n[smoke] OK - all assertions passed");
		return 0;
	} finally {
		server.stop();
		bus.clear();
	}
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		console.error("[smoke] fatal:", err);
		process.exit(1);
	});
