/**
 * 8DK frames and call correlation.
 *
 * These are the JSON frames a device and a vessel exchange over a WebSocket,
 * after the daemon's own auth frame (docs/specs/DAEMON-PROTOCOL.md). The
 * transport is not here: CallCorrelator takes a `send` function, so the same
 * code runs over a socket, an in-process pipe, or a test. The daemon `/device`
 * route that carries these frames is #3362's follow-up.
 */
import { randomUUID } from "node:crypto";
import type { DeviceDefinition } from "./manifest";

/** Frames a device sends to the vessel. */
export type DeviceFrame =
	| { type: "device:hello"; manifest: unknown }
	| { type: "device:auth"; deviceId: string; token: string }
	| { type: "device:result"; callId: string; ok: boolean; result?: unknown; error?: string }
	| { type: "device:event"; capability: string; data: unknown };

/** Frames the vessel sends to a device. */
export type VesselFrame =
	| { type: "device:pairing"; code: string }
	| { type: "device:paired"; deviceToken: string }
	| { type: "device:invoke"; callId: string; capability: string; input: Record<string, unknown> }
	| { type: "device:revoked"; capability?: string };

export type InvokeResult = { ok: true; result: unknown } | { ok: false; error: string };

/** Anything that can carry a capability call to a device and bring back the answer. */
export interface DeviceLink {
	invoke(
		capability: string,
		input: Record<string, unknown>,
		timeoutMs: number,
	): Promise<InvokeResult>;
}

const str = (v: unknown) => typeof v === "string" && v.length > 0;

/** Parse an untrusted frame from a device. Anything malformed is null. */
export function parseDeviceFrame(raw: unknown): DeviceFrame | null {
	let f: Record<string, unknown>;
	try {
		f = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!f || typeof f !== "object") return null;
	switch (f.type) {
		case "device:hello":
			return f.manifest && typeof f.manifest === "object"
				? { type: f.type, manifest: f.manifest }
				: null;
		case "device:auth":
			return str(f.deviceId) && str(f.token)
				? { type: f.type, deviceId: f.deviceId as string, token: f.token as string }
				: null;
		case "device:result": {
			if (!str(f.callId) || typeof f.ok !== "boolean") return null;
			const frame: DeviceFrame = { type: f.type, callId: f.callId as string, ok: f.ok };
			if ("result" in f) frame.result = f.result;
			if (typeof f.error === "string") frame.error = f.error;
			return frame;
		}
		case "device:event":
			return str(f.capability)
				? { type: f.type, capability: f.capability as string, data: f.data }
				: null;
		default:
			return null;
	}
}

/** Vessel side: sends `device:invoke`, matches `device:result` by callId, times out. */
export class CallCorrelator implements DeviceLink {
	private pending = new Map<string, (r: InvokeResult) => void>();

	constructor(private send: (frame: VesselFrame) => void) {}

	invoke(
		capability: string,
		input: Record<string, unknown>,
		timeoutMs: number,
	): Promise<InvokeResult> {
		const callId = randomUUID();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(callId);
				resolve({ ok: false, error: `device did not answer within ${timeoutMs}ms` });
			}, timeoutMs);
			this.pending.set(callId, (r) => {
				clearTimeout(timer);
				resolve(r);
			});
			try {
				this.send({ type: "device:invoke", callId, capability, input });
			} catch (err) {
				this.pending.get(callId)?.({ ok: false, error: `send failed: ${(err as Error).message}` });
				this.pending.delete(callId);
			}
		});
	}

	/** Feed a parsed device frame in. Returns true when it settled a pending call. */
	handle(frame: DeviceFrame): boolean {
		if (frame.type !== "device:result") return false;
		const settle = this.pending.get(frame.callId);
		if (!settle) return false;
		this.pending.delete(frame.callId);
		settle(
			frame.ok
				? { ok: true, result: frame.result }
				: { ok: false, error: frame.error ?? "device error" },
		);
		return true;
	}
}

/**
 * Device side: answers `device:invoke` frames with the device's handlers.
 * A handler that throws becomes an error result; it never crashes the device loop.
 */
export function serveDevice(device: DeviceDefinition, send: (frame: DeviceFrame) => void) {
	return async (frame: VesselFrame): Promise<void> => {
		if (frame.type !== "device:invoke") return;
		const handler = device.handlers[frame.capability];
		if (!handler) {
			send({
				type: "device:result",
				callId: frame.callId,
				ok: false,
				error: `unknown capability "${frame.capability}"`,
			});
			return;
		}
		try {
			const result = await handler(frame.input);
			send({ type: "device:result", callId: frame.callId, ok: true, result });
		} catch (err) {
			send({
				type: "device:result",
				callId: frame.callId,
				ok: false,
				error: (err as Error).message ?? String(err),
			});
		}
	};
}
