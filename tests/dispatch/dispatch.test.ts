/**
 * Unit tests for the dispatch protocol building blocks.
 *
 * Covers the registry, ledger, rate limiter, token verifier, hub, and
 * router in isolation. Smoke test (dispatch.smoke-test.ts) exercises
 * the full WebSocket fan-out end-to-end.
 *
 * Run: bun test tests/dispatch/dispatch.test.ts
 */

import { describe, expect, it } from "bun:test";
import {
	CompositeTokenVerifier,
	type DispatchEnvelope,
	type DispatchExecutor,
	DispatchHub,
	DispatchLedger,
	DispatchRateLimiter,
	DispatchRouter,
	LocalTokenVerifier,
	type SurfaceRegistration,
	SurfaceRegistry,
	resolveLocalDispatchSecret,
} from "../../packages/daemon/dispatch";
import {
	CHANNEL_DEFAULT_CAPS,
	evaluateDispatchPolicy,
	intersectChannelCaps,
} from "../../packages/permissions/dispatch-policy";

// ---------------------------------------------------------------
// SurfaceRegistry
// ---------------------------------------------------------------

describe("SurfaceRegistry", () => {
	it("registers, retrieves, and unregisters by surface_id", () => {
		const reg = new SurfaceRegistry();
		const r: SurfaceRegistration = {
			surfaceId: "tg_a",
			channel: "telegram",
			userId: "u1",
			capabilities: ["read", "write_basic"],
			token: "tok_a",
			registeredAt: Date.now(),
			lastActiveAt: Date.now(),
		};
		reg.register(r);
		expect(reg.get("tg_a")).toBeDefined();
		expect(reg.list().length).toBe(1);

		reg.unregister("tg_a");
		expect(reg.get("tg_a")).toBeUndefined();
	});

	it("validates token via constant-time compare", () => {
		const reg = new SurfaceRegistry();
		reg.register({
			surfaceId: "s1",
			channel: "computer",
			userId: "u1",
			capabilities: ["read"],
			token: "secret_token_abc",
			registeredAt: Date.now(),
			lastActiveAt: Date.now(),
		});
		expect(reg.validateToken("s1", "secret_token_abc")).toBe(true);
		expect(reg.validateToken("s1", "secret_token_xyz")).toBe(false);
		expect(reg.validateToken("s1", "")).toBe(false);
		expect(reg.validateToken("nonexistent", "anything")).toBe(false);
	});

	it("queries by user and channel", () => {
		const reg = new SurfaceRegistry();
		const make = (sid: string, channel: SurfaceRegistration["channel"], user: string) => ({
			surfaceId: sid,
			channel,
			userId: user,
			capabilities: ["read"] as SurfaceRegistration["capabilities"],
			token: `t_${sid}`,
			registeredAt: Date.now(),
			lastActiveAt: Date.now(),
		});
		reg.register(make("a", "telegram", "u1"));
		reg.register(make("b", "computer", "u1"));
		reg.register(make("c", "telegram", "u2"));
		expect(reg.byUser("u1").length).toBe(2);
		expect(reg.byChannel("telegram").length).toBe(2);
		expect(reg.byChannel("computer").length).toBe(1);
	});
});

// ---------------------------------------------------------------
// DispatchLedger
// ---------------------------------------------------------------

describe("DispatchLedger", () => {
	it("rejects duplicate dispatch_id within the window", () => {
		const ledger = new DispatchLedger({ windowMs: 60_000, maxEntries: 100 });
		const tok = "t1";

		expect(ledger.check(tok, "d1")).toEqual({ ok: true });
		ledger.record(tok, "d1");

		const second = ledger.check(tok, "d1");
		expect(second.ok).toBe(false);
	});

	it("allows the same dispatch_id under a different token", () => {
		const ledger = new DispatchLedger();
		ledger.record("t1", "d1");
		expect(ledger.check("t2", "d1").ok).toBe(true);
	});

	it("caps memory at maxEntries per token", () => {
		const ledger = new DispatchLedger({ windowMs: 60_000, maxEntries: 5 });
		for (let i = 0; i < 20; i++) ledger.record("t", `d${i}`);
		expect(ledger.size("t")).toBe(5);
	});
});

// ---------------------------------------------------------------
// DispatchRateLimiter
// ---------------------------------------------------------------

describe("DispatchRateLimiter", () => {
	it("allows up to cap, then rejects with retryAfterMs", () => {
		const rl = new DispatchRateLimiter({ windowMs: 60_000, cap: 3 });
		const tok = "t1";
		expect(rl.consume(tok)).toEqual({ ok: true });
		expect(rl.consume(tok)).toEqual({ ok: true });
		expect(rl.consume(tok)).toEqual({ ok: true });
		const over = rl.consume(tok);
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.retryAfterMs).toBeGreaterThanOrEqual(0);
	});

	it("isolates buckets per token", () => {
		const rl = new DispatchRateLimiter({ cap: 1 });
		expect(rl.consume("a")).toEqual({ ok: true });
		expect(rl.consume("b")).toEqual({ ok: true });
		expect(rl.consume("a").ok).toBe(false);
		expect(rl.consume("b").ok).toBe(false);
	});
});

