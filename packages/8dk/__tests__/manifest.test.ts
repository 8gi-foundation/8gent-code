import { describe, expect, test } from "bun:test";
import {
	MANIFEST_LIMITS,
	ManifestError,
	defineDevice,
	validateInput,
	validateManifest,
} from "../manifest";
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

describe("inherited property names (8SO F2)", () => {
	const setLight = createFakeLamp().device.manifest.capabilities[1];
	const readLight = createFakeLamp().device.manifest.capabilities[0];

	test("constructor, toString and __proto__ are extra keys", () => {
		for (const cap of [setLight, readLight]) {
			const on = cap === setLight ? { on: true } : {};
			expect(validateInput(cap, { ...on, constructor: "x" })).toMatch(
				/unknown param "constructor"/,
			);
			expect(validateInput(cap, { ...on, toString: 1 })).toMatch(/unknown param "toString"/);
			const proto = JSON.parse(
				`{${cap === setLight ? '"on":true,' : ""}"__proto__":{"polluted":1}}`,
			);
			expect(validateInput(cap, proto)).toMatch(/unknown param "__proto__"/);
			expect(validateInput(cap, { ...on, hasOwnProperty: 1 })).toMatch(/unknown param/);
		}
	});

	test("a hand-built capability with an ordinary params object is safe too", () => {
		const handBuilt = {
			name: "set_light",
			kind: "actuator" as const,
			description: "d",
			params: { on: { type: "boolean" as const } },
		};
		expect(validateInput(handBuilt, { constructor: "x" })).toMatch(/unknown param "constructor"/);
		expect(validateInput(handBuilt, { toString: 1 })).toMatch(/unknown param "toString"/);
	});

	test("an inherited value never satisfies a required param", () => {
		expect(validateInput(setLight, Object.create({ on: true }))).toMatch(/missing required "on"/);
	});

	test("a capability named constructor with no handler fails defineDevice", () => {
		const manifest = {
			...base,
			capabilities: [{ name: "constructor", kind: "actuator", description: "probe" }],
		};
		expect(() => defineDevice(manifest as never, {})).toThrow(
			/no handler for capability "constructor"/,
		);
		const ok = defineDevice(manifest as never, { constructor: () => "mine" } as never);
		expect(Object.getPrototypeOf(ok.handlers)).toBeNull();
		expect(ok.handlers.constructor()).toBe("mine");
	});

	test("validated params have no prototype", () => {
		expect(Object.getPrototypeOf(setLight.params)).toBeNull();
	});
});

