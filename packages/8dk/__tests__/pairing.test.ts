import { describe, expect, test } from "bun:test";
import { type ConsentRequest, DeviceRegistry } from "../pairing";
import { createFakeLamp } from "./fake-device";

const lamp = () => createFakeLamp().device.manifest;

describe("pairing needs the person's consent", () => {
	test("the person sees the code shown on the device, every capability, and grants a subset", async () => {
		const reg = new DeviceRegistry();
		let shown = "";
		let asked: ConsentRequest | undefined;
		const res = await reg.pair(lamp(), {
			showCode: (code) => {
				shown = code;
			},
			consent: async (req) => {
				asked = req;
				return { approved: true, grant: ["read_light"] };
			},
		});
		expect(res.ok).toBe(true);
		expect(shown).toMatch(/^\d{6}$/);
		expect(asked?.code).toBe(shown);
		expect(asked?.capabilities.map((c) => `${c.name}:${c.kind}`)).toEqual([
			"read_light:sensor",
			"set_light:actuator",
			"strobe:actuator",
		]);
		expect(reg.isGranted("desk-lamp", "read_light")).toBe(true);
		expect(reg.isGranted("desk-lamp", "set_light")).toBe(false);
	});

	test("approval with no grant list grants nothing (deny by default)", async () => {
		const reg = new DeviceRegistry();
		const res = await reg.pair(lamp(), { consent: async () => ({ approved: true }) });
		expect(res.ok).toBe(true);
		expect(reg.get("desk-lamp")?.grants.size).toBe(0);
	});

	test("a declined, failing or slow consent stores nothing", async () => {
		const reg = new DeviceRegistry();
		expect((await reg.pair(lamp(), { consent: async () => ({ approved: false }) })).ok).toBe(false);
		expect(
			(
				await reg.pair(lamp(), {
					consent: async () => {
						throw new Error("prompt crashed");
					},
				})
			).ok,
		).toBe(false);
		const slow = await reg.pair(lamp(), {
			consentTimeoutMs: 20,
			consent: () => new Promise((r) => setTimeout(() => r({ approved: true }), 200)),
		});
		expect(slow.ok).toBe(false);
		expect(reg.isPaired("desk-lamp")).toBe(false);
	});

	test("granting a capability the device does not have fails the pairing", async () => {
		const reg = new DeviceRegistry();
		const res = await reg.pair(lamp(), {
			consent: async () => ({ approved: true, grant: ["fly"] }),
		});
		expect(res.ok).toBe(false);
		expect(reg.isPaired("desk-lamp")).toBe(false);
	});

	test("a malformed manifest never reaches the person", async () => {
		const reg = new DeviceRegistry();
		let asked = false;
		const res = await reg.pair(
			{ id: "x" },
			{
				consent: async () => {
					asked = true;
					return { approved: true };
				},
			},
		);
		expect(res.ok).toBe(false);
		expect(asked).toBe(false);
	});
});

describe("device auth, grants and revocation", () => {
	async function paired() {
		const reg = new DeviceRegistry();
		const res = await reg.pair(lamp(), { consent: async () => ({ approved: true }) });
		if (!res.ok) throw new Error(res.reason);
		return { reg, token: res.token };
	}

	test("the token authenticates, a wrong token or a changed manifest does not", async () => {
		const { reg, token } = await paired();
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(reg.authenticate("desk-lamp", token)).toBe(true);
		expect(reg.authenticate("desk-lamp", "0".repeat(64))).toBe(false);
		expect(reg.authenticate("desk-lamp", "short")).toBe(false);
		expect(reg.authenticate("other", token)).toBe(false);
		const grown = {
			...lamp(),
			capabilities: [...lamp().capabilities, { name: "camera", kind: "sensor", description: "c" }],
		};
		expect(reg.authenticate("desk-lamp", token, grown)).toBe(false);
		expect(reg.authenticate("desk-lamp", token, lamp())).toBe(true);
	});

	test("the registry stores a hash, never the token", async () => {
		const { reg, token } = await paired();
		expect(
			JSON.stringify(reg.get("desk-lamp"), (_k, v) => (v instanceof Set ? [...v] : v)),
		).not.toContain(token);
	});

	test("grant, revoke and unpair take effect immediately", async () => {
		const { reg, token } = await paired();
		reg.grant("desk-lamp", "set_light");
		expect(reg.isGranted("desk-lamp", "set_light")).toBe(true);
		expect(() => reg.grant("desk-lamp", "fly")).toThrow(/no capability "fly"/);
		reg.revoke("desk-lamp", "set_light");
		expect(reg.isGranted("desk-lamp", "set_light")).toBe(false);
		reg.unpair("desk-lamp");
		expect(reg.isPaired("desk-lamp")).toBe(false);
		expect(reg.authenticate("desk-lamp", token)).toBe(false);
	});

	test("re-pairing replaces the old token and grants", async () => {
		const { reg, token } = await paired();
		reg.grant("desk-lamp", "read_light");
		const again = await reg.pair(lamp(), { consent: async () => ({ approved: true }) });
		expect(again.ok).toBe(true);
		expect(reg.authenticate("desk-lamp", token)).toBe(false);
		expect(reg.isGranted("desk-lamp", "read_light")).toBe(false);
	});
});
