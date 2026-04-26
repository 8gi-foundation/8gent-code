/**
 * @8gent/g8way - Per-tenant rate limiter (token bucket).
 *
 * Two buckets per tenant:
 *   - request bucket  -> caps RPS so a single tenant can't flood the proxy
 *   - token bucket    -> caps prompt+completion tokens/minute (real cost)
 *
 * Both refill linearly. Buckets live in process memory; this is a single-node
 * limiter and that's fine for the Hetzner box. When we shard, swap the
 * Map for a Redis SCRIPT or move to a sidecar limiter - the surface stays
 * the same.
 */

import type { RateLimitConfig } from "./types";

interface Bucket {
	tokens: number;
	capacity: number;
	refillPerSecond: number;
	updatedAtMs: number;
}

function makeBucket(capacity: number, perMinute: number, now: number): Bucket {
	return {
		tokens: capacity,
		capacity,
		refillPerSecond: perMinute / 60,
		updatedAtMs: now,
	};
}

function refill(bucket: Bucket, now: number): void {
	const elapsed = (now - bucket.updatedAtMs) / 1000;
	if (elapsed <= 0) return;
	bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerSecond);
	bucket.updatedAtMs = now;
}

interface TenantBuckets {
	requests: Bucket;
	tokens: Bucket;
}

export interface RateLimitDecision {
	allowed: boolean;
	limit: "requests" | "tokens" | null;
	retryAfterSeconds: number;
	remainingRequests: number;
	remainingTokens: number;
}

export class RateLimiter {
	private buckets = new Map<string, TenantBuckets>();
	private now: () => number;

	constructor(
		private limits: Record<string, RateLimitConfig>,
		now?: () => number,
	) {
		this.now = now ?? (() => Date.now());
	}

	private getBuckets(tenantId: string, plan: string): TenantBuckets {
		const existing = this.buckets.get(tenantId);
		if (existing) return existing;
		const cfg = this.limits[plan] ?? this.limits.free;
		if (!cfg) {
			throw new Error("g8way: no rate limit config for plan and no 'free' fallback");
		}
		const t = this.now();
		const buckets: TenantBuckets = {
			requests: makeBucket(cfg.requestsPerMinute, cfg.requestsPerMinute, t),
			tokens: makeBucket(cfg.tokensPerMinute, cfg.tokensPerMinute, t),
		};
		this.buckets.set(tenantId, buckets);
		return buckets;
	}

	/**
	 * Reserve one request slot. Token cost is unknown at request time so
	 * we charge a small estimate (256) up front to keep runaway streams
	 * from outpacing the limiter; the real total is accounted via
	 * `chargeTokens()` after the upstream call returns.
	 */
	checkRequest(
		tenantId: string,
		plan: string,
		estimatedTokens = 256,
	): RateLimitDecision {
		const t = this.now();
		const buckets = this.getBuckets(tenantId, plan);
		refill(buckets.requests, t);
		refill(buckets.tokens, t);

		if (buckets.requests.tokens < 1) {
			const need = 1 - buckets.requests.tokens;
			return {
				allowed: false,
				limit: "requests",
				retryAfterSeconds: Math.ceil(need / buckets.requests.refillPerSecond),
				remainingRequests: 0,
				remainingTokens: Math.floor(buckets.tokens.tokens),
			};
		}
		if (buckets.tokens.tokens < estimatedTokens) {
			const need = estimatedTokens - buckets.tokens.tokens;
			return {
				allowed: false,
				limit: "tokens",
				retryAfterSeconds: Math.ceil(need / buckets.tokens.refillPerSecond),
				remainingRequests: Math.floor(buckets.requests.tokens),
				remainingTokens: Math.floor(buckets.tokens.tokens),
			};
		}

		buckets.requests.tokens -= 1;
		buckets.tokens.tokens -= estimatedTokens;
		return {
			allowed: true,
			limit: null,
			retryAfterSeconds: 0,
			remainingRequests: Math.floor(buckets.requests.tokens),
			remainingTokens: Math.floor(buckets.tokens.tokens),
		};
	}

	/**
	 * Reconcile the token bucket after we know the true upstream usage.
	 * Subtracts the delta vs the up-front estimate (which can be negative
	 * if the request used fewer tokens than estimated, refunding the
	 * tenant).
	 */
	chargeTokens(
		tenantId: string,
		plan: string,
		actualTokens: number,
		estimatedTokens = 256,
	): void {
		const buckets = this.getBuckets(tenantId, plan);
		const delta = actualTokens - estimatedTokens;
		buckets.tokens.tokens = Math.max(
			-buckets.tokens.capacity,
			Math.min(buckets.tokens.capacity, buckets.tokens.tokens - delta),
		);
	}

	/** Test helper - drop all state. */
	reset(): void {
		this.buckets.clear();
	}
}
