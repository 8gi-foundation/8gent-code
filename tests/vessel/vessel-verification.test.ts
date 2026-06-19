/**
 * Vessel Verification MVP Test
 *
 * The smallest test that proves vessel verification works.
 * Verifies: token mint -> verify -> surface registration -> token validation
 *
 * Run: bun test tests/vessel/vessel-verification.test.ts
 */

import { describe, expect, it } from "bun:test";
import {
	LocalTokenVerifier,
	SurfaceRegistry,
	resolveLocalDispatchSecret,
	type SurfaceRegistration,
} from "../../packages/daemon/dispatch";

const SECRET = resolveLocalDispatchSecret();

describe("Vessel Verification MVP", () => {
	describe("Token lifecycle", () => {
		it("mints a token with vessel claims and verifies it", () => {
			const verifier = new LocalTokenVerifier(SECRET);

			// Vessel presents its identity
			const claims = {
				surfaceId: "iphone_8gent_james",
				channel: "vessel" as const,
				userId: "james_spalding",
				capabilities: ["read", "write", "dispatch"] as const,
			};

			// Mint a token
			const token = verifier.mint(claims);
			expect(token).toBeTruthy();
			expect(token.split(".").length).toBe(2); // body.sig format

			// Verify the token
			const verified = verifier.verify(token);
			expect(verified).not.toBeNull();
			expect(verified!.surfaceId).toBe(claims.surfaceId);
			expect(verified!.channel).toBe(claims.channel);
			expect(verified!.userId).toBe(claims.userId);
			expect(verified!.capabilities).toEqual(claims.capabilities);
		});

		it("rejects tampered tokens", () => {
			const verifier = new LocalTokenVerifier(SECRET);

			const token = verifier.mint({
				surfaceId: "test_vessel",
				channel: "vessel",
				userId: "test_user",
				capabilities: ["read"],
			});

			// Tamper with the body
			const [body, sig] = token.split(".");
			const tampered = `${body}X.${sig}`;
			expect(verifier.verify(tampered)).toBeNull();
		});

		it("rejects tokens signed with wrong secret", () => {
			const verifier1 = new LocalTokenVerifier("secret_one_long_enough_for_hmac");
			const verifier2 = new LocalTokenVerifier("secret_two_long_enough_for_hmac");

			const token = verifier1.mint({
				surfaceId: "test_vessel",
				channel: "vessel",
				userId: "test_user",
				capabilities: ["read"],
			});

			// Different verifier cannot validate
			expect(verifier2.verify(token)).toBeNull();
		});
	});

	describe("Surface registration with token", () => {
		it("registers a vessel and validates its token", () => {
			const verifier = new LocalTokenVerifier(SECRET);
			const registry = new SurfaceRegistry();

			// Step 1: Vessel authenticates and gets a token
			const vesselClaims = {
				surfaceId: "iphone_17_pro_max",
				channel: "vessel" as const,
				userId: "james_spalding",
				capabilities: ["read", "write", "dispatch", "execute"] as const,
			};
			const token = verifier.mint(vesselClaims);

			// Step 2: Vessel registers with the daemon
			const registration: SurfaceRegistration = {
				surfaceId: vesselClaims.surfaceId,
				channel: vesselClaims.channel,
				userId: vesselClaims.userId,
				capabilities: vesselClaims.capabilities,
				token: token,
				registeredAt: Date.now(),
				lastActiveAt: Date.now(),
			};
			registry.register(registration);

			// Step 3: Daemon validates the token on subsequent requests
			expect(registry.validateToken("iphone_17_pro_max", token)).toBe(true);
			expect(registry.validateToken("iphone_17_pro_max", "wrong_token")).toBe(false);
		});

		it("retrieves registered vessel by surfaceId", () => {
			const verifier = new LocalTokenVerifier(SECRET);
			const registry = new SurfaceRegistry();

			// Register a vessel
			const token = verifier.mint({
				surfaceId: "rayban_meta_gen2",
				channel: "vessel",
				userId: "james_spalding",
				capabilities: ["read", "dispatch"],
			});

			registry.register({
				surfaceId: "rayban_meta_gen2",
				channel: "vessel",
				userId: "james_spalding",
				capabilities: ["read", "dispatch"],
				token,
				registeredAt: Date.now(),
				lastActiveAt: Date.now(),
			});

			// Retrieve
			const retrieved = registry.get("rayban_meta_gen2");
			expect(retrieved).toBeDefined();
			expect(retrieved!.surfaceId).toBe("rayban_meta_gen2");
			expect(retrieved!.capabilities).toContain("read");
			expect(retrieved!.capabilities).toContain("dispatch");
		});

		it("unregisters a vessel", () => {
			const verifier = new LocalTokenVerifier(SECRET);
			const registry = new SurfaceRegistry();

			const token = verifier.mint({
				surfaceId: "vessel_to_remove",
				channel: "vessel",
				userId: "james_spalding",
				capabilities: ["read"],
			});

			registry.register({
				surfaceId: "vessel_to_remove",
				channel: "vessel",
				userId: "james_spalding",
				capabilities: ["read"],
				token,
				registeredAt: Date.now(),
				lastActiveAt: Date.now(),
			});

			expect(registry.get("vessel_to_remove")).toBeDefined();

			registry.unregister("vessel_to_remove");
			expect(registry.get("vessel_to_remove")).toBeUndefined();
		});

		it("lists all vessels for a user", () => {
			const verifier = new LocalTokenVerifier(SECRET);
			const registry = new SurfaceRegistry();

			// Register multiple vessels for the same user
			const vessels = [
				{ surfaceId: "iphone_main", channel: "vessel" as const, caps: ["read", "write"] },
				{ surfaceId: "mac_desktop", channel: "vessel" as const, caps: ["read", "write", "execute"] },
				{ surfaceId: "mac_laptop", channel: "vessel" as const, caps: ["read"] },
			];

			for (const v of vessels) {
				const token = verifier.mint({
					surfaceId: v.surfaceId,
					channel: v.channel,
					userId: "james_spalding",
					capabilities: v.caps as any,
				});
				registry.register({
					surfaceId: v.surfaceId,
					channel: v.channel,
					userId: "james_spalding",
					capabilities: v.caps as any,
					token,
					registeredAt: Date.now(),
					lastActiveAt: Date.now(),
				});
			}

			// Query vessels by user
			const userVessels = registry.byUser("james_spalding");
			expect(userVessels.length).toBe(3);
			expect(userVessels.map((v) => v.surfaceId)).toContain("iphone_main");
			expect(userVessels.map((v) => v.surfaceId)).toContain("mac_desktop");
			expect(userVessels.map((v) => v.surfaceId)).toContain("mac_laptop");
		});
	});

	describe("End-to-end verification flow", () => {
		it("complete flow: mint -> verify -> register -> validate -> dispatch", () => {
			const verifier = new LocalTokenVerifier(SECRET);
			const registry = new SurfaceRegistry();

			// 1. Vessel connects and authenticates (e.g., via device flow or shared secret)
			const vesselIdentity = {
				surfaceId: "8gent_ios_v1",
				channel: "vessel" as const,
				userId: "james_spalding",
				capabilities: ["read", "write", "dispatch"] as const,
			};

			// 2. Vessel receives a signed token
			const token = verifier.mint(vesselIdentity);

			// 3. Vessel registers with the daemon using the token
			registry.register({
				...vesselIdentity,
				token,
				registeredAt: Date.now(),
				lastActiveAt: Date.now(),
			});

			// 4. Subsequent requests include the token for validation
			const isValid = registry.validateToken("8gent_ios_v1", token);
			expect(isValid).toBe(true);

			// 5. Vessel can now dispatch commands (verified by capability check)
			const vessel = registry.get("8gent_ios_v1");
			expect(vessel).toBeDefined();
			expect(vessel!.capabilities).toContain("dispatch");
		});
	});
});
