/**
 * Headless smoke test for the dispatch protocol.
 *
 * Boots a stripped-down gateway with a mock AgentPool, registers a
 * fake telegram surface and a fake computer surface, fires a dispatch
 * from telegram targeting the computer channel, and asserts:
 *
 *   - dispatch:registered acks for both surfaces
 *   - dispatch:ack with ok:true comes back to the originator
 *   - dispatch:event(accepted) lands on both originator + computer subscriber
 *   - dispatch:event(tool_call) -> tool_result -> stream(final) -> done
 *     all flow to both subscribers
 *   - replay of the same dispatch_id is rejected with replay_detected
 *   - protocol_version:1 on every frame
 *
 * Usage:
 *   bun run tests/dispatch/dispatch.smoke-test.ts
 *
 * Exit code 0 on success, 1 on any assertion miss.
 */

import type { AgentPool } from "../../packages/daemon/agent-pool";
import {
	type DispatchExecutor,
	DispatchHub,
	DispatchLedger,
	DispatchRateLimiter,
	DispatchRouter,
	LocalTokenVerifier,
	SurfaceRegistry,
} from "../../packages/daemon/dispatch";
import { bus } from "../../packages/daemon/events";
import { startGateway } from "../../packages/daemon/gateway";
import { PROTOCOL_VERSION } from "../../packages/daemon/types";

const PORT = Number(process.env.SMOKE_DISPATCH_PORT ?? 19191);
const URL = `ws://127.0.0.1:${PORT}/dispatch`;

let failed = 0;
function fail(reason: string): void {
	failed++;
	console.error(`[FAIL] ${reason}`);
}
function assert(cond: boolean, reason: string): void {
	if (!cond) fail(reason);
}
function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// Mock pool that emits a deterministic event sequence into the bus
// when chat() is called - same shape the real Agent emits.
class MockAgentPool {
	size = 0;
	private sessions = new Map<string, { channel: string }>();
	createSession(sessionId: string, channel: string): void {
		this.sessions.set(sessionId, { channel });
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
		bus.emit("agent:thinking", { sessionId });
		await delay(5);
		bus.emit("tool:start", {
			sessionId,
			tool: "desktop_screenshot",
			input: { displayId: 0 },
		});
		await delay(5);
		bus.emit("tool:result", {
			sessionId,
			tool: "desktop_screenshot",
			output: "/tmp/mock-screenshot.png",
			durationMs: 12,
		});
		await delay(5);
		const reply = `mock-reply: heard "${text}"`;
		bus.emit("agent:stream", { sessionId, chunk: reply, final: true });
		return reply;
	}
	getSessionInfo() {
		return null;
	}
	getActiveSessions() {
		return [];
	}
	getStatus() {
		return { total: this.sessions.size, globalCap: 10, channels: [] };
	}
}

interface OpenedSocket {
	ws: WebSocket;
	events: any[];
	wait(predicate: (msg: any) => boolean, timeoutMs?: number): Promise<any>;
	close(): void;
}

function openSocket(label: string): Promise<OpenedSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(URL);
		const events: any[] = [];
		const waiters: Array<{
			predicate: (msg: any) => boolean;
			resolve: (v: any) => void;
			timer: ReturnType<typeof setTimeout>;
		}> = [];

		ws.onopen = () => {
			console.log(`[smoke] ${label} socket open`);
			resolve({
				ws,
				events,
				wait(predicate, timeoutMs = 2500) {
					return new Promise<any>((res, rej) => {
						const existing = events.find(predicate);
						if (existing) return res(existing);
						const timer = setTimeout(() => {
							const idx = waiters.findIndex((w) => w.predicate === predicate);
							if (idx >= 0) waiters.splice(idx, 1);
							rej(new Error(`[${label}] timeout waiting for matching event`));
						}, timeoutMs);
						waiters.push({ predicate, resolve: res, timer });
					});
				},
				close: () => {
					try {
						ws.close();
					} catch {}
				},
			});
		};

		ws.onmessage = (ev) => {
			const text =
				typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
			let msg: any;
			try {
				msg = JSON.parse(text);
			} catch {
				return;
			}
			if (msg.protocol_version !== PROTOCOL_VERSION) {
				fail(`[${label}] missing protocol_version on ${text.slice(0, 80)}`);
			}
			events.push(msg);
			console.log(`[smoke] ${label} <- ${msg.type}${msg.event ? `:${msg.event.kind}` : ""}`);
			for (let i = waiters.length - 1; i >= 0; i--) {
				const w = waiters[i];
				if (w.predicate(msg)) {
					clearTimeout(w.timer);
					waiters.splice(i, 1);
					w.resolve(msg);
				}
			}
		};

		ws.onerror = (err) => {
			console.error(`[smoke] ${label} ws error`, err);
			reject(err);
		};
	});
}

