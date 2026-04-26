/**
 * Remote dispatch protocol - the nervous system of 8gentOS.
 *
 * Lets any surface (Code TUI, Telegram, Discord, OS web, Computer panel,
 * mobile, future) target a session on any other surface, with replay
 * protection, rate limiting, capability scoping, and result fan-out.
 *
 * Spec: docs/specs/DAEMON-PROTOCOL.md (Dispatch section)
 * Issue: https://github.com/8gi-foundation/8gent-code/issues/1896
 *
 * The router is execution-centric: regardless of which surface dispatched,
 * the daemon runs the intent through `AgentPool` on the requested
 * `target_channel`, then fans events out to every subscribed surface in
 * `replay_to` plus the originator. Surfaces are observers; the daemon is
 * the trusted executor.
 */

import * as crypto from "node:crypto";
import { evaluateDispatchPolicy } from "../permissions/dispatch-policy";
import type { DaemonChannel, DispatchCapability } from "./types";

// Re-export for callers that already imported the type from this module.
export type { DispatchCapability };

/** A surface registered with the dispatch registry. */
export interface SurfaceRegistration {
	/** Globally unique id for this surface instance (e.g. "tg_bot_main_xyz"). */
	surfaceId: string;
	/** Channel this surface represents (telegram, computer, os, etc.). */
	channel: DaemonChannel;
	/** Tenant / user this surface acts on behalf of. */
	userId: string;
	/** Capabilities this surface holds. Union of all minted in its token. */
	capabilities: DispatchCapability[];
	/** Token presented at registration. Stored for re-auth on each dispatch. */
	token: string;
	/** When the surface registered (ms). */
	registeredAt: number;
	/** Last-seen activity (ms). Used for "auto" target resolution. */
	lastActiveAt: number;
}

/** A dispatch envelope sent from surface A targeting surface B. */
export interface DispatchEnvelope {
	/** Monotonic per-token id. Replay-protected. */
	dispatchId: string;
	/** Channel that originated this dispatch. */
	originatingChannel: DaemonChannel;
	/** Where to execute. "auto" means router picks the user's most-active surface. */
	targetChannel: DaemonChannel | "auto";
	/** Optional: route to a specific surface_id (overrides targetChannel routing). */
	targetSurfaceId?: string | null;
	/** Tied to the response stream for fan-out correlation. */
	correlationId: string;
	/** Channels that should receive a copy of the result events. */
	replayTo: DaemonChannel[];
	/** The agent intent / prompt. */
	intent: string;
	/** Capability the dispatch needs at the target. */
	capabilityRequired: DispatchCapability;
}

/** Result of a dispatch attempt. */
export type DispatchResult =
	| {
			ok: true;
			sessionId: string;
			targetChannel: DaemonChannel;
			targetSurfaceId: string | null;
			correlationId: string;
			dispatchId: string;
	  }
	| {
			ok: false;
			error: string;
			code:
				| "unknown_token"
				| "replay_detected"
				| "rate_limited"
				| "capability_denied"
				| "policy_denied"
				| "no_target"
				| "internal";
			retryAfterMs?: number;
	  };

// ============================================================
// SurfaceRegistry
// ============================================================

/** In-memory registry. One process, one registry. */
export class SurfaceRegistry {
	private bySurfaceId = new Map<string, SurfaceRegistration>();

	register(reg: SurfaceRegistration): void {
		this.bySurfaceId.set(reg.surfaceId, reg);
	}

	unregister(surfaceId: string): void {
		this.bySurfaceId.delete(surfaceId);
	}

	get(surfaceId: string): SurfaceRegistration | undefined {
		return this.bySurfaceId.get(surfaceId);
	}

	/** Validate that surfaceId is registered AND token still matches. */
	validateToken(surfaceId: string, token: string): boolean {
		const reg = this.bySurfaceId.get(surfaceId);
		if (!reg) return false;
		// Constant-time compare so a token-poking attacker can't time-side-channel.
		const a = Buffer.from(reg.token);
		const b = Buffer.from(token);
		if (a.length !== b.length) return false;
		return crypto.timingSafeEqual(a, b);
	}

	byUser(userId: string): SurfaceRegistration[] {
		const out: SurfaceRegistration[] = [];
		for (const r of this.bySurfaceId.values()) {
			if (r.userId === userId) out.push(r);
		}
		return out;
	}

