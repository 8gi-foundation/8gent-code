/**
 * Vessel Verification - Identity and Trust for Agents
 *
 * Verifies that a vessel is who it claims to be and that actions
 * are authorized by the owner. Implements the trust framework.
 */

import { AUTONOMY_RUNG, type AutonomyRung } from "./autonomy";

// ============================================
// Verification Types
// ============================================

export const VERIFICATION_LEVEL = {
	NONE: 0,
	SOFT: 1, // Session token match
	MODERATE: 2, // Token + surface ID
	FULL: 3, // Token + surface ID + cryptographic verification
} as const;

export type VerificationLevel =
	(typeof VERIFICATION_LEVEL)[keyof typeof VERIFICATION_LEVEL];

export const VERIFICATION_STATUS = {
	UNVERIFIED: "unverified",
	PENDING: "pending",
	VERIFIED: "verified",
	FAILED: "failed",
	EXPIRED: "expired",
} as const;

export type VerificationStatus =
	(typeof VERIFICATION_STATUS)[keyof typeof VERIFICATION_STATUS];

// ============================================
// Vessel Identity
// ============================================

export interface VesselIdentity {
	vesselId: string; // Unique vessel identifier
	surfaceId: string; // Surface/device identifier
	ownerId: string; // Owner (user) ID
	instanceHash: string; // Cryptographic hash of instance
	capabilities: string[]; // Granted capabilities
	autonomyRung: AutonomyRung;
	createdAt: number;
	lastVerifiedAt: number;
	metadata: Record<string, unknown>;
}

export interface VerificationChallenge {
	challengeId: string;
	vesselId: string;
	challenge: string; // Random challenge string
	expiresAt: number;
	response?: string;
}

export interface VerificationResult {
	success: boolean;
	level: VerificationLevel;
	status: VerificationStatus;
	vesselId: string | null;
	errors: string[];
	timestamp: number;
}

// ============================================
// Verification Store
// ============================================

export interface VesselRecord {
	identity: VesselIdentity;
	verificationLevel: VerificationLevel;
	verificationStatus: VerificationStatus;
	challengeHistory: VerificationChallenge[];
	lastChallengeAt: number | null;
	failedAttempts: number;
	lockedUntil: number | null; // Timestamp when lock expires
}

// ============================================
// Vessel Verification Service
// ============================================

export class VesselVerification {
	private vessels = new Map<string, VesselRecord>();
	private challenges = new Map<string, VerificationChallenge>();
	private readonly MAX_FAILED_ATTEMPTS = 5;
	private readonly LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes
	private readonly CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

	/** Register a new vessel */
	register(identity: VesselIdentity): void {
		const record: VesselRecord = {
			identity,
			verificationLevel: VERIFICATION_LEVEL.NONE,
			verificationStatus: VERIFICATION_STATUS.UNVERIFIED,
			challengeHistory: [],
			lastChallengeAt: null,
			failedAttempts: 0,
			lockedUntil: null,
		};

		this.vessels.set(identity.vesselId, record);
	}