// ---------------------------------------------------------------
// LocalTokenVerifier
// ---------------------------------------------------------------

describe("LocalTokenVerifier", () => {
	it("round-trips minted tokens", () => {
		const v = new LocalTokenVerifier("a-secret-that-is-long-enough");
		const claims = {
			surfaceId: "s1",
			channel: "telegram" as const,
			userId: "u1",
			capabilities: ["read", "write_basic"] as const,
		};
		const token = v.mint({ ...claims, capabilities: [...claims.capabilities] });
		const verified = v.verify(token);
		expect(verified).not.toBeNull();
		expect(verified!.surfaceId).toBe("s1");
		expect(verified!.channel).toBe("telegram");
		expect(verified!.userId).toBe("u1");
	});

	it("rejects tokens with a tampered body", () => {
		const v = new LocalTokenVerifier("secret-secret-secret");
		const token = v.mint({
			surfaceId: "s1",
			channel: "telegram",
			userId: "u1",
			capabilities: ["read"],
		});
		const [body, sig] = token.split(".");
		const tampered = `${body}X.${sig}`;
		expect(v.verify(tampered)).toBeNull();
	});

	it("rejects expired tokens", () => {
		const v = new LocalTokenVerifier("secret-secret-secret");
		const token = v.mint({
			surfaceId: "s1",
			channel: "telegram",
			userId: "u1",
			capabilities: ["read"],
			exp: Date.now() - 1000,
		});
		expect(v.verify(token)).toBeNull();
	});

	it("rejects malformed input without throwing", () => {
		const v = new LocalTokenVerifier("secret-secret-secret");
		expect(v.verify("")).toBeNull();
		expect(v.verify("not-a-token")).toBeNull();
		expect(v.verify("a.b")).toBeNull();
	});

	it("requires a long-enough secret", () => {
		expect(() => new LocalTokenVerifier("short")).toThrow();
	});
});

describe("CompositeTokenVerifier", () => {
	it("returns the first verifier that accepts the token", () => {
		const a = new LocalTokenVerifier("secret-aaa-aaaaaa");
		const b = new LocalTokenVerifier("secret-bbb-bbbbbb");
		const tokenForB = b.mint({
			surfaceId: "s1",
			channel: "computer",
			userId: "u1",
			capabilities: ["read"],
		});
		const composite = new CompositeTokenVerifier([a, b]);
		expect(composite.verify(tokenForB)).not.toBeNull();
	});

	it("returns null when no verifier accepts", () => {
		const a = new LocalTokenVerifier("secret-aaa-aaaaaa");
		const b = new LocalTokenVerifier("secret-bbb-bbbbbb");
		const composite = new CompositeTokenVerifier([a, b]);
		expect(composite.verify("garbage")).toBeNull();
	});
});

// ---------------------------------------------------------------
// dispatch-policy
// ---------------------------------------------------------------

describe("dispatch-policy", () => {
	it("intersects claimed caps with the channel ceiling", () => {
		const got = intersectChannelCaps("telegram", ["read", "write_basic", "write_full", "admin"]);
		expect(got).toEqual(["read", "write_basic"]);
	});

	it("api channel preserves caller-controlled scope", () => {
		const got = intersectChannelCaps("api", ["read", "write_full"]);
		expect(got).toEqual(["read", "write_full"]);
	});

	it("denies a dispatch if the surface lacks the capability", () => {
		const decision = evaluateDispatchPolicy({
			fromChannel: "computer",
			fromCapabilities: ["read"],
			toChannel: "computer",
			capabilityRequired: "write_full",
			intent: "do something",
			userId: "u1",
		});
		expect(decision.allowed).toBe(false);
	});

	it("requires second-factor approval for write_full from a lite channel", () => {
		const decision = evaluateDispatchPolicy({
			fromChannel: "telegram",
			fromCapabilities: ["read", "write_basic", "write_full"],
			toChannel: "computer",
			capabilityRequired: "write_full",
			intent: "click something",
			userId: "u1",
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.requiresApproval).toBe(true);
		}
	});

	it("allows write_basic from a lite channel without approval", () => {
		const decision = evaluateDispatchPolicy({
			fromChannel: "telegram",
			fromCapabilities: ["read", "write_basic"],
			toChannel: "computer",
			capabilityRequired: "write_basic",
			intent: "screenshot",
			userId: "u1",
		});
		expect(decision.allowed).toBe(true);
	});

	it("denies dispatch when target channel does not host the capability", () => {
		const decision = evaluateDispatchPolicy({
			fromChannel: "computer",
			fromCapabilities: ["admin"],
			toChannel: "telegram",
			capabilityRequired: "admin",
			intent: "kick a user",
			userId: "u1",
		});
		expect(decision.allowed).toBe(false);
	});
});