	byChannel(channel: DaemonChannel): SurfaceRegistration[] {
		const out: SurfaceRegistration[] = [];
		for (const r of this.bySurfaceId.values()) {
			if (r.channel === channel) out.push(r);
		}
		return out;
	}

	/** All surfaces currently registered. Used by `sessions:list` and ops dashboards. */
	list(): SurfaceRegistration[] {
		return Array.from(this.bySurfaceId.values());
	}

	/** Mark surface activity. Drives "auto" target resolution. */
	touch(surfaceId: string): void {
		const reg = this.bySurfaceId.get(surfaceId);
		if (reg) reg.lastActiveAt = Date.now();
	}

	clear(): void {
		this.bySurfaceId.clear();
	}
}

// ============================================================
// DispatchLedger - sliding-window replay protection
// ============================================================

interface LedgerEntry {
	dispatchId: string;
	ts: number;
}

/**
 * Per-token ring buffer of recent dispatch_ids. A duplicate within
 * `windowMs` is rejected. Keeps at most `maxEntries` per token to bound
 * memory under abuse.
 */
export class DispatchLedger {
	private readonly windowMs: number;
	private readonly maxEntries: number;
	private byToken = new Map<string, LedgerEntry[]>();

	constructor(opts?: { windowMs?: number; maxEntries?: number }) {
		this.windowMs = opts?.windowMs ?? 5 * 60 * 1000;
		this.maxEntries = opts?.maxEntries ?? 1000;
	}

	check(token: string, dispatchId: string): { ok: true } | { ok: false; reason: string } {
		const now = Date.now();
		const entries = this.byToken.get(token) ?? [];
		// Drop entries outside the window.
		const fresh = entries.filter((e) => now - e.ts <= this.windowMs);
		if (fresh.some((e) => e.dispatchId === dispatchId)) {
			this.byToken.set(token, fresh);
			return { ok: false, reason: `dispatch_id ${dispatchId} replayed within window` };
		}
		this.byToken.set(token, fresh);
		return { ok: true };
	}

	record(token: string, dispatchId: string): void {
		const entries = this.byToken.get(token) ?? [];
		entries.push({ dispatchId, ts: Date.now() });
		// Cap memory under abuse: drop oldest if over.
		if (entries.length > this.maxEntries) {
			entries.splice(0, entries.length - this.maxEntries);
		}
		this.byToken.set(token, entries);
	}

	reset(token?: string): void {
		if (token) this.byToken.delete(token);
		else this.byToken.clear();
	}

	size(token: string): number {
		return this.byToken.get(token)?.length ?? 0;
	}
}

// ============================================================
// RateLimiter - per-token rolling window
// ============================================================

interface RateBucket {
	hits: number[];
}

/**
 * Per-token rolling-window counter. Default 100 dispatches/min/token.
 * Configurable via constructor; the rate is intentionally ungenerous
 * because dispatch is a privileged action, not a chat hot-path.
 */
export class DispatchRateLimiter {
	private readonly windowMs: number;
	private readonly cap: number;
	private buckets = new Map<string, RateBucket>();

	constructor(opts?: { windowMs?: number; cap?: number }) {
		this.windowMs = opts?.windowMs ?? 60 * 1000;
		this.cap = opts?.cap ?? 100;
	}

	consume(token: string): { ok: true } | { ok: false; retryAfterMs: number } {
		const now = Date.now();
		const bucket = this.buckets.get(token) ?? { hits: [] };
		bucket.hits = bucket.hits.filter((t) => now - t < this.windowMs);
		if (bucket.hits.length >= this.cap) {
			const oldest = bucket.hits[0];
			const retryAfterMs = Math.max(0, this.windowMs - (now - oldest));
			this.buckets.set(token, bucket);
			return { ok: false, retryAfterMs };
		}
		bucket.hits.push(now);
		this.buckets.set(token, bucket);
		return { ok: true };
	}

	reset(token?: string): void {
		if (token) this.buckets.delete(token);
		else this.buckets.clear();
	}
}

// ============================================================
// TokenVerifier - pluggable so Clerk JWTs can wire in later
// ============================================================

export interface TokenClaims {
	surfaceId: string;
	channel: DaemonChannel;
	userId: string;
	capabilities: DispatchCapability[];
	/** Optional expiry (epoch ms). Verifier rejects expired tokens. */
	exp?: number;
}

