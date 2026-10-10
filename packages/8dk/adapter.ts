/**
 * 8DK capability -> agent tool adapter.
 *
 * Every granted capability becomes one tool in the packages/eight/tools.ts
 * function shape. Ungranted capabilities are not listed, and are denied if the
 * model names them anyway. The execute path mirrors
 * packages/daemon/tools/hands.ts: decide, ask when the policy says so, then
 * dispatch. The input is deep-copied on entry, and only that copy is checked,
 * shown and sent. Gates, in order:
 *   1. the tool name resolves to a paired device and a real capability
 *   2. the person granted that capability (8DK hard gate; no YAML rule lifts it)
 *   3. evaluatePolicy("device_use"): shadow hard-deny, YAML block / require_approval
 *   4. the input copy matches the capability's params (a person only ever
 *      approves a well-formed request)
 *   5. require_approval, or a `confirm` capability, asks the person
 *   6. after any wait: the device is still the same pairing and still granted
 *   7. the device is connected and answers in time
 */
import { evaluatePolicy } from "../permissions/policy-engine";
import type { DeviceLink } from "./link";
import { validateInput } from "./manifest";
import type { DeviceRegistry } from "./pairing";

export const DEVICE_POLICY_ACTION = "device_use";
const PREFIX = "device__";

export interface DeviceToolCtx {
	agentId?: string;
	sessionId?: string;
	/** Asks the person. Missing approver means no. */
	approve?: (req: {
		tool: string;
		deviceId: string;
		capability: string;
		input: unknown;
		reason: string;
	}) => Promise<boolean>;
	timeoutMs?: number;
}

export interface DeviceDecision {
	tool: string;
	deviceId: string | null;
	capability: string | null;
	allowed: boolean;
	reason: string;
	agentId: string | null;
	sessionId: string | null;
}

export interface AdapterOptions {
	/** Called once per execute with the outcome. Audit-chain wiring is a follow-up. */
	onDecision?: (d: DeviceDecision) => void;
}

export type DeviceToolResult = { ok: true; result: unknown } | { ok: false; reason: string };

/** device__<id with "-" as "_">__<capability>. Unambiguous: ids have no "_", capabilities no "__". */
export function deviceToolName(deviceId: string, capability: string): string {
	return `${PREFIX}${deviceId.replace(/-/g, "_")}__${capability}`;
}

export function parseDeviceToolName(tool: string): { deviceId: string; capability: string } | null {
	if (!tool.startsWith(PREFIX)) return null;
	const rest = tool.slice(PREFIX.length);
	const sep = rest.indexOf("__");
	if (sep <= 0 || sep === rest.length - 2) return null;
	return { deviceId: rest.slice(0, sep).replace(/_/g, "-"), capability: rest.slice(sep + 2) };
}

export class DeviceToolAdapter {
	constructor(
		private registry: DeviceRegistry,
		private linkFor: (deviceId: string) => DeviceLink | undefined,
		private options: AdapterOptions = {},
	) {}

	/** Tool definitions for the model: granted capabilities of paired devices only. */
	toolDefinitions(): object[] {
		const defs: object[] = [];
		for (const device of this.registry.list()) {
			const m = device.manifest;
			for (const cap of m.capabilities) {
				if (!device.grants.has(cap.name)) continue;
				const properties: Record<string, object> = {};
				const required: string[] = [];
				for (const [key, spec] of Object.entries(cap.params ?? {})) {
					properties[key] = {
						type: spec.type,
						...(spec.description ? { description: spec.description } : {}),
					};
					if (spec.required) required.push(key);
				}
				defs.push({
					type: "function",
					function: {
						name: deviceToolName(m.id, cap.name),
						description: `[DEVICE ${m.name} (${m.kind}) ${cap.kind}] ${cap.description}`,
						parameters: { type: "object", properties, required, additionalProperties: false },
					},
				});
			}
		}
		return defs;
	}

	async execute(
		tool: string,
		input: Record<string, unknown>,
		ctx: DeviceToolCtx = {},
	): Promise<DeviceToolResult> {
		// Copy first: nothing the caller does to `input` after this line reaches
		// the approver or the device.
		let safe: Record<string, unknown> | undefined;
		try {
			safe = structuredClone(input);
		} catch {
			safe = undefined;
		}
		const parsed = parseDeviceToolName(tool);
		const finish = (allowed: boolean, reason: string) => {
			this.options.onDecision?.({
				tool,
				deviceId: parsed?.deviceId ?? null,
				capability: parsed?.capability ?? null,
				allowed,
				reason,
				agentId: ctx.agentId ?? null,
				sessionId: ctx.sessionId ?? null,
			});
		};
		const deny = (reason: string): DeviceToolResult => {
			finish(false, reason);
			return { ok: false, reason };
		};

		if (!parsed) return deny(`[8dk-deny] "${tool}" is not a device tool`);
		const { deviceId, capability } = parsed;
		const device = this.registry.get(deviceId);
		if (!device) return deny(`[8dk-deny] device "${deviceId}" is not paired`);
		const cap = device.manifest.capabilities.find((c) => c.name === capability);
		if (!cap) return deny(`[8dk-deny] device "${deviceId}" has no capability "${capability}"`);
		if (!this.registry.isGranted(deviceId, capability)) {
			return deny(`[8dk-deny] capability "${capability}" on "${deviceId}" is not granted`);
		}

		const decision = evaluatePolicy(DEVICE_POLICY_ACTION, {
			agentId: ctx.agentId,
			sessionId: ctx.sessionId,
			deviceId,
			capability,
			capabilityKind: cap.kind,
		});
		if (!decision.allowed && !decision.requiresApproval) {
			return deny(`[policy] ${decision.reason}`);
		}

		if (safe === undefined) return deny("[8dk-deny] input must be plain data");
		const bad = validateInput(cap, safe);
		if (bad) return deny(`[8dk-deny] ${bad}`);
		// Validated values are primitives, so a shallow freeze makes the copy final.
		const checked = Object.freeze(safe);

		const ask = async (reason: string): Promise<string | null> => {
			if (!ctx.approve) return `[policy] ${reason} (no approver wired)`;
			const yes = await ctx
				.approve({ tool, deviceId, capability, input: checked, reason })
				.catch(() => false);
			return yes ? null : `[policy] the person said no: ${reason}`;
		};
		if (!decision.allowed) {
			const refused = await ask(decision.reason ?? "approval required");
			if (refused) return deny(refused);
		} else if (cap.confirm) {
			const refused = await ask(`"${capability}" on ${device.manifest.name} asks every time`);
			if (refused) return deny(refused);
		}

		// An approval can sit open for minutes. Re-read the pairing and the grant
		// after the last await: an unpair, a re-pair (a new PairedDevice) or a
		// revoke during the prompt denies the call.
		if (this.registry.get(deviceId) !== device) {
			return deny(`[8dk-deny] device "${deviceId}" was unpaired or paired again before the call`);
		}
		if (!this.registry.isGranted(deviceId, capability)) {
			return deny(
				`[8dk-deny] capability "${capability}" on "${deviceId}" was revoked before the call`,
			);
		}

		const link = this.linkFor(deviceId);
		if (!link) return deny(`[8dk-deny] device "${deviceId}" is not connected`);
		const res = await link.invoke(capability, checked, ctx.timeoutMs ?? 10_000);
		if (!res.ok) {
			finish(true, `device error: ${res.error}`);
			return { ok: false, reason: `device error: ${res.error}` };
		}
		finish(true, "allowed");
		return { ok: true, result: res.result };
	}
}
