/**
 * 8DK pairing and grants.
 *
 * A device is paired only when a person says yes. The vessel shows a 6-digit
 * code on the device and in the consent prompt (numeric comparison, as with a
 * Bluetooth passkey), lists every capability, and the person picks which to
 * grant. The default grant set is empty: a paired device can do nothing until
 * the person grants a capability. The registry keeps a SHA-256 of the device
 * token, never the token, and checks grants on every call, never cached.
 *
 * v1 keeps the registry in memory. Persistence to ~/.8gent/devices/ is #3362's
 * follow-up.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
	type CapabilityKind,
	type DeviceManifest,
	manifestDigest,
	validateManifest,
} from "./manifest";

export interface ConsentRequest {
	deviceId: string;
	name: string;
	kind: string;
	/** The code the device is showing. The person checks they match. */
	code: string;
	capabilities: { name: string; kind: CapabilityKind; description: string; confirm: boolean }[];
}

export interface ConsentDecision {
	approved: boolean;
	/** Capabilities the person grants. Omitted means none. */
	grant?: string[];
}

export interface PairOptions {
	consent: (req: ConsentRequest) => Promise<ConsentDecision>;
	/** Sends the code to the device to display (a `device:pairing` frame). */
	showCode?: (code: string) => void;
	/** A prompt nobody answers is a no. Default 2 minutes. */
	consentTimeoutMs?: number;
}

export type PairResult =
	| { ok: true; deviceId: string; token: string }
	| { ok: false; reason: string };

export interface PairedDevice {
	manifest: DeviceManifest;
	digest: string;
	tokenHash: Buffer;
	grants: Set<string>;
	pairedAt: number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

export class DeviceRegistry {
	private devices = new Map<string, PairedDevice>();

	async pair(rawManifest: unknown, opts: PairOptions): Promise<PairResult> {
		let manifest: DeviceManifest;
		try {
			manifest = validateManifest(rawManifest);
		} catch (err) {
			return { ok: false, reason: `invalid manifest: ${(err as Error).message}` };
		}
		const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
		opts.showCode?.(code);

		let decision: ConsentDecision;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			decision = await Promise.race([
				opts.consent({
					deviceId: manifest.id,
					name: manifest.name,
					kind: manifest.kind,
					code,
					capabilities: manifest.capabilities.map((c) => ({
						name: c.name,
						kind: c.kind,
						description: c.description,
						confirm: c.confirm === true,
					})),
				}),
				new Promise<ConsentDecision>((resolve) => {
					timer = setTimeout(() => resolve({ approved: false }), opts.consentTimeoutMs ?? 120_000);
				}),
			]);
		} catch {
			decision = { approved: false };
		} finally {
			clearTimeout(timer);
		}
		if (decision?.approved !== true)
			return { ok: false, reason: "the person did not approve pairing" };

		const names = new Set(manifest.capabilities.map((c) => c.name));
		const grant = decision.grant ?? [];
		const unknown = grant.filter((g) => !names.has(g));
		if (unknown.length)
			return { ok: false, reason: `grant names unknown capability: ${unknown.join(", ")}` };

		const token = randomBytes(32).toString("hex");
		this.devices.set(manifest.id, {
			manifest,
			digest: manifestDigest(manifest),
			tokenHash: sha256(token),
			grants: new Set(grant),
			pairedAt: Date.now(),
		});
		return { ok: true, deviceId: manifest.id, token };
	}

	/** Token check for a reconnecting device. A changed manifest fails: pair again. */
	authenticate(deviceId: string, token: string, manifest?: unknown): boolean {
		const d = this.devices.get(deviceId);
		if (!d || typeof token !== "string") return false;
		if (!timingSafeEqual(sha256(token), d.tokenHash)) return false;
		if (manifest === undefined) return true;
		try {
			return manifestDigest(manifest as DeviceManifest) === d.digest;
		} catch {
			return false;
		}
	}

	get(deviceId: string): PairedDevice | undefined {
		return this.devices.get(deviceId);
	}

	list(): PairedDevice[] {
		return [...this.devices.values()];
	}

	isPaired(deviceId: string): boolean {
		return this.devices.has(deviceId);
	}

	isGranted(deviceId: string, capability: string): boolean {
		return this.devices.get(deviceId)?.grants.has(capability) === true;
	}

	grant(deviceId: string, capability: string): void {
		const d = this.devices.get(deviceId);
		if (!d) throw new Error(`device "${deviceId}" is not paired`);
		if (!d.manifest.capabilities.some((c) => c.name === capability)) {
			throw new Error(`device "${deviceId}" has no capability "${capability}"`);
		}
		d.grants.add(capability);
	}

	revoke(deviceId: string, capability: string): void {
		this.devices.get(deviceId)?.grants.delete(capability);
	}

	unpair(deviceId: string): void {
		this.devices.delete(deviceId);
	}
}
