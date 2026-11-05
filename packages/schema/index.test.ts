import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "./index";

const tool = {
	type: "object",
	properties: {
		path: { type: "string", minLength: 1, maxLength: 8 },
		count: { type: "integer", minimum: 0, maximum: 10 },
		ratio: { type: "number" },
		mode: { enum: ["r", "w"] },
		flag: { type: "boolean" },
		note: { type: ["string", "null"] },
		kind: { const: "file" },
		tags: { type: "array", items: { type: "string" } },
		opts: {
			type: "object",
			properties: { deep: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } },
			additionalProperties: false,
		},
	},
	required: ["path"],
	additionalProperties: false,
};

// [label, schema, value, expected]
const table: [string, unknown, unknown, boolean][] = [
	["string ok", { type: "string" }, "a", true],
	["string rejects number", { type: "string" }, 1, false],
	["number rejects NaN", { type: "number" }, Number.NaN, false],
	["number rejects Infinity", { type: "number" }, Number.POSITIVE_INFINITY, false],
	["integer rejects 1.5", { type: "integer" }, 1.5, false],
	["integer ok 3", { type: "integer" }, 3, true],
	["boolean ok", { type: "boolean" }, false, true],
	["null ok", { type: "null" }, null, true],
	["object rejects array", { type: "object" }, [], false],
	["object rejects null", { type: "object" }, null, false],
	["array rejects object", { type: "array" }, {}, false],
	["type array nullable ok null", { type: ["string", "null"] }, null, true],
	["type array nullable ok string", { type: ["string", "null"] }, "x", true],
	["type array nullable rejects number", { type: ["string", "null"] }, 2, false],
	["enum hit", { enum: ["a", 2, null] }, 2, true],
	["enum miss", { enum: ["a", 2, null] }, "b", false],
	["enum deep", { enum: [{ a: [1] }] }, { a: [1] }, true],
	["const null", { const: null }, null, true],
	["const miss", { const: 1 }, "1", false],
	["minimum edge ok", { type: "number", minimum: 5 }, 5, true],
	["minimum below", { type: "number", minimum: 5 }, 4.9, false],
	["maximum edge ok", { type: "number", maximum: 5 }, 5, true],
	["maximum above", { type: "number", maximum: 5 }, 6, false],
	["minimum ignores strings", { minimum: 5 }, "a", true],
	["minLength ok", { type: "string", minLength: 2 }, "ab", true],
	["minLength short", { type: "string", minLength: 2 }, "a", false],
	["maxLength counts code points", { type: "string", maxLength: 1 }, "\u{1F600}", true],
	["maxLength long", { type: "string", maxLength: 2 }, "abc", false],
	["items ok", { type: "array", items: { type: "integer" } }, [1, 2], true],
	["items bad element", { type: "array", items: { type: "integer" } }, [1, "2"], false],
	["required missing", { type: "object", required: ["a"] }, {}, false],
	["required present undefined-valued", { type: "object", required: ["a"] }, { a: undefined }, true],
	["required ignores inherited", { type: "object", required: ["constructor"] }, {}, false],
	["extra allowed by default", { type: "object", properties: { a: {} } }, { a: 1, b: 2 }, true],
	["extra blocked", { type: "object", properties: { a: {} }, additionalProperties: false }, { a: 1, b: 2 }, false],
	["additionalProperties true", { type: "object", additionalProperties: true }, { z: 1 }, true],
	["boolean schema true", { properties: { a: true } }, { a: 1 }, true],
	["boolean schema false", { properties: { a: false } }, { a: 1 }, false],
	["tool full ok", tool, { path: "f.txt", count: 3, mode: "r", note: null, kind: "file", tags: ["a"], opts: { deep: { n: 1 } } }, true],
	["tool missing required", tool, { count: 3 }, false],
	["tool path too long", tool, { path: "123456789" }, false],
	["tool nested bad", tool, { path: "p", opts: { deep: { n: "x" } } }, false],
	["tool nested missing", tool, { path: "p", opts: { deep: {} } }, false],
	["tool unknown key", tool, { path: "p", zzz: 1 }, false],
	["annotations ignored", { type: "string", description: "d", title: "t", default: "x" }, "a", true],
];

