/**
 * The 8DK proof: a fake device pairs with the person's consent, its tool is
 * denied until granted, then an agent tool call goes through the real policy
 * engine, crosses the frame link, reaches the device and returns. Revoking
 * denies again. Nothing here mocks packages/permissions.
 */
import { describe, expect, test } from "bun:test";
import { SHADOW_AGENT_SCOPE, addPolicy } from "../../permissions/policy-engine";
import { DeviceToolAdapter, deviceToolName } from "../adapter";
import { CallCorrelator, type DeviceLink, parseDeviceFrame, serveDevice } from "../link";
import { DeviceRegistry } from "../pairing";
import { createFakeLamp } from "./fake-device";

function connect(device: ReturnType<typeof createFakeLamp>["device"]): DeviceLink {
	const correlator = new CallCorrelator((frame) =>
		queueMicrotask(() => deviceSide(JSON.parse(JSON.stringify(frame)))),
	);
	const deviceSide = serveDevice(device, (frame) => {
		const parsed = parseDeviceFrame(JSON.stringify(frame));
		if (parsed) correlator.handle(parsed);
	});
	return correlator;
}

async function setup(id = "desk-lamp", grant: string[] = []) {
	const lamp = createFakeLamp(id);
	const registry = new DeviceRegistry();
	const paired = await registry.pair(lamp.device.manifest, {
		consent: async () => ({ approved: true, grant }),
	});
	if (!paired.ok) throw new Error(paired.reason);
	const links = new Map([[id, connect(lamp.device)]]);
	const adapter = new DeviceToolAdapter(registry, (deviceId) => links.get(deviceId));
	return { lamp, registry, adapter, links };
}

const ctx = { agentId: "main", sessionId: "s_test" };