// ---------------------------------------------------------------
// DispatchHub
// ---------------------------------------------------------------

describe("DispatchHub", () => {
	it("fans events out to every subscriber", () => {
		const hub = new DispatchHub();
		const got: string[] = [];
		const unsubA = hub.subscribe("c1", (f) => got.push(`A:${f.event.kind}`));
		const unsubB = hub.subscribe("c1", (f) => got.push(`B:${f.event.kind}`));
		hub.emit({
			type: "dispatch:event",
			dispatchId: "d1",
			correlationId: "c1",
			originatingChannel: "telegram",
			targetChannel: "computer",
			dispatchSource: "telegram",
			event: { kind: "stream", chunk: "hi" },
		});
		expect(got).toEqual(["A:stream", "B:stream"]);
		unsubA();
		unsubB();
	});

	it("ignores unrelated correlation ids", () => {
		const hub = new DispatchHub();
		const got: string[] = [];
		hub.subscribe("c1", (f) => got.push(f.event.kind));
		hub.emit({
			type: "dispatch:event",
			dispatchId: "d1",
			correlationId: "c-other",
			originatingChannel: "telegram",
			targetChannel: "computer",
			dispatchSource: "telegram",
			event: { kind: "stream" },
		});
		expect(got).toEqual([]);
	});

	it("survives a sink unsubscribing during emit", () => {
		const hub = new DispatchHub();
		const got: string[] = [];
		let unsubA = (): void => {};
		unsubA = hub.subscribe("c1", () => {
			got.push("A");
			unsubA();
		});
		hub.subscribe("c1", () => got.push("B"));
		hub.emit({
			type: "dispatch:event",
			dispatchId: "d1",
			correlationId: "c1",
			originatingChannel: "telegram",
			targetChannel: "computer",
			dispatchSource: "telegram",
			event: { kind: "done" },
		});
		expect(got).toEqual(["A", "B"]);
	});
});

// ---------------------------------------------------------------
// DispatchRouter (integration with mock executor)
// ---------------------------------------------------------------

