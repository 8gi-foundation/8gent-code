/**
 * Tests for daemon local-mode wiring (cross-surface dispatch demo, sprint 1).
 *
 * Covers:
 *   - Dispatch router prefers a registered local surface when
 *     EIGHT_DAEMON_LOCAL=1 and an explicit channel target matches.
 *   - Dispatch router falls through to channel-only execution when no
 *     local surface is registered, even in local mode.
 *   - Local-mode preference is gated: with EIGHT_DAEMON_LOCAL unset the
 *     existing behaviour is preserved.
 *   - Telegram bridge launcher rejects missing TELEGRAM_BOT_TOKEN and
 *     missing TELEGRAM_AUTHORIZED_CHAT_IDS so the daemon fails loud
 *     rather than running an unauthenticated bridge.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	DispatchHub,
	DispatchLedger,
	DispatchRateLimiter,
	DispatchRouter,
	LocalTokenVerifier,
	SurfaceRegistry,
	type DispatchEnvelope,
	type DispatchExecutor,
	type SurfaceRegistration,
} from "../dispatch";
import { startLocalTelegramBridge } from "../telegram-bridge";

const HMAC_SECRET = "test-secret-for-local-mode-suite-only";
const USER_ID = "user_james";

function makeRouterDeps(): {
	router: DispatchRouter;
	registry: SurfaceRegistry;
	executions: { targetChannel: string; intent: string }[];
} {
	const registry = new SurfaceRegistry();
	const ledger = new DispatchLedger();
	const rateLimiter = new DispatchRateLimiter();
	const verifier = new LocalTokenVerifier(HMAC_SECRET);
	const hub = new DispatchHub();
	const executions: { targetChannel: string; intent: string }[] = [];
	const executor: DispatchExecutor = {
		async executeOnChannel(targetChannel, intent) {
			executions.push({ targetChannel, intent });
			return { sessionId: `sess_${executions.length}` };
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
	return { router, registry, executions };
}

function registerSurface(
	registry: SurfaceRegistry,
	args: Partial<SurfaceRegistration> & { surfaceId: string; channel: SurfaceRegistration["channel"] },
): SurfaceRegistration {
	const reg: SurfaceRegistration = {
		surfaceId: args.surfaceId,
		channel: args.channel,
		userId: args.userId ?? USER_ID,
		capabilities: args.capabilities ?? ["read", "write_basic", "write_full", "admin"],
		token: args.token ?? `tok_${args.surfaceId}`,
		registeredAt: args.registeredAt ?? Date.now(),
		lastActiveAt: args.lastActiveAt ?? Date.now(),
	};
	registry.register(reg);
	return reg;
}

function makeEnvelope(overrides: Partial<DispatchEnvelope> = {}): DispatchEnvelope {
	return {
		dispatchId: overrides.dispatchId ?? `disp_${Math.random().toString(36).slice(2, 10)}`,
		originatingChannel: overrides.originatingChannel ?? "telegram",
		targetChannel: overrides.targetChannel ?? "os",
		targetSurfaceId: overrides.targetSurfaceId,
		correlationId: overrides.correlationId ?? `corr_${Math.random().toString(36).slice(2, 10)}`,
		replayTo: overrides.replayTo ?? [],
		intent: overrides.intent ?? "ship the demo",
		capabilityRequired: overrides.capabilityRequired ?? "write_basic",
	};
}

describe("daemon local mode - dispatch routing", () => {
	const originalLocal = process.env.EIGHT_DAEMON_LOCAL;

	afterEach(() => {
		if (originalLocal === undefined) delete process.env.EIGHT_DAEMON_LOCAL;
		else process.env.EIGHT_DAEMON_LOCAL = originalLocal;
	});

	it("prefers a registered local surface when EIGHT_DAEMON_LOCAL=1", async () => {
		process.env.EIGHT_DAEMON_LOCAL = "1";
		const { router, registry, executions } = makeRouterDeps();
		// Originator: phone Telegram surface.
		const phone = registerSurface(registry, {
			surfaceId: "tg_phone",
			channel: "telegram",
			capabilities: ["read", "write_basic"],
		});
		// Local TUI surface registered against the same user. The dispatch
		// targets channel "os" with no explicit surfaceId; the router
		// should pin the dispatch to this surface in local mode.
		const tui = registerSurface(registry, {
			surfaceId: "tui_mac",
			channel: "os",
			lastActiveAt: Date.now(),
		});

		const result = await router.dispatch(makeEnvelope({ targetChannel: "os" }), phone);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.targetSurfaceId).toBe(tui.surfaceId);
			expect(result.targetChannel).toBe("os");
		}
		expect(executions).toHaveLength(1);
		expect(executions[0]?.targetChannel).toBe("os");
		expect(executions[0]?.intent).toBe("ship the demo");
	});

	it("falls through to channel-only execution when no local surface matches", async () => {
		process.env.EIGHT_DAEMON_LOCAL = "1";
		const { router, registry, executions } = makeRouterDeps();
		const phone = registerSurface(registry, {
			surfaceId: "tg_phone",
			channel: "telegram",
			capabilities: ["read", "write_basic"],
		});
		// No "os" surface registered. Router should still execute, just
		// without pinning a targetSurfaceId.
		const result = await router.dispatch(makeEnvelope({ targetChannel: "os" }), phone);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.targetSurfaceId).toBeNull();
			expect(result.targetChannel).toBe("os");
		}
		expect(executions).toHaveLength(1);
	});

	it("ignores local surface preference when EIGHT_DAEMON_LOCAL is unset", async () => {
		delete process.env.EIGHT_DAEMON_LOCAL;
		const { router, registry, executions } = makeRouterDeps();
		const phone = registerSurface(registry, {
			surfaceId: "tg_phone",
			channel: "telegram",
			capabilities: ["read", "write_basic"],
		});
		registerSurface(registry, {
			surfaceId: "tui_mac",
			channel: "os",
		});

		const result = await router.dispatch(makeEnvelope({ targetChannel: "os" }), phone);
		expect(result.ok).toBe(true);
		if (result.ok) {
			// Without local mode the router does NOT pin to a registered
			// surface for explicit channel targets.
			expect(result.targetSurfaceId).toBeNull();
		}
		expect(executions).toHaveLength(1);
	});

	it("respects an explicit targetSurfaceId regardless of local mode", async () => {
		process.env.EIGHT_DAEMON_LOCAL = "1";
		const { router, registry, executions } = makeRouterDeps();
		const phone = registerSurface(registry, {
			surfaceId: "tg_phone",
			channel: "telegram",
			capabilities: ["read", "write_basic"],
		});
		const tui = registerSurface(registry, {
			surfaceId: "tui_mac",
			channel: "os",
		});
		const other = registerSurface(registry, {
			surfaceId: "tui_other",
			channel: "os",
		});
		// Caller pinned to `other`. Local-mode preference must NOT override.
		const env = makeEnvelope({ targetChannel: "os", targetSurfaceId: other.surfaceId });
		const result = await router.dispatch(env, phone);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.targetSurfaceId).toBe(other.surfaceId);
		}
		// Untouched: tui_mac should not be pinged.
		expect(executions).toHaveLength(1);
		// Use tui to keep the lint-no-unused-vars rule happy.
		expect(tui.surfaceId).toBe("tui_mac");
	});
});

describe("daemon local mode - telegram bridge launcher", () => {
	const snapshot = {
		token: process.env.TELEGRAM_BOT_TOKEN,
		ids: process.env.TELEGRAM_AUTHORIZED_CHAT_IDS,
	};

	beforeEach(() => {
		delete process.env.TELEGRAM_BOT_TOKEN;
		delete process.env.TELEGRAM_AUTHORIZED_CHAT_IDS;
	});

	afterEach(() => {
		if (snapshot.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
		else process.env.TELEGRAM_BOT_TOKEN = snapshot.token;
		if (snapshot.ids === undefined) delete process.env.TELEGRAM_AUTHORIZED_CHAT_IDS;
		else process.env.TELEGRAM_AUTHORIZED_CHAT_IDS = snapshot.ids;
	});

	it("throws when TELEGRAM_BOT_TOKEN is missing", async () => {
		await expect(startLocalTelegramBridge({ port: 18789 })).rejects.toThrow(
			/TELEGRAM_BOT_TOKEN/,
		);
	});

	it("throws when TELEGRAM_AUTHORIZED_CHAT_IDS is empty", async () => {
		process.env.TELEGRAM_BOT_TOKEN = "fake-token-for-test-only";
		process.env.TELEGRAM_AUTHORIZED_CHAT_IDS = "";
		await expect(startLocalTelegramBridge({ port: 18789 })).rejects.toThrow(
			/TELEGRAM_AUTHORIZED_CHAT_IDS/,
		);
	});
});

describe("daemon local mode - gateway loopback bind", () => {
	it("binds to 127.0.0.1 when DAEMON_HOSTNAME is set to loopback", async () => {
		// Pick a high port unlikely to collide with a running daemon.
		const port = 18900 + Math.floor(Math.random() * 100);
		const prevHost = process.env.DAEMON_HOSTNAME;
		process.env.DAEMON_HOSTNAME = "127.0.0.1";

		// Lazy-import to ensure the env override is applied before any
		// module-level side effects in gateway.ts.
		const { startGateway } = await import("../gateway");
		// The gateway requires a pool; use a minimal stub. The test only
		// exercises the HTTP /health route, which reads pool.size.
		const stubPool = {
			size: 0,
			getStatus: () => ({}),
			createSession: () => {},
			chat: async () => "",
			destroySession: () => {},
			getActiveSessions: () => [],
		};

		let server: { stop: () => void } | null = null;
		try {
			server = startGateway({
				port,
				authToken: null,
				// biome-ignore lint/suspicious/noExplicitAny: stub pool for loopback test
				pool: stubPool as any,
			});

			// Loopback should answer.
			const local = await fetch(`http://127.0.0.1:${port}/health`);
			expect(local.status).toBe(200);
			const body = await local.json();
			expect(body.status).toBe("ok");
		} finally {
			server?.stop();
			if (prevHost === undefined) delete process.env.DAEMON_HOSTNAME;
			else process.env.DAEMON_HOSTNAME = prevHost;
		}
	});
});