	/** Create a verification challenge */
	createChallenge(vesselId: string): VerificationChallenge | null {
		const record = this.vessels.get(vesselId);
		if (!record) return null;

		// Check if locked
		if (record.lockedUntil && Date.now() < record.lockedUntil) {
			return null;
		}

		const challenge: VerificationChallenge = {
			challengeId: `ch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			vesselId,
			challenge: this.generateChallenge(),
			expiresAt: Date.now() + this.CHALLENGE_TTL_MS,
		};

		this.challenges.set(challenge.challengeId, challenge);
		record.lastChallengeAt = Date.now();
		record.challengeHistory.push(challenge);

		// Keep only last 10 challenges
		if (record.challengeHistory.length > 10) {
			record.challengeHistory.shift();
		}

		return challenge;
	}

	/** Verify a vessel with a response to a challenge */
	verifyWithChallenge(
		vesselId: string,
		challengeId: string,
		response: string,
	): VerificationResult {
		const record = this.vessels.get(vesselId);
		if (!record) {
			return this.failedResult(null, "Vessel not registered");
		}

		// Check if locked
		if (record.lockedUntil && Date.now() < record.lockedUntil) {
			const waitTime = Math.ceil((record.lockedUntil - Date.now()) / 60000);
			return this.failedResult(vesselId, `Vessel locked. Try again in ${waitTime} minutes`);
		}

		const challenge = this.challenges.get(challengeId);
		if (!challenge) {
			return this.failedResult(vesselId, "Challenge not found");
		}

		if (challenge.vesselId !== vesselId) {
			return this.failedResult(vesselId, "Challenge mismatch");
		}

		if (Date.now() > challenge.expiresAt) {
			return this.failedResult(vesselId, "Challenge expired");
		}

		// Verify response (simplified - in production use proper crypto)
		const expectedResponse = this.hashChallenge(challenge.challenge);
		if (response !== expectedResponse) {
			record.failedAttempts++;
			if (record.failedAttempts >= this.MAX_FAILED_ATTEMPTS) {
				record.lockedUntil = Date.now() + this.LOCK_DURATION_MS;
				record.verificationStatus = VERIFICATION_STATUS.FAILED;
			}
			return this.failedResult(vesselId, "Invalid response");
		}

		// Success
		record.verificationStatus = VERIFICATION_STATUS.VERIFIED;
		record.identity.lastVerifiedAt = Date.now();
		record.verificationLevel = VERIFICATION_LEVEL.FULL;
		record.failedAttempts = 0;
		record.lockedUntil = null;

		this.challenges.delete(challengeId);

		return {
			success: true,
			level: VERIFICATION_LEVEL.FULL,
			status: VERIFICATION_STATUS.VERIFIED,
			vesselId,
			errors: [],
			timestamp: Date.now(),
		};
	}

	/** Quick verification (token + surface match only) */
	verifyQuick(
		vesselId: string,
		token: string,
		surfaceId: string,
	): VerificationResult {
		const record = this.vessels.get(vesselId);
		if (!record) {
			return this.failedResult(null, "Vessel not registered");
		}

		if (record.identity.vesselId !== vesselId) {
			return this.failedResult(vesselId, "Vessel ID mismatch");
		}

		if (record.identity.surfaceId !== surfaceId) {
			return this.failedResult(vesselId, "Surface ID mismatch");
		}

		// Token check would be more sophisticated in production
		if (!token || token.length < 10) {
			return this.failedResult(vesselId, "Invalid token");
		}

		record.verificationStatus = VERIFICATION_STATUS.VERIFIED;
		record.identity.lastVerifiedAt = Date.now();
		record.verificationLevel = VERIFICATION_LEVEL.MODERATE;

		return {
			success: true,
			level: VERIFICATION_LEVEL.MODERATE,
			status: VERIFICATION_STATUS.VERIFIED,
			vesselId,
			errors: [],
			timestamp: Date.now(),
		};
	}

	/** Check if vessel is verified at minimum level */
	isVerified(vesselId: string, minLevel: VerificationLevel = VERIFICATION_LEVEL.SOFT): boolean {
		const record = this.vessels.get(vesselId);
		if (!record) return false;
		return record.verificationStatus === VERIFICATION_STATUS.VERIFIED &&
			record.verificationLevel >= minLevel;
	}

	/** Get vessel record */
	getVessel(vesselId: string): VesselRecord | undefined {
		return this.vessels.get(vesselId);
	}

	/** Revoke verification */
	revoke(vesselId: string): boolean {
		const record = this.vessels.get(vesselId);
		if (!record) return false;

		record.verificationStatus = VERIFICATION_STATUS.FAILED;
		record.verificationLevel = VERIFICATION_LEVEL.NONE;
		return true;
	}

	/** Unregister vessel */
	unregister(vesselId: string): boolean {
		return this.vessels.delete(vesselId);
	}

	/** List all vessels */
	listVessels(): VesselRecord[] {
		return Array.from(this.vessels.values());
	}

	/** Get vessels by owner */
	byOwner(ownerId: string): VesselRecord[] {
		return Array.from(this.vessels.values()).filter(
			(v) => v.identity.ownerId === ownerId,
		);
	}

	// ============================================
	// Private helpers
	// ============================================

	private generateChallenge(): string {
		const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
		let result = "";
		for (let i = 0; i < 32; i++) {
			result += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return result;
	}

	private hashChallenge(challenge: string): string {
		// Simplified hash for demo - use proper crypto in production
		let hash = 0;
		for (let i = 0; i < challenge.length; i++) {
			const char = challenge.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash;
		}
		return Math.abs(hash).toString(36);
	}

	private failedResult(vesselId: string | null, error: string): VerificationResult {
		return {
			success: false,
			level: VERIFICATION_LEVEL.NONE,
			status: VERIFICATION_STATUS.FAILED,
			vesselId,
			errors: [error],
			timestamp: Date.now(),
		};
	}
}

// ============================================
// Trust Chain Verification
// ============================================

export interface TrustChainLink {
	actorId: string;
	role: "owner" | "vessel" | "agent" | "user";
	action: string;
	signature: string;
	timestamp: number;
}

export class TrustChainVerifier {
	private chain: TrustChainLink[] = [];

	/** Add a link to the trust chain */
	addLink(link: Omit<TrustChainLink, "timestamp">): void {
		this.chain.push({
			...link,
			timestamp: Date.now(),
		});
	}

	/** Verify the chain is unbroken */
	verify(): boolean {
		if (this.chain.length === 0) return false;

		// First link must be from owner
		const first = this.chain[0];
		if (first.role !== "owner") return false;

		// All links must be properly signed (simplified check)
		for (const link of this.chain) {
			if (!link.signature || link.signature.length < 10) {
				return false;
			}
		}

		return true;
	}

	/** Get the chain */
	getChain(): TrustChainLink[] {
		return [...this.chain];
	}

	/** Clear the chain */
	clear(): void {
		this.chain = [];
	}
}