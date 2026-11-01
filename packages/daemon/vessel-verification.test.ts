/**
 * Vessel Verification Tests
 *
 * Tests for the vessel identity and trust verification system.
 *
 * Run: bun test packages/daemon/vessel-verification.test.ts
 */

import { describe, expect, it, beforeEach } from "bun:test";
import {
	VesselVerification,
	TrustChainVerifier,
	VERIFICATION_LEVEL,
	VERIFICATION_STATUS,
	type VesselIdentity,
} from "./vessel-verification";

describe("VesselVerification", () => {
	let verification: VesselVerification;

	const createTestIdentity = (overrides?: Partial<VesselIdentity>): VesselIdentity => ({
		vesselId: "vessel_test_001",
		surfaceId: "surface_iphone",
		ownerId: "user_james",
		instanceHash: "abc123def456",
		capabilities: ["read", "write", "dispatch"],
		autonomyRung: 2,
		createdAt: Date.now(),
		lastVerifiedAt: 0,
		metadata: {},
		...overrides,
	});

	beforeEach(() => {
		verification = new VesselVerification();
	});

	describe("Registration", () => {
		it("registers a new vessel", () => {
			const identity = createTestIdentity();
			verification.register(identity);

			const record = verification.getVessel(identity.vesselId);
			expect(record).toBeDefined();
			expect(record?.identity.vesselId).toBe(identity.vesselId);
		});

		it("starts as unverified", () => {
			const identity = createTestIdentity();
			verification.register(identity);

			const record = verification.getVessel(identity.vesselId);
			expect(record?.verificationStatus).toBe(VERIFICATION_STATUS.UNVERIFIED);
			expect(record?.verificationLevel).toBe(VERIFICATION_LEVEL.NONE);
		});
	});

	describe("Challenge Flow", () => {
		it("creates a challenge", () => {
			const identity = createTestIdentity();
			verification.register(identity);

			const challenge = verification.createChallenge(identity.vesselId);
			expect(challenge).toBeDefined();
			expect(challenge?.challengeId).toMatch(/^ch_/);
			expect(challenge?.challenge.length).toBe(32);
		});

		it("fails for unknown vessel", () => {
			const challenge = verification.createChallenge("unknown");
			expect(challenge).toBeNull();
		});

		it("verifies with correct response", () => {
			const identity = createTestIdentity();
			verification.register(identity);

			const challenge = verification.createChallenge(identity.vesselId);
			expect(challenge).not.toBeNull();

			// Compute expected response (same hash function used internally)
			let hash = 0;
			for (let i = 0; i < challenge!.challenge.length; i++) {
				const char = challenge!.challenge.charCodeAt(i);
				hash = (hash << 5) - hash + char;
				hash = hash & hash;
			}
			const expectedResponse = Math.abs(hash).toString(36);

			const result = verification.verifyWithChallenge(
				identity.vesselId,
				challenge!.challengeId,
				expectedResponse,
			);

			expect(result.success).toBe(true);
			expect(result.level).toBe(VERIFICATION_LEVEL.FULL);
			expect(result.status).toBe(VERIFICATION_STATUS.VERIFIED);
		});

		it("fails with wrong response", () => {
			const identity = createTestIdentity();
			verification.register(identity);

			const challenge = verification.createChallenge(identity.vesselId);
			const result = verification.verifyWithChallenge(
				identity.vesselId,
				challenge!.challengeId,
				"wrong_response",
			);

			expect(result.success).toBe(false);
			expect(result.errors[0]).toContain("Invalid response");
		});

		it("fails with expired challenge", () => {
			const identity = createTestIdentity();
			verification.register(identity);

			const challenge = verification.createChallenge(identity.vesselId);

			// Manually expire the challenge
			const record = verification.getVessel(identity.vesselId);
			const challengeRecord = record?.challengeHistory[0];
			if (challengeRecord) {
				challengeRecord.expiresAt = Date.now() - 1000;
			}

			const result = verification.verifyWithChallenge(
				identity.vesselId,
				challenge!.challengeId,
				"any_response",
			);

			expect(result.success).toBe(false);
			expect(result.errors[0]).toContain("expired");
		});

		it("locks after max failed attempts", () => {
			const identity = createTestIdentity();
			verification.register(identity);

			const challenge = verification.createChallenge(identity.vesselId);

			// Fail 5 times
			for (let i = 0; i < 5; i++) {
				verification.verifyWithChallenge(
					identity.vesselId,
					challenge!.challengeId,
					"wrong",
				);
			}

			// Should be locked - next challenge returns null
			const newChallenge = verification.createChallenge(identity.vesselId);
			expect(newChallenge).toBeNull();

			const record = verification.getVessel(identity.vesselId);
			expect(record?.verificationStatus).toBe(VERIFICATION_STATUS.FAILED);
		});
	});

	describe("Quick Verification", () => {
		it("verifies with token and surface match", () => {
			const identity = createTestIdentity();
			verification.register(identity);

			const result = verification.verifyQuick(
				identity.vesselId,
				"valid_token_12345",
				identity.surfaceId,
			);

			expect(result.success).toBe(true);
			expect(result.level).toBe(VERIFICATION_LEVEL.MODERATE);
		});

		it("fails with wrong surface", () => {
			const identity = createTestIdentity();
			verification.register(identity);

			const result = verification.verifyQuick(
				identity.vesselId,
				"valid_token_12345",
				"wrong_surface",
			);

			expect(result.success).toBe(false);
			expect(result.errors[0]).toContain("Surface ID mismatch");
		});

		it("fails with invalid token", () => {
			const identity = createTestIdentity();
			verification.register(identity);

			const result = verification.verifyQuick(
				identity.vesselId,
				"short",
				identity.surfaceId,
			);

			expect(result.success).toBe(false);
		});
	});

	describe("Verification Status", () => {
		it("isVerified returns true for verified vessel", () => {
			const identity = createTestIdentity();
			verification.register(identity);

			const challenge = verification.createChallenge(identity.vesselId);
			let hash = 0;
			for (let i = 0; i < challenge!.challenge.length; i++) {
				hash = (hash << 5) - hash + challenge!.challenge.charCodeAt(i);
				hash = hash & hash;
			}
			const response = Math.abs(hash).toString(36);

			verification.verifyWithChallenge(
				identity.vesselId,
				challenge!.challengeId,
				response,
			);

			expect(verification.isVerified(identity.vesselId)).toBe(true);
			expect(verification.isVerified(identity.vesselId, VERIFICATION_LEVEL.FULL)).toBe(true);
		});

		it("isVerified returns false for unverified vessel", () => {
			const identity = createTestIdentity();
			verification.register(identity);

			expect(verification.isVerified(identity.vesselId)).toBe(false);
		});

		it("revokes verification", () => {
			const identity = createTestIdentity();
			verification.register(identity);

			// Quick verify first
			verification.verifyQuick(identity.vesselId, "token_1234567890", identity.surfaceId);

			// Revoke
			const revoked = verification.revoke(identity.vesselId);
			expect(revoked).toBe(true);

			const record = verification.getVessel(identity.vesselId);
			expect(record?.verificationStatus).toBe(VERIFICATION_STATUS.FAILED);
		});
	});

	describe("Vessel Management", () => {
		it("lists all vessels", () => {
			verification.register(createTestIdentity({ vesselId: "v1" }));
			verification.register(createTestIdentity({ vesselId: "v2" }));

			const vessels = verification.listVessels();
			expect(vessels).toHaveLength(2);
		});

		it("lists vessels by owner", () => {
			verification.register(createTestIdentity({ vesselId: "v1", ownerId: "user_1" }));
			verification.register(createTestIdentity({ vesselId: "v2", ownerId: "user_2" }));
			verification.register(createTestIdentity({ vesselId: "v3", ownerId: "user_1" }));

			const user1Vessels = verification.byOwner("user_1");
			expect(user1Vessels).toHaveLength(2);
		});

		it("unregisters vessel", () => {
			const identity = createTestIdentity();
			verification.register(identity);
			verification.unregister(identity.vesselId);

			expect(verification.getVessel(identity.vesselId)).toBeUndefined();
		});
	});
});

