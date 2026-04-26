/**
 * Rate limiter tests. Uses a fake clock so refill behaviour is
 * deterministic.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { RateLimiter } from "../rate-limit";

const limits = {
	free: { requestsPerMinute: 60, tokensPerMinute: 60_000 },
	pro: { requestsPerMinute: 600, tokensPerMinute: 600_000 },
};

describe("RateLimiter", () => {
	let now = 0;
	let limiter: RateLimiter;

	beforeEach(() => {
		now = 1_000_000;
		limiter = new RateLimiter(limits, () => now);
	});

	test("allows the first request and decrements buckets", () => {
		const decision = limiter.checkRequest("tenant_a", "free");
		expect(decision.allowed).toBe(true);
		expect(decision.remainingRequests).toBe(59);
	});

	test("denies once request bucket is empty", () => {
		for (let i = 0; i < 60; i++) limiter.checkRequest("tenant_b", "free");
		const decision = limiter.checkRequest("tenant_b", "free");
		expect(decision.allowed).toBe(false);
		expect(decision.limit).toBe("requests");
		expect(decision.retryAfterSeconds).toBeGreaterThan(0);
	});

	test("refills proportionally with elapsed time", () => {
		for (let i = 0; i < 60; i++) limiter.checkRequest("tenant_c", "free");
		expect(limiter.checkRequest("tenant_c", "free").allowed).toBe(false);
		now += 30_000; // 30s -> +30 request slots at 1 req/s
		const decision = limiter.checkRequest("tenant_c", "free");
		expect(decision.allowed).toBe(true);
	});

	test("denies on token bucket exhaustion", () => {
		const decision = limiter.checkRequest("tenant_d", "free", 70_000);
		expect(decision.allowed).toBe(false);
		expect(decision.limit).toBe("tokens");
	});

	test("plan tier raises caps", () => {
		for (let i = 0; i < 60; i++) limiter.checkRequest("tenant_e", "pro");
		expect(limiter.checkRequest("tenant_e", "pro").allowed).toBe(true);
	});

	test("chargeTokens reconciles real usage vs estimate", () => {
		limiter.checkRequest("tenant_f", "free");
		limiter.chargeTokens("tenant_f", "free", 1024);
		const decision = limiter.checkRequest("tenant_f", "free");
		expect(decision.allowed).toBe(true);
		expect(decision.remainingTokens).toBeLessThan(60_000 - 256);
	});

	test("buckets are isolated per tenant", () => {
		for (let i = 0; i < 60; i++) limiter.checkRequest("tenant_g", "free");
		expect(limiter.checkRequest("tenant_g", "free").allowed).toBe(false);
		expect(limiter.checkRequest("tenant_h", "free").allowed).toBe(true);
	});
});