describe("8DK end to end", () => {
	test("pair -> denied before grant -> granted call reaches the device and returns -> revoked denies", async () => {
		const { lamp, registry, adapter } = await setup();
		const setLight = deviceToolName("desk-lamp", "set_light");
		expect(setLight).toBe("device__desk_lamp__set_light");

		// Paired, nothing granted: the model sees no tool, and calling it by name is denied.
		expect(adapter.toolDefinitions()).toEqual([]);
		const before = await adapter.execute(setLight, { on: true, brightness: 80 }, ctx);
		expect(before.ok).toBe(false);
		if (!before.ok) expect(before.reason).toMatch(/\[8dk-deny\].*not granted/);
		expect(lamp.state.calls).toEqual([]);

		// The person grants it.
		registry.grant("desk-lamp", "set_light");
		const defs = adapter.toolDefinitions() as Array<{
			type: string;
			function: { name: string; parameters: unknown };
		}>;
		expect(defs.map((d) => d.function.name)).toEqual([setLight]);
		expect(defs[0].type).toBe("function");
		expect(defs[0].function.parameters).toEqual({
			type: "object",
			properties: {
				on: { type: "boolean", description: "true for on" },
				brightness: { type: "number", description: "0-100" },
			},
			required: ["on"],
			additionalProperties: false,
		});

		const after = await adapter.execute(setLight, { on: true, brightness: 80 }, ctx);
		expect(after).toEqual({ ok: true, result: { on: true, brightness: 80 } });
		expect(lamp.state).toMatchObject({ on: true, brightness: 80, calls: ["set_light"] });

		// Revoked: denied again, device untouched.
		registry.revoke("desk-lamp", "set_light");
		const revoked = await adapter.execute(setLight, { on: false }, ctx);
		expect(revoked.ok).toBe(false);
		expect(lamp.state.calls).toEqual(["set_light"]);

		// Unpaired: denied as not paired.
		registry.unpair("desk-lamp");
		const unpaired = await adapter.execute(deviceToolName("desk-lamp", "read_light"), {}, ctx);
		expect(unpaired.ok).toBe(false);
		if (!unpaired.ok) expect(unpaired.reason).toMatch(/not paired/);
	});

	test("a shadow candidate cannot use a granted capability (policy engine pre-gate)", async () => {
		const { lamp, adapter } = await setup("shadow-lamp", ["read_light"]);
		const res = await adapter.execute(
			deviceToolName("shadow-lamp", "read_light"),
			{},
			{ agentId: SHADOW_AGENT_SCOPE },
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toMatch(/shadow-deny/);
		expect(lamp.state.calls).toEqual([]);
	});

	test("a YAML-style block or require_approval rule on device_use applies on top of the grant", async () => {
		addPolicy({
			name: "test-block-blocked-lamp",
			action: "device_use",
			condition: "deviceId equals blocked-lamp",
			decision: "block",
			message: "this lamp is blocked",
		});
		addPolicy({
			name: "test-approve-actuators",
			action: "device_use",
			condition: "deviceId equals ask-lamp and capabilityKind equals actuator",
			decision: "require_approval",
			message: "actuators on ask-lamp need a yes",
		});

		const blocked = await setup("blocked-lamp", ["read_light"]);
		const b = await blocked.adapter.execute(deviceToolName("blocked-lamp", "read_light"), {}, ctx);
		expect(b.ok).toBe(false);
		if (!b.ok) expect(b.reason).toMatch(/this lamp is blocked/);

		const ask = await setup("ask-lamp", ["read_light", "set_light"]);
		const read = await ask.adapter.execute(deviceToolName("ask-lamp", "read_light"), {}, ctx);
		expect(read.ok).toBe(true);
		const noApprover = await ask.adapter.execute(
			deviceToolName("ask-lamp", "set_light"),
			{ on: true },
			ctx,
		);
		expect(noApprover.ok).toBe(false);
		if (!noApprover.ok) expect(noApprover.reason).toMatch(/no approver/);
		const approved = await ask.adapter.execute(
			deviceToolName("ask-lamp", "set_light"),
			{ on: true },
			{
				...ctx,
				approve: async () => true,
			},
		);
		expect(approved.ok).toBe(true);
	});

	test("a confirm capability asks the person on every call", async () => {
		const { lamp, adapter } = await setup("strobe-lamp", ["strobe"]);
		const name = deviceToolName("strobe-lamp", "strobe");
		const asks: string[] = [];
		const approve = (answer: boolean) => async (req: { capability: string }) => {
			asks.push(req.capability);
			return answer;
		};
		expect((await adapter.execute(name, {}, ctx)).ok).toBe(false);
		expect((await adapter.execute(name, {}, { ...ctx, approve: approve(false) })).ok).toBe(false);
		expect(await adapter.execute(name, {}, { ...ctx, approve: approve(true) })).toEqual({
			ok: true,
			result: { strobed: true },
		});
		expect(await adapter.execute(name, {}, { ...ctx, approve: approve(true) })).toEqual({
			ok: true,
			result: { strobed: true },
		});
		expect(asks).toEqual(["strobe", "strobe", "strobe"]);
		expect(lamp.state.calls).toEqual(["strobe", "strobe"]);
	});

	test("bad input, unknown tools and offline devices are denied without touching the device", async () => {
		const { lamp, adapter, links } = await setup("io-lamp", ["set_light"]);
		const bad = await adapter.execute(deviceToolName("io-lamp", "set_light"), { on: "yes" }, ctx);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.reason).toMatch(/must be boolean/);
		expect((await adapter.execute("device__io_lamp__fly", {}, ctx)).ok).toBe(false);
		expect((await adapter.execute("not_a_device_tool", {}, ctx)).ok).toBe(false);
		links.delete("io-lamp");
		const offline = await adapter.execute(
			deviceToolName("io-lamp", "set_light"),
			{ on: true },
			ctx,
		);
		expect(offline.ok).toBe(false);
		if (!offline.ok) expect(offline.reason).toMatch(/not connected/);
		expect(lamp.state.calls).toEqual([]);
	});

	test("decisions are reported to an optional hook", async () => {
		const seen: string[] = [];
		const lamp = createFakeLamp("hook-lamp");
		const registry = new DeviceRegistry();
		await registry.pair(lamp.device.manifest, {
			consent: async () => ({ approved: true, grant: ["read_light"] }),
		});
		const link = connect(lamp.device);
		const adapter = new DeviceToolAdapter(registry, () => link, {
			onDecision: (d) => seen.push(`${d.tool}:${d.allowed ? "allow" : "deny"}`),
		});
		await adapter.execute(deviceToolName("hook-lamp", "read_light"), {}, ctx);
		await adapter.execute(deviceToolName("hook-lamp", "set_light"), { on: true }, ctx);
		expect(seen).toEqual([
			"device__hook_lamp__read_light:allow",
			"device__hook_lamp__set_light:deny",
		]);
	});
});