describe("TrustChainVerifier", () => {
	let verifier: TrustChainVerifier;

	beforeEach(() => {
		verifier = new TrustChainVerifier();
	});

	it("starts empty and invalid", () => {
		expect(verifier.verify()).toBe(false);
		expect(verifier.getChain()).toHaveLength(0);
	});

	it("adds links to chain", () => {
		verifier.addLink({
			actorId: "user_james",
			role: "owner",
			action: "authorize",
			signature: "sig_abc123def456",
		});

		expect(verifier.getChain()).toHaveLength(1);
	});

	it("verifies valid chain starting with owner", () => {
		verifier.addLink({
			actorId: "user_james",
			role: "owner",
			action: "authorize",
			signature: "sig_abc123def456",
		});

		verifier.addLink({
			actorId: "vessel_001",
			role: "vessel",
			action: "execute",
			signature: "sig_vessel_001",
		});

		expect(verifier.verify()).toBe(true);
	});

	it("fails chain not starting with owner", () => {
		verifier.addLink({
			actorId: "vessel_001",
			role: "vessel",
			action: "execute",
			signature: "sig_vessel_001",
		});

		expect(verifier.verify()).toBe(false);
	});

	it("fails chain with missing signatures", () => {
		verifier.addLink({
			actorId: "user_james",
			role: "owner",
			action: "authorize",
			signature: "sig_abc123def456",
		});

		verifier.addLink({
			actorId: "vessel_001",
			role: "vessel",
			action: "execute",
			signature: "", // Invalid
		});

		expect(verifier.verify()).toBe(false);
	});

	it("clears chain", () => {
		verifier.addLink({
			actorId: "user_james",
			role: "owner",
			action: "authorize",
			signature: "sig_abc123def456",
		});

		verifier.clear();
		expect(verifier.getChain()).toHaveLength(0);
	});
});