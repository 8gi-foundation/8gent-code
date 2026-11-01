/**
 * perception-tier tests per spec §4.2 / §8.4:
 *   - Local providers bypass the gate
 *   - Remote providers without grant -> blocked
 *   - "session" grant matches sessionId, scoped
 *   - "app" grant matches bundle id
 *   - "once" grant consumes after first use
 *   - revoke clears grants
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	checkPerceptionRemote,
	grantPerceptionRemote,
	isRemoteProvider,
	resetPerceptionTier,
	revokePerceptionRemote,
} from "./perception-tier.js";

afterEach(() => resetPerceptionTier());

describe("isRemoteProvider", () => {
	it("local providers are not remote", () => {
		expect(isRemoteProvider("8gent")).toBe(false);
		expect(isRemoteProvider("ollama")).toBe(false);
		expect(isRemoteProvider("apfel")).toBe(false);
		expect(isRemoteProvider("apple-foundation")).toBe(false);
		expect(isRemoteProvider("lm-studio")).toBe(false);
	});

	it("anything else is remote", () => {
		expect(isRemoteProvider("openrouter")).toBe(true);
		expect(isRemoteProvider("groq")).toBe(true);
		expect(isRemoteProvider("any-future-provider")).toBe(true);
	});
});

describe("checkPerceptionRemote — local providers", () => {
	it("ok without grant when provider is local", () => {
		const r = checkPerceptionRemote({
			sessionId: "s1",
			provider: "ollama",
			calledFrom: "eyes.describe",
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.mode).toBe("local");
	});
});

describe("checkPerceptionRemote — remote providers", () => {
	it("blocked when no grant", () => {
		const r = checkPerceptionRemote({
			sessionId: "s1",
			provider: "openrouter",
			calledFrom: "eyes.describe",
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("perception:remote");
	});

	it("session grant matches sessionId", () => {
		grantPerceptionRemote("session", { sessionId: "s1" });
		const allow = checkPerceptionRemote({
			sessionId: "s1",
			provider: "openrouter",
			calledFrom: "eyes.describe",
		});
		expect(allow.ok).toBe(true);
		if (allow.ok) expect(allow.mode).toBe("remote-granted");

		const deny = checkPerceptionRemote({
			sessionId: "other",
			provider: "openrouter",
			calledFrom: "eyes.describe",
		});
		expect(deny.ok).toBe(false);
	});

	it("app grant matches bundle id", () => {
		grantPerceptionRemote("app", { app: "com.acme.editor" });
		const allow = checkPerceptionRemote({
			app: "com.acme.editor",
			provider: "openrouter",
			calledFrom: "eyes.describe",
		});
		expect(allow.ok).toBe(true);

		const deny = checkPerceptionRemote({
			app: "com.other.app",
			provider: "openrouter",
			calledFrom: "eyes.describe",
		});
		expect(deny.ok).toBe(false);
	});

	it("once grant consumes after first use", () => {
		grantPerceptionRemote("once");
		const first = checkPerceptionRemote({
			provider: "openrouter",
			calledFrom: "eyes.describe",
		});
		expect(first.ok).toBe(true);

		const second = checkPerceptionRemote({
			provider: "openrouter",
			calledFrom: "eyes.describe",
		});
		expect(second.ok).toBe(false);
	});

	it("app grant requires opts.app", () => {
		expect(() => grantPerceptionRemote("app")).toThrow();
	});
});

describe("revokePerceptionRemote", () => {
	it("drops matching grants", () => {
		grantPerceptionRemote("session", { sessionId: "s1" });
		grantPerceptionRemote("session", { sessionId: "s2" });
		const dropped = revokePerceptionRemote({ sessionId: "s1" });
		expect(dropped).toBe(1);

		const r1 = checkPerceptionRemote({
			sessionId: "s1",
			provider: "openrouter",
			calledFrom: "eyes.describe",
		});
		expect(r1.ok).toBe(false);

		const r2 = checkPerceptionRemote({
			sessionId: "s2",
			provider: "openrouter",
			calledFrom: "eyes.describe",
		});
		expect(r2.ok).toBe(true);
	});
});