export interface TokenVerifier {
	/** Returns claims if valid, null if not. Must NOT throw on bad tokens. */
	verify(token: string): TokenClaims | null;
	/** Mint a new scoped token. Optional - implementations that only verify return null here. */
	mint?(claims: TokenClaims): string | null;
}

/**
 * Local HMAC token verifier. Used for same-machine surfaces (Computer
 * panel, lil-eight, local Telegram bridge). Format:
 *   base64url(JSON claims) + "." + base64url(hmac_sha256(secret, claims))
 *
 * Remote surfaces (8gent.app web on Clerk-authed sessions) plug in their
 * own verifier - this class is the local default.
 */
export class LocalTokenVerifier implements TokenVerifier {
	constructor(private readonly secret: string) {
		if (!secret || secret.length < 16) {
			throw new Error("LocalTokenVerifier secret must be at least 16 chars");
		}
	}

	mint(claims: TokenClaims): string {
		const body = b64url(Buffer.from(JSON.stringify(claims)));
		const sig = b64url(crypto.createHmac("sha256", this.secret).update(body).digest());
		return `${body}.${sig}`;
	}

	verify(token: string): TokenClaims | null {
		const idx = token.lastIndexOf(".");
		if (idx <= 0) return null;
		const body = token.slice(0, idx);
		const sig = token.slice(idx + 1);
		const expected = b64url(crypto.createHmac("sha256", this.secret).update(body).digest());
		// Constant-time compare.
		const a = Buffer.from(sig);
		const b = Buffer.from(expected);
		if (a.length !== b.length) return null;
		if (!crypto.timingSafeEqual(a, b)) return null;
		try {
			const decoded = Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
				"utf-8",
			);
			const claims = JSON.parse(decoded) as TokenClaims;
			if (claims.exp && claims.exp < Date.now()) return null;
			if (!claims.surfaceId || !claims.channel || !claims.userId) return null;
			if (!Array.isArray(claims.capabilities)) return null;
			return claims;
		} catch {
			return null;
		}
	}
}

/**
 * Composite verifier - tries each verifier in order, returns the first
 * non-null claim. Lets the daemon accept BOTH local HMAC tokens AND
 * Clerk JWTs in the same listener.
 */
export class CompositeTokenVerifier implements TokenVerifier {
	constructor(private readonly verifiers: TokenVerifier[]) {}

	verify(token: string): TokenClaims | null {
		for (const v of this.verifiers) {
			const claims = v.verify(token);
			if (claims) return claims;
		}
		return null;
	}
}