describe("compile: table", () => {
	for (const [label, schema, value, want] of table) {
		it(label, () => {
			const c = compile(schema);
			expect(c.check(value)).toBe(want);
			// check and errors must agree on every row
			expect(c.errors(value).length === 0).toBe(want);
		});
	}
});

describe("errors", () => {
	it("names the path and the reason", () => {
		const c = compile(tool);
		const errs = c.errors({ count: 11, tags: ["a", 2], opts: { deep: {} }, extra: 1 });
		expect(errs).toContain("$.path: required");
		expect(errs).toContain("$.count: must be <= 10");
		expect(errs).toContain("$.tags[1]: expected string, got number");
		expect(errs).toContain("$.opts.deep.n: required");
		expect(errs).toContain("$.extra: not allowed");
	});
	it("returns an empty list for a valid value", () => {
		expect(compile(tool).errors({ path: "p" })).toEqual([]);
	});
});

describe("unsupported input is refused at compile", () => {
	for (const kw of ["$ref", "allOf", "anyOf", "oneOf", "pattern", "format", "minItems"]) {
		it(`throws on ${kw}`, () => {
			expect(() => compile({ type: "string", [kw]: "x" })).toThrow(/unsupported keyword/);
		});
	}
	it("throws on an unknown type", () => {
		expect(() => compile({ type: "date" })).toThrow(/unknown type/);
	});
	it("throws on a non-boolean additionalProperties", () => {
		expect(() => compile({ additionalProperties: { type: "string" } })).toThrow(/boolean/);
	});
	it("throws on tuple items", () => {
		expect(() => compile({ items: [{}] })).toThrow(/tuple/);
	});
});

describe("adversarial", () => {
	it("a __proto__ key in the schema is a property, not a prototype write", () => {
		const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}');
		const c = compile(schema);
		expect(c.check(JSON.parse('{"__proto__":"x"}'))).toBe(true);
		expect(c.check(JSON.parse('{"__proto__":1}'))).toBe(false);
		expect(c.check({})).toBe(false);
		expect(({} as Record<string, unknown>).type).toBeUndefined();
		expect(Object.prototype.hasOwnProperty.call(Object.prototype, "type")).toBe(false);
	});
	it("constructor and toString keys are not found on inherited members", () => {
		const c = compile({ type: "object", properties: { constructor: { type: "string" } }, required: ["constructor"] });
		expect(c.check({})).toBe(false);
		expect(c.check({ constructor: "ok" })).toBe(true);
	});
	it("additionalProperties false rejects a __proto__ own key in the value", () => {
		const c = compile({ type: "object", properties: { a: {} }, additionalProperties: false });
		expect(c.check(JSON.parse('{"a":1,"__proto__":{"x":1}}'))).toBe(false);
	});
	it("code-shaped strings in the schema are inert", () => {
		const hit = { n: 0 };
		(globalThis as Record<string, unknown>).__schemaHit = hit;
		const c = compile({ enum: ["globalThis.__schemaHit.n++"], const: "globalThis.__schemaHit.n++" });
		c.check("globalThis.__schemaHit.n++");
		c.errors("x");
		expect(hit.n).toBe(0);
		expect(() => compile({ type: "string", "x'); globalThis.__schemaHit.n++; ('": 1 })).toThrow();
		expect(hit.n).toBe(0);
	});
	it("source holds no eval and no Function constructor", () => {
		const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
		const code = src
			.split("\n")
			.filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
			.join("\n");
		expect(code).not.toMatch(/\beval\s*\(/);
		expect(code).not.toMatch(/new\s+Function\b/);
		expect(code).not.toMatch(/\bFunction\s*\(/);
		expect(code).not.toMatch(/\bimport\s*\(/);
		expect(code).not.toMatch(/\brequire\s*\(/);
		const imports = code.split("\n").filter((l) => /^\s*import\b/.test(l));
		expect(imports).toEqual([]);
	});
});
