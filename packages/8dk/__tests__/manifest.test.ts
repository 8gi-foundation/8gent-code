import { describe, expect, test } from "bun:test";
import { ManifestError, defineDevice, validateInput, validateManifest } from "../manifest";
import { createFakeLamp } from "./fake-device";

const base = {
	id: "probe",
	name: "Probe",
	kind: "sensor-pod",
	version: "1.0.0",
	capabilities: [{ name: "read_temp", kind: "sensor", description: "Temperature in C" }],
};

describe("defineDevice", () => {
	test("accepts the reference lamp and freezes it", () => {
		const { device } = createFakeLamp();
		expect(device.manifest.capabilities.map((c) => c.name)).toEqual([
			"read_light",
			"set_light",
			"strobe",
		]);
		expect(Object.isFrozen(device.manifest)).toBe(true);
		expect(Object.isFrozen(device.handlers)).toBe(true);
	});

	test("requires exactly one handler per capability", () => {
		expect(() => defineDevice(base as never, {})).toThrow(ManifestError);
		expect(() => defineDevice(base as never, { read_temp: () => 1, extra: () => 2 })).toThrow(
			/no capability named "extra"/,
		);
	});
});

describe("validateManifest", () => {
	test("rejects bad ids, names, kinds and duplicates", () => {
		expect(() => validateManifest({ ...base, id: "Bad_Id" })).toThrow(/id/);
		expect(() => validateManifest({ ...base, id: "x".repeat(25) })).toThrow(/id/);
		expect(() =>
			validateManifest({
				...base,
				capabilities: [{ name: "a__b", kind: "sensor", description: "d" }],
			}),
		).toThrow(/capability name/);
		expect(() =>
			validateManifest({
				...base,
				capabilities: [{ name: "go", kind: "motor", description: "d" }],
			}),
		).toThrow(/sensor or actuator/);
		expect(() =>
			validateManifest({ ...base, capabilities: [base.capabilities[0], base.capabilities[0]] }),
		).toThrow(/duplicate/);
		expect(() => validateManifest({ ...base, capabilities: [] })).toThrow(/at least one/);
		expect(() => validateManifest(null)).toThrow(ManifestError);
	});

	test("rejects unknown param types", () => {
		expect(() =>
			validateManifest({
				...base,
				capabilities: [
					{ name: "go", kind: "actuator", description: "d", params: { x: { type: "object" } } },
				],
			}),
		).toThrow(/param "x"/);
	});
});

describe("validateInput", () => {
	const setLight = createFakeLamp().device.manifest.capabilities[1];
	test("checks required keys, primitive types and extra keys", () => {
		expect(validateInput(setLight, { on: true, brightness: 40 })).toBeNull();
		expect(validateInput(setLight, {})).toMatch(/missing required "on"/);
		expect(validateInput(setLight, { on: "yes" })).toMatch(/"on" must be boolean/);
		expect(validateInput(setLight, { on: true, colour: "red" })).toMatch(/unknown param "colour"/);
		expect(validateInput(setLight, { on: true, brightness: Number.NaN })).toMatch(
			/"brightness" must be number/,
		);
	});
});