function b64url(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ============================================================
// DispatchRouter - the front door
// ============================================================

/**
 * What the router needs from the surrounding daemon. Kept as a small
 * surface so the smoke test can pass a mock without dragging in the full
 * AgentPool + bus.
 */
export interface DispatchExecutor {
	/** Run an intent on a session tagged with `targetChannel`. Returns the sessionId actually used. */
	executeOnChannel(
		targetChannel: DaemonChannel,
		intent: string,
		meta: { dispatchId: string; correlationId: string; userId: string },
	): Promise<{ sessionId: string }>;
}

/**
 * Sink that receives a streaming event for a particular dispatch.
 * The route layer plugs this into its WebSocket; tests plug in an array.
 */
export type DispatchEventSink = (frame: DispatchEventFrame) => void;

export interface DispatchEventFrame {
	type: "dispatch:event";
	dispatchId: string;
	correlationId: string;
	originatingChannel: DaemonChannel;
	targetChannel: DaemonChannel;
	dispatchSource: DaemonChannel;
	event: {
		kind: "accepted" | "stream" | "tool_call" | "tool_result" | "error" | "done";
		[k: string]: unknown;
	};
}

/**
 * Per-correlation-id fan-out hub. The route attaches a sink for the
 * originator AND every replayTo subscriber. The router pushes events
 * here as they arrive from the agent loop.
 */
export class DispatchHub {
	private sinks = new Map<string, DispatchEventSink[]>();

	subscribe(correlationId: string, sink: DispatchEventSink): () => void {
		const list = this.sinks.get(correlationId) ?? [];
		list.push(sink);
		this.sinks.set(correlationId, list);
		return () => {
			const cur = this.sinks.get(correlationId);
			if (!cur) return;
			const idx = cur.indexOf(sink);
			if (idx >= 0) cur.splice(idx, 1);
			if (cur.length === 0) this.sinks.delete(correlationId);
		};
	}

	emit(frame: DispatchEventFrame): void {
		const list = this.sinks.get(frame.correlationId);
		if (!list) return;
		// Snapshot the array so a sink that unsubscribes mid-emit doesn't
		// shift the iteration.
		for (const sink of [...list]) {
			try {
				sink(frame);
			} catch {
				// Best-effort fan-out; don't let one bad sink blow up the rest.
			}
		}
	}

	clear(): void {
		this.sinks.clear();
	}

	count(correlationId: string): number {
		return this.sinks.get(correlationId)?.length ?? 0;
	}
}

/** Resolves where a dispatch should land. */
function resolveTarget(
	env: DispatchEnvelope,
	registry: SurfaceRegistry,
	originator: SurfaceRegistration,
):
	| { ok: true; targetChannel: DaemonChannel; targetSurfaceId: string | null }
	| { ok: false; reason: string } {
	if (env.targetSurfaceId) {
		const reg = registry.get(env.targetSurfaceId);
		if (!reg) return { ok: false, reason: `target surface ${env.targetSurfaceId} not registered` };
		if (reg.userId !== originator.userId) {
			return { ok: false, reason: "cross-tenant dispatch is forbidden" };
		}
		return { ok: true, targetChannel: reg.channel, targetSurfaceId: reg.surfaceId };
	}

	if (env.targetChannel === "auto") {
		// Pick most-recently-active surface for this user.
		const candidates = registry.byUser(originator.userId);
		if (candidates.length === 0) {
			return { ok: false, reason: "auto-target requested but no surfaces registered for user" };
		}
		candidates.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
		const winner = candidates[0];
		return { ok: true, targetChannel: winner.channel, targetSurfaceId: winner.surfaceId };
	}

	// Explicit channel target. We don't require a registered surface on
	// that channel - the daemon is the executor; surfaces are observers.
	return { ok: true, targetChannel: env.targetChannel, targetSurfaceId: null };
}

export interface DispatchRouterDeps {
	registry: SurfaceRegistry;
	ledger: DispatchLedger;
	rateLimiter: DispatchRateLimiter;
	verifier: TokenVerifier;
	executor: DispatchExecutor;
	hub: DispatchHub;
	/** Hook for trace recorder. Receives one record per accepted dispatch. */
	onTrace?: (record: DispatchTraceRecord) => void;
}

export interface DispatchTraceRecord {
	ts: number;
	dispatchId: string;
	correlationId: string;
	dispatchSource: DaemonChannel;
	originatingChannel: DaemonChannel;
	targetChannel: DaemonChannel;
	targetSurfaceId: string | null;
	userId: string;
	capabilityRequired: DispatchCapability;
	intentPreview: string;
	result: "allowed" | "denied";
	reason?: string;
}

export class DispatchRouter {
	constructor(private readonly deps: DispatchRouterDeps) {}

	/**
	 * Validate, authorize, route. On success returns the session that
	 * will execute and the resolved target. On failure returns a
	 * structured error - the route layer turns that into a wire error.
	 */
	async dispatch(env: DispatchEnvelope, fromSurface: SurfaceRegistration): Promise<DispatchResult> {
		const { registry, ledger, rateLimiter, executor, onTrace } = this.deps;

		// 1. Replay protection
		const replay = ledger.check(fromSurface.token, env.dispatchId);
		if (!replay.ok) {
			this.recordTrace({
				env,
				fromSurface,
				targetChannel: env.targetChannel === "auto" ? fromSurface.channel : env.targetChannel,
				targetSurfaceId: env.targetSurfaceId ?? null,
				result: "denied",
				reason: replay.reason,
			});
			return { ok: false, error: replay.reason, code: "replay_detected" };
		}

		// 2. Rate limit
		const rate = rateLimiter.consume(fromSurface.token);
		if (!rate.ok) {
			this.recordTrace({
				env,
				fromSurface,
				targetChannel: env.targetChannel === "auto" ? fromSurface.channel : env.targetChannel,
				targetSurfaceId: env.targetSurfaceId ?? null,
				result: "denied",
				reason: `rate_limited (retry in ${rate.retryAfterMs}ms)`,
			});
			return {
				ok: false,
				error: `rate limit exceeded; retry in ${rate.retryAfterMs}ms`,
				code: "rate_limited",
				retryAfterMs: rate.retryAfterMs,
			};
		}

		// 3. Resolve target
		const target = resolveTarget(env, registry, fromSurface);
		if (!target.ok) {
			this.recordTrace({
				env,
				fromSurface,
				targetChannel: env.targetChannel === "auto" ? fromSurface.channel : env.targetChannel,
				targetSurfaceId: env.targetSurfaceId ?? null,
				result: "denied",
				reason: target.reason,
			});
			return { ok: false, error: target.reason, code: "no_target" };
		}

		// 4. Capability + policy gate
		const policy = evaluateDispatchPolicy({
			fromChannel: fromSurface.channel,
			fromCapabilities: fromSurface.capabilities,
			toChannel: target.targetChannel,
			capabilityRequired: env.capabilityRequired,
			intent: env.intent,
			userId: fromSurface.userId,
		});
		if (!policy.allowed) {
			this.recordTrace({
				env,
				fromSurface,
				targetChannel: target.targetChannel,
				targetSurfaceId: target.targetSurfaceId,
				result: "denied",
				reason: policy.reason ?? "policy denied",
			});
			return {
				ok: false,
				error: policy.reason ?? "policy denied",
				code: policy.requiresApproval ? "capability_denied" : "policy_denied",
			};
		}

		// All gates passed - record dispatch and execute.
		ledger.record(fromSurface.token, env.dispatchId);
		registry.touch(fromSurface.surfaceId);

		this.recordTrace({
			env,
			fromSurface,
			targetChannel: target.targetChannel,
			targetSurfaceId: target.targetSurfaceId,
			result: "allowed",
		});

		const exec = await executor.executeOnChannel(target.targetChannel, env.intent, {
			dispatchId: env.dispatchId,
			correlationId: env.correlationId,
			userId: fromSurface.userId,
		});

		// Notify subscribers that the dispatch was accepted. Per-event
		// streaming flows in via DispatchHub.emit() called from the
		// executor's bus bridge - that lives in the route layer because
		// it's session-bound, not router-bound.
		this.deps.hub.emit({
			type: "dispatch:event",
			dispatchId: env.dispatchId,
			correlationId: env.correlationId,
			originatingChannel: env.originatingChannel,
			targetChannel: target.targetChannel,
			dispatchSource: env.originatingChannel,
			event: {
				kind: "accepted",
				sessionId: exec.sessionId,
				targetSurfaceId: target.targetSurfaceId,
			},
		});

		// Side-channel: notify onTrace caller in case they want a stream.
		if (onTrace) {
			// Already called above via recordTrace.
		}

		return {
			ok: true,
			sessionId: exec.sessionId,
			targetChannel: target.targetChannel,
			targetSurfaceId: target.targetSurfaceId,
			correlationId: env.correlationId,
			dispatchId: env.dispatchId,
		};
	}

	private recordTrace(args: {
		env: DispatchEnvelope;
		fromSurface: SurfaceRegistration;
		targetChannel: DaemonChannel;
		targetSurfaceId: string | null;
		result: "allowed" | "denied";
		reason?: string;
	}): void {
		if (!this.deps.onTrace) return;
		const intentPreview =
			args.env.intent.length > 200 ? `${args.env.intent.slice(0, 200)}...` : args.env.intent;
		this.deps.onTrace({
			ts: Date.now(),
			dispatchId: args.env.dispatchId,
			correlationId: args.env.correlationId,
			dispatchSource: args.env.originatingChannel,
			originatingChannel: args.env.originatingChannel,
			targetChannel: args.targetChannel,
			targetSurfaceId: args.targetSurfaceId,
			userId: args.fromSurface.userId,
			capabilityRequired: args.env.capabilityRequired,
			intentPreview,
			result: args.result,
			reason: args.reason,
		});
	}
}

// ============================================================
// Default config helpers
// ============================================================

/** Resolve or generate the local HMAC secret. */
export function resolveLocalDispatchSecret(): string {
	const fromEnv = process.env.EIGHT_DISPATCH_SECRET;
	if (fromEnv && fromEnv.length >= 16) return fromEnv;
	// Fall back to a random per-process secret. Tokens minted with this
	// secret won't survive a daemon restart, which is the right default
	// for local-only use - long-lived tokens belong in config.
	return crypto.randomBytes(32).toString("hex");
}