describe("DispatchRouter", () => {
	function setup() {
		const registry = new SurfaceRegistry();
		const ledger = new DispatchLedger();
		const rateLimiter = new DispatchRateLimiter({ cap: 5 });
		const verifier = new LocalTokenVerifier("test-test-test-test-test-secret");
		const hub = new DispatchHub();
		const traces: Array<{ dispatchSource: string; result: string; reason?: string }> = [];
		const executions: Array<{ channel: string; intent: string }> = [];
		const executor: DispatchExecutor = {
			async executeOnChannel(channel, intent) {
				executions.push({ channel, intent });
				return { sessionId: `s_${channel}_${executions.length}` };
			},
		};
		const router = new DispatchRouter({
			registry,
			ledger,
			rateLimiter,
			verifier,
			executor,
			hub,
			onTrace: (record) => {
				traces.push({
					dispatchSource: record.dispatchSource,
					result: record.result,
					reason: record.reason,
				});
			},
		});
		return { registry, ledger, rateLimiter, verifier, hub, router, executions, traces };
	}

	function makeSurface(
		reg: SurfaceRegistry,
		channel: SurfaceRegistration["channel"],
		userId = "u1",
	) {
		const sr: SurfaceRegistration = {
			surfaceId: `s_${channel}_${userId}`,
			channel,
			userId,
			capabilities: ["read", "write_basic"],
			token: `tok_${channel}_${userId}`,
			registeredAt: Date.now(),
			lastActiveAt: Date.now(),
		};
		reg.register(sr);
		return sr;
	}

	function envelope(over?: Partial<DispatchEnvelope>): DispatchEnvelope {
		return {
			dispatchId: `d_${Date.now()}_${Math.random().toString(36).slice(2)}`,
			originatingChannel: "telegram",
			targetChannel: "computer",
			targetSurfaceId: null,
			correlationId: `c_${Math.random().toString(36).slice(2)}`,
			replayTo: ["telegram", "computer"],
			intent: "screenshot my desktop",
			capabilityRequired: "write_basic",
			...over,
		};
	}

	it("routes a valid dispatch and records an allowed trace", async () => {
		const ctx = setup();
		const tg = makeSurface(ctx.registry, "telegram");
		const env = envelope();
		const result = await ctx.router.dispatch(env, tg);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.targetChannel).toBe("computer");
			expect(result.sessionId).toMatch(/^s_computer_/);
		}
		expect(ctx.executions.length).toBe(1);
		expect(ctx.executions[0].channel).toBe("computer");
		expect(ctx.traces.length).toBe(1);
		expect(ctx.traces[0].dispatchSource).toBe("telegram");
		expect(ctx.traces[0].result).toBe("allowed");
	});

	it("rejects a replayed dispatch_id", async () => {
		const ctx = setup();
		const tg = makeSurface(ctx.registry, "telegram");
		const env = envelope();
		await ctx.router.dispatch(env, tg);
		const second = await ctx.router.dispatch(env, tg);
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.code).toBe("replay_detected");
	});

	it("rejects when rate-limited", async () => {
		const ctx = setup(); // cap 5
		const tg = makeSurface(ctx.registry, "telegram");
		for (let i = 0; i < 5; i++) {
			await ctx.router.dispatch(envelope(), tg);
		}
		const blocked = await ctx.router.dispatch(envelope(), tg);
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.code).toBe("rate_limited");
	});

	it("denies dispatch when capability is insufficient", async () => {
		const ctx = setup();
		const tg = makeSurface(ctx.registry, "telegram");
		const env = envelope({ capabilityRequired: "admin" });
		const result = await ctx.router.dispatch(env, tg);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(["capability_denied", "policy_denied"]).toContain(result.code);
		}
	});

	it("blocks cross-tenant dispatch via target_surface_id", async () => {
		const ctx = setup();
		const tg = makeSurface(ctx.registry, "telegram", "u1");
		const otherUserComputer = makeSurface(ctx.registry, "computer", "u2");
		const env = envelope({ targetSurfaceId: otherUserComputer.surfaceId });
		const result = await ctx.router.dispatch(env, tg);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("no_target");
	});

	it("auto target picks the most recently active surface for the user", async () => {
		const ctx = setup();
		const tg = makeSurface(ctx.registry, "telegram", "u1");
		const cp = makeSurface(ctx.registry, "computer", "u1");
		// Make computer the freshest.
		cp.lastActiveAt = Date.now() + 1000;
		const env = envelope({ targetChannel: "auto" });
		const result = await ctx.router.dispatch(env, tg);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.targetChannel).toBe("computer");
	});

	it("emits an accepted event to subscribers on success", async () => {
		const ctx = setup();
		const tg = makeSurface(ctx.registry, "telegram");
		const env = envelope();
		const got: string[] = [];
		ctx.hub.subscribe(env.correlationId, (f) => got.push(f.event.kind));
		await ctx.router.dispatch(env, tg);
		expect(got).toEqual(["accepted"]);
	});
});

// ---------------------------------------------------------------
// resolveLocalDispatchSecret
// ---------------------------------------------------------------

describe("resolveLocalDispatchSecret", () => {
	it("returns env when set and long enough", () => {
		const prev = process.env.EIGHT_DISPATCH_SECRET;
		process.env.EIGHT_DISPATCH_SECRET = "this-is-a-long-enough-test-secret";
		try {
			expect(resolveLocalDispatchSecret()).toBe("this-is-a-long-enough-test-secret");
		} finally {
			process.env.EIGHT_DISPATCH_SECRET = prev;
		}
	});

	it("falls back to a random secret when env is too short", () => {
		const prev = process.env.EIGHT_DISPATCH_SECRET;
		process.env.EIGHT_DISPATCH_SECRET = "too-short"; // < 16 chars triggers fallback
		try {
			const a = resolveLocalDispatchSecret();
			const b = resolveLocalDispatchSecret();
			expect(a.length).toBeGreaterThanOrEqual(16);
			expect(b.length).toBeGreaterThanOrEqual(16);
			expect(a).not.toBe(b);
		} finally {
			if (prev === undefined) process.env.EIGHT_DISPATCH_SECRET = "";
			else process.env.EIGHT_DISPATCH_SECRET = prev;
		}
	});
});

// ---------------------------------------------------------------
// CHANNEL_DEFAULT_CAPS sanity
// ---------------------------------------------------------------

describe("CHANNEL_DEFAULT_CAPS", () => {
	it("matches the spec for lite channels", () => {
		expect(CHANNEL_DEFAULT_CAPS.telegram).toEqual(["read", "write_basic"]);
		expect(CHANNEL_DEFAULT_CAPS.discord).toEqual(["read", "write_basic"]);
	});

	it("computer/os/app have full capabilities", () => {
		expect(CHANNEL_DEFAULT_CAPS.computer).toContain("write_full");
		expect(CHANNEL_DEFAULT_CAPS.os).toContain("write_full");
		expect(CHANNEL_DEFAULT_CAPS.app).toContain("write_full");
	});
});