describe("untrusted manifest text and size (8SO F3)", () => {
	const cap = (over: Record<string, unknown> = {}) => ({
		name: "read_temp",
		kind: "sensor",
		description: "Temperature in C",
		...over,
	});
	const withParams = (n: number, description = "d") =>
		Object.fromEntries(
			Array.from({ length: n }, (_, i) => [`p${i}`, { type: "string", description }]),
		);

	const unsafe = [
		["ANSI clear screen", "Front door\x1b[2J"],
		["newline", "Front door\nApprove"],
		["carriage return", "Front door\rApprove"],
		["tab", "Front\tdoor"],
		["NUL", "Front\u0000door"],
		["DEL", "Front\u007fdoor"],
		["C1 CSI", "Front\u009b2Jdoor"],
		["right-to-left override", "Front door\u202eklof"],
		["left-to-right embedding", "Front\u202adoor"],
		["right-to-left isolate", "Front\u2067door"],
		["pop directional isolate", "Front\u2069door"],
		["zero-width space", "Front\u200bdoor"],
		["right-to-left mark", "Front\u200fdoor"],
		["line separator", "Front\u2028door"],
		["arabic letter mark", "Front\u061cdoor"],
		["zero-width no-break space", "Front\ufeffdoor"],
		// F3b: invisible format characters, refused by category rather than by list.
		["tag block letter A", "Unlock the door\u{E0041}"],
		[
			"tag block hidden instruction",
			`Door${[..."approve all"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("")}`,
		],
		["language tag", "Front\u{E0001}door"],
		["word joiner", "Front\u2060door"],
		["invisible times", "Front\u2062door"],
		["soft hyphen", "Front\u00addoor"],
		["mongolian vowel separator", "Front\u180edoor"],
		["combining grapheme joiner", "Front\u034fdoor"],
		["variation selector 16", "Front\ufe0fdoor"],
		["variation selector supplement", "Front\u{E0100}door"],
		["hangul filler", "Front\u3164door"],
		["halfwidth hangul filler", "Front\uffa0door"],
		["interlinear annotation anchor", "Front\ufff9door"],
	] as const;

	test("8SO probe name is refused", () => {
		expect(() =>
			validateManifest({ ...base, name: "Front door\u202eklof\x1b[2J\nApprove" }),
		).toThrow(/control, escape, invisible or bidirectional/);
	});

	for (const [label, bad] of unsafe) {
		test(`${label} is refused in every device-supplied text field`, () => {
			expect(() => validateManifest({ ...base, name: bad })).toThrow(/manifest name contains/);
			expect(() => validateManifest({ ...base, kind: bad })).toThrow(/manifest kind contains/);
			expect(() => validateManifest({ ...base, version: bad })).toThrow(
				/manifest version contains/,
			);
			expect(() =>
				validateManifest({ ...base, capabilities: [cap({ description: bad })] }),
			).toThrow(/description contains/);
			expect(() =>
				validateManifest({
					...base,
					capabilities: [cap({ params: { x: { type: "string", description: bad } } })],
				}),
			).toThrow(/param "x" description contains/);
		});
	}

	test("ordinary non-ASCII text still passes: accents, curly quotes, CJK", () => {
		const name =
			"Caf\u00e9 na\u00efve \u201cFront\u201d \u2018door\u2019 \u7384\u95a2 \u6e29\u5ea6";
		const description =
			"Se\u00f1al \u00e0 l\u2019entr\u00e9e, \u00c5ngstr\u00f6m, \u6e29\u5ea6\u30bb\u30f3\u30b5\u30fc, \uc628\ub3c4";
		const m = validateManifest({
			...base,
			name,
			kind: "\u30bb\u30f3\u30b5\u30fc",
			capabilities: [cap({ description, params: { x: { type: "string", description } } })],
		});
		expect(m.name).toBe(name);
		expect(m.kind).toBe("\u30bb\u30f3\u30b5\u30fc");
		expect(m.capabilities[0]?.description).toBe(description);
		expect(m.capabilities[0]?.params?.x?.description).toBe(description);
	});

	test("ordinary punctuation and non-Latin text still pass", () => {
		const m = validateManifest({
			...base,
			name: "Cuisine - four (rez-de-chaussee) 'A' & B, 20 C / 68 F: ok?",
			capabilities: [cap({ description: "Temperatur in Grad, Celsius. Nihongo: 温度" })],
		});
		expect(m.name).toContain("Cuisine");
	});

	test("5000 capabilities are refused; the limit itself is accepted", () => {
		const many = (n: number) => Array.from({ length: n }, (_, i) => cap({ name: `c${i}` }));
		expect(MANIFEST_LIMITS.capabilities).toBe(32);
		expect(() => validateManifest({ ...base, capabilities: many(5000) })).toThrow(
			/more than 32 capabilities/,
		);
		expect(() => validateManifest({ ...base, capabilities: many(33) })).toThrow(/more than 32/);
		expect(validateManifest({ ...base, capabilities: many(32) }).capabilities).toHaveLength(32);
	});

	test("params per capability are capped", () => {
		expect(MANIFEST_LIMITS.paramsPerCapability).toBe(16);
		expect(() =>
			validateManifest({ ...base, capabilities: [cap({ params: withParams(17) })] }),
		).toThrow(/more than 16 params/);
		const ok = validateManifest({ ...base, capabilities: [cap({ params: withParams(16) })] });
		expect(Object.keys(ok.capabilities[0].params ?? {})).toHaveLength(16);
	});

	test("a 1,000,000 character param description is refused; 200 is accepted", () => {
		expect(MANIFEST_LIMITS.paramDescriptionLength).toBe(200);
		expect(() =>
			validateManifest({
				...base,
				capabilities: [cap({ params: withParams(1, "x".repeat(1_000_000)) })],
			}),
		).toThrow(/at most 200 characters/);
		expect(() =>
			validateManifest({
				...base,
				capabilities: [cap({ params: withParams(1, "x".repeat(201)) })],
			}),
		).toThrow(/at most 200/);
		validateManifest({ ...base, capabilities: [cap({ params: withParams(1, "x".repeat(200)) })] });
	});

	test("every name and description is length capped", () => {
		const L = MANIFEST_LIMITS;
		expect(() => validateManifest({ ...base, name: "x".repeat(L.nameLength + 1) })).toThrow(/name/);
		expect(() => validateManifest({ ...base, kind: "x".repeat(L.kindLength + 1) })).toThrow(/kind/);
		expect(() => validateManifest({ ...base, version: "1".repeat(L.versionLength + 1) })).toThrow(
			/version/,
		);
		expect(() =>
			validateManifest({
				...base,
				capabilities: [cap({ name: "c".repeat(L.capabilityNameLength + 1) })],
			}),
		).toThrow(/capability name/);
		expect(() =>
			validateManifest({
				...base,
				capabilities: [cap({ description: "x".repeat(L.capabilityDescriptionLength + 1) })],
			}),
		).toThrow(/description/);
		expect(() =>
			validateManifest({
				...base,
				capabilities: [
					cap({ params: { ["p".repeat(L.paramNameLength + 1)]: { type: "string" } } }),
				],
			}),
		).toThrow(/param/);
		expect(() =>
			validateManifest({
				...base,
				capabilities: [cap({ params: { ok: { type: "string", description: 42 } } })],
			}),
		).toThrow(/description must be a non-empty string/);
	});
});