async function main(): Promise<number> {
	const pool = new MockAgentPool() as unknown as AgentPool;

	const registry = new SurfaceRegistry();
	const ledger = new DispatchLedger();
	const rateLimiter = new DispatchRateLimiter();
	const verifier = new LocalTokenVerifier("smoke-test-secret-1234567890-long-enough");
	const hub = new DispatchHub();
	const executor: DispatchExecutor = {
		async executeOnChannel(targetChannel) {
			const sessionId = `smoke_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
			pool.createSession(sessionId, targetChannel);
			pool
				.chat(sessionId, "screenshot my desktop")
				.then(() => bus.emit("session:end", { sessionId, reason: "turn-complete" }))
				.catch((err) =>
					bus.emit("agent:error", {
						sessionId,
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			return { sessionId };
		},
	};
	const router = new DispatchRouter({
		registry,
		ledger,
		rateLimiter,
		verifier,
		executor,
		hub,
	});

	const server = startGateway({
		port: PORT,
		authToken: null,
		pool,
		dispatch: { registry, router, ledger, rateLimiter, verifier, hub },
	});

	try {
		await delay(50);

		// Mint two tokens.
		const tgToken = verifier.mint({
			surfaceId: "tg_main",
			channel: "telegram",
			userId: "u1",
			capabilities: ["read", "write_basic"],
		});
		const cpToken = verifier.mint({
			surfaceId: "cp_main",
			channel: "computer",
			userId: "u1",
			capabilities: ["read", "write_basic", "write_full", "admin"],
		});

		const tg = await openSocket("telegram");
		const cp = await openSocket("computer");

		// Register both surfaces.
		tg.ws.send(JSON.stringify({ type: "dispatch:register", token: tgToken }));
		cp.ws.send(JSON.stringify({ type: "dispatch:register", token: cpToken }));

		const tgReg = await tg.wait((m) => m.type === "dispatch:registered");
		const cpReg = await cp.wait((m) => m.type === "dispatch:registered");
		assert(tgReg.surface_id === "tg_main", "telegram registered with right surface_id");
		assert(cpReg.surface_id === "cp_main", "computer registered with right surface_id");
		assert(tgReg.capabilities.includes("write_basic"), "telegram has write_basic");
		assert(!tgReg.capabilities.includes("write_full"), "telegram capped at write_basic");

		// Computer subscribes to the correlation_id BEFORE the dispatch
		// fires so it sees the full event stream.
		const correlationId = "c_smoke_1";
		cp.ws.send(JSON.stringify({ type: "dispatch:subscribe", correlation_id: correlationId }));
		await cp.wait((m) => m.type === "dispatch:subscribed");

		// Dispatch from telegram.
		const dispatchId = "d_smoke_1";
		tg.ws.send(
			JSON.stringify({
				type: "dispatch:send",
				dispatch_id: dispatchId,
				originating_channel: "telegram",
				target_channel: "computer",
				target_surface_id: null,
				correlation_id: correlationId,
				replay_to: ["telegram", "computer"],
				intent: "screenshot my desktop and tell me what's open",
				capability_required: "write_basic",
			}),
		);

		const ack = await tg.wait((m) => m.type === "dispatch:ack");
		assert(ack.ok === true, `dispatch ack ok (got ${JSON.stringify(ack)})`);
		assert(ack.target_channel === "computer", "ack target_channel = computer");
		assert(typeof ack.session_id === "string", "ack carries session_id");

		// Both subscribers should see accepted -> tool_call -> tool_result -> stream(final) -> done.
		await Promise.all([
			tg.wait(
				(m) =>
					m.type === "dispatch:event" &&
					m.event.kind === "done" &&
					m.correlation_id === correlationId,
				4000,
			),
			cp.wait(
				(m) =>
					m.type === "dispatch:event" &&
					m.event.kind === "done" &&
					m.correlation_id === correlationId,
				4000,
			),
		]);

		const tgKinds = tg.events
			.filter((e) => e.type === "dispatch:event" && e.correlation_id === correlationId)
			.map((e) => e.event.kind);
		const cpKinds = cp.events
			.filter((e) => e.type === "dispatch:event" && e.correlation_id === correlationId)
			.map((e) => e.event.kind);

		console.log(`[smoke] telegram event kinds: ${tgKinds.join(",")}`);
		console.log(`[smoke] computer event kinds: ${cpKinds.join(",")}`);

		for (const kind of ["accepted", "tool_call", "tool_result", "stream", "done"]) {
			assert(tgKinds.includes(kind), `telegram saw ${kind}`);
			assert(cpKinds.includes(kind), `computer saw ${kind}`);
		}

		const tgFinalStream = tg.events.find(
			(e) =>
				e.type === "dispatch:event" &&
				e.event.kind === "stream" &&
				e.event.final === true &&
				e.correlation_id === correlationId,
		);
		assert(!!tgFinalStream, "telegram saw stream(final=true)");
		assert(
			tg.events.every(
				(e) =>
					!e.dispatch_source || e.dispatch_source === "telegram" || e.type !== "dispatch:event",
			),
			"all dispatch:event frames carry dispatch_source=telegram",
		);

		// Replay: re-send the same dispatch_id - must be rejected.
		tg.ws.send(
			JSON.stringify({
				type: "dispatch:send",
				dispatch_id: dispatchId,
				originating_channel: "telegram",
				target_channel: "computer",
				correlation_id: "c_smoke_replay",
				replay_to: [],
				intent: "replay attempt",
				capability_required: "write_basic",
			}),
		);
		const replayAck = await tg.wait(
			(m) =>
				m.type === "dispatch:ack" &&
				m.dispatch_id === dispatchId &&
				m.correlation_id === "c_smoke_replay",
		);
		assert(replayAck.ok === false, "replay ack ok=false");
		assert(
			replayAck.code === "replay_detected",
			`replay code = replay_detected (got ${replayAck.code})`,
		);

		// Capability denial: telegram tries write_full.
		tg.ws.send(
			JSON.stringify({
				type: "dispatch:send",
				dispatch_id: "d_smoke_2",
				originating_channel: "telegram",
				target_channel: "computer",
				correlation_id: "c_smoke_3",
				replay_to: [],
				intent: "click somewhere",
				capability_required: "write_full",
			}),
		);
		const capAck = await tg.wait((m) => m.type === "dispatch:ack" && m.dispatch_id === "d_smoke_2");
		assert(capAck.ok === false, "write_full from telegram is denied");
		assert(
			capAck.code === "capability_denied" || capAck.code === "policy_denied",
			`expected capability_denied/policy_denied, got ${capAck.code}`,
		);

		tg.close();
		cp.close();
		await delay(50);

		if (failed > 0) {
			console.error(`\n[smoke] FAIL (${failed} assertion(s))`);
			return 1;
		}
		console.log("\n[smoke] OK - all dispatch protocol assertions passed");
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