describe("state is re-read after the approval prompt (8SO F1)", () => {
	const strobe = (id: string) => deviceToolName(id, "strobe");

	test("revoke during the confirm prompt denies, and the device is never called", async () => {
		const { lamp, registry, adapter } = await setup("revoke-lamp", ["strobe"]);
		const res = await adapter.execute(
			strobe("revoke-lamp"),
			{},
			{
				...ctx,
				approve: async () => {
					registry.revoke("revoke-lamp", "strobe");
					return true;
				},
			},
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toMatch(/\[8dk-deny\].*revoked before the call/);
		expect(lamp.state.calls).toEqual([]);
	});

	test("unpair during the confirm prompt denies, and the device is never called", async () => {
		const { lamp, registry, adapter } = await setup("unpair-lamp", ["strobe"]);
		const res = await adapter.execute(
			strobe("unpair-lamp"),
			{},
			{
				...ctx,
				approve: async () => {
					registry.unpair("unpair-lamp");
					return true;
				},
			},
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toMatch(/\[8dk-deny\].*unpaired or paired again/);
		expect(lamp.state.calls).toEqual([]);
	});

	test("re-pair during the confirm prompt denies, even with the same grant", async () => {
		const { lamp, registry, adapter } = await setup("repair-lamp", ["strobe"]);
		const res = await adapter.execute(
			strobe("repair-lamp"),
			{},
			{
				...ctx,
				approve: async () => {
					const again = await registry.pair(lamp.device.manifest, {
						consent: async () => ({ approved: true, grant: ["strobe"] }),
					});
					expect(again.ok).toBe(true);
					expect(registry.isGranted("repair-lamp", "strobe")).toBe(true);
					return true;
				},
			},
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toMatch(/\[8dk-deny\].*unpaired or paired again/);
		expect(lamp.state.calls).toEqual([]);
	});

	test("revoke during a require_approval prompt denies too", async () => {
		addPolicy({
			name: "test-approve-toctou-lamp",
			action: "device_use",
			condition: "deviceId equals toctou-lamp",
			decision: "require_approval",
			message: "toctou-lamp needs a yes",
		});
		const { lamp, registry, adapter } = await setup("toctou-lamp", ["set_light"]);
		const res = await adapter.execute(
			deviceToolName("toctou-lamp", "set_light"),
			{ on: true },
			{
				...ctx,
				approve: async () => {
					registry.revoke("toctou-lamp", "set_light");
					return true;
				},
			},
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toMatch(/revoked before the call/);
		expect(lamp.state.calls).toEqual([]);
	});
});

describe("the person approves exactly what is sent (8SO F4)", () => {
	addPolicy({
		name: "test-approve-vet-lamp",
		action: "device_use",
		condition: "deviceId equals vet-lamp",
		decision: "require_approval",
		message: "vet-lamp needs a yes",
	});
	const setLight = deviceToolName("vet-lamp", "set_light");

	test("invalid input is refused before anyone is asked", async () => {
		const { lamp, adapter } = await setup("vet-lamp", ["set_light"]);
		const asked: unknown[] = [];
		const approve = async (req: { input: unknown }) => {
			asked.push(req.input);
			return true;
		};
		for (const input of [
			{ on: "yes" },
			{ on: true, colour: "red" },
			{ on: true, constructor: "x" },
			JSON.parse('{"on":true,"__proto__":{"polluted":1}}'),
			{},
		]) {
			const res = await adapter.execute(setLight, input, { ...ctx, approve });
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.reason).toMatch(/^\[8dk-deny\]/);
		}
		const fn = await adapter.execute(setLight, { on: true, cb: () => 1 } as never, {
			...ctx,
			approve,
		});
		expect(fn).toEqual({ ok: false, reason: "[8dk-deny] input must be plain data" });
		expect(asked).toEqual([]);
		expect(lamp.state.calls).toEqual([]);
	});

	test("the approver sees a validated copy, and changing the original after the call starts changes nothing", async () => {
		const { lamp, adapter } = await setup("vet-lamp", ["set_light"]);
		const original: Record<string, unknown> = { on: true, brightness: 80 };
		let seen: unknown;
		const res = await adapter.execute(setLight, original, {
			...ctx,
			approve: async (req) => {
				seen = req.input;
				// The caller still holds the reference and changes it while the prompt is open.
				original.on = false;
				original.brightness = 5;
				return true;
			},
		});
		expect(seen).not.toBe(original);
		expect(seen).toEqual({ on: true, brightness: 80 });
		expect(Object.isFrozen(seen)).toBe(true);
		expect(res).toEqual({ ok: true, result: { on: true, brightness: 80 } });
		expect(lamp.state).toMatchObject({ on: true, brightness: 80, calls: ["set_light"] });
	});

	test("an approver cannot rewrite what it approved", async () => {
		const { lamp, adapter } = await setup("vet-lamp", ["set_light"]);
		const res = await adapter.execute(
			setLight,
			{ on: true },
			{
				...ctx,
				approve: async (req) => {
					(req.input as Record<string, unknown>).on = false;
					return true;
				},
			},
		);
		// Strict-mode write to a frozen object throws, the approval rejects, and the call is denied.
		expect(res.ok).toBe(false);
		expect(lamp.state.calls).toEqual([]);
	});
});
