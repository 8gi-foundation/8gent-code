// Contract tests for packages/tools/prompt-template.ts
//
// This file replaces the auto-generated "template-engine" spec stub. The
// original spec required an HTML-escaping engine with {{#each}} loops. That
// requirement was DELIBERATELY DROPPED: the real templating surface in this
// codebase is LLM prompt templates, which are raw text (escaping would
// corrupt prompts) and have no looping consumer. The shipped contract is:
//   - render(): global substitution (every occurrence), dot-path lookup,
//     no escaping, $-sequences in values inserted verbatim
//   - missing vars are DETECTED (throw by default; "keep"/"empty" opt-outs)
//   - {{#if x}}...{{else}}...{{/if}} conditionals only, no {{#each}}
//   - validate() reports missing vars; lint() reports structural problems

import { describe, expect, test } from "bun:test";
import { lint, render, validate } from "../prompt-template";

describe("prompt-template: render", () => {
	test("substitutes a variable", () => {
		expect(render("Hello {{name}}!", { name: "world" })).toBe("Hello world!");
	});

	test("substitutes EVERY occurrence of a reused variable (the String.replace bug)", () => {
		const out = render("{{x}} and {{x}} and {{x}}", { x: "A" });
		expect(out).toBe("A and A and A");
	});

	test("resolves dot-paths", () => {
		expect(render("Hi {{user.name}} ({{user.role}})", { user: { name: "James", role: "eng" } })).toBe(
			"Hi James (eng)",
		);
	});

	test("tolerates whitespace inside tags", () => {
		expect(render("{{ name }}", { name: "x" })).toBe("x");
	});

	test("does NOT HTML-escape (prompts are raw text)", () => {
		expect(render("{{code}}", { code: '<a href="x">&</a>' })).toBe('<a href="x">&</a>');
	});

	test("does NOT interpret $-replacement patterns in values (String.replace hazard)", () => {
		expect(render("val: {{v}}", { v: "$& $' $1 $$" })).toBe("val: $& $' $1 $$");
	});

	test("stringifies non-string values", () => {
		expect(render("{{n}}/{{b}}", { n: 42, b: false })).toBe("42/false");
	});

	test("throws on a missing variable by default, naming it", () => {
		expect(() => render("Hello {{nmae}}", { name: "x" })).toThrow('missing variable "nmae"');
	});

	test("treats null/undefined values as missing", () => {
		expect(() => render("{{a}}", { a: null })).toThrow('missing variable "a"');
		expect(() => render("{{a}}", { a: undefined })).toThrow('missing variable "a"');
	});

	test('onMissing: "keep" leaves the literal tag', () => {
		expect(render("Hello {{gone}}!", {}, { onMissing: "keep" })).toBe("Hello {{gone}}!");
	});

	test('onMissing: "empty" substitutes nothing', () => {
		expect(render("Hello {{gone}}!", {}, { onMissing: "empty" })).toBe("Hello !");
	});

	test("extra vars are ignored", () => {
		expect(render("{{a}}", { a: "1", b: "2" })).toBe("1");
	});

	test("leaves JSON closing braces in prompt text alone", () => {
		const t = 'Respond as JSON: {"result":{"status":"{{status}}"}}';
		expect(render(t, { status: "ok" })).toBe('Respond as JSON: {"result":{"status":"ok"}}');
	});
});

describe("prompt-template: conditionals", () => {
	test("{{#if}} renders body when truthy", () => {
		expect(render("a{{#if x}}b{{/if}}c", { x: true })).toBe("abc");
	});

	test("{{#if}} skips body when falsy or missing (missing condition never throws)", () => {
		expect(render("a{{#if x}}b{{/if}}c", { x: false })).toBe("ac");
		expect(render("a{{#if x}}b{{/if}}c", {})).toBe("ac");
	});

	test("{{else}} branch", () => {
		const t = "{{#if vip}}Welcome back{{else}}Hello{{/if}}, {{name}}";
		expect(render(t, { vip: true, name: "J" })).toBe("Welcome back, J");
		expect(render(t, { vip: false, name: "J" })).toBe("Hello, J");
	});

	test("condition supports dot-paths", () => {
		expect(render("{{#if user.admin}}root{{/if}}", { user: { admin: 1 } })).toBe("root");
	});

	test("nested #if blocks", () => {
		const t = "{{#if a}}A{{#if b}}B{{/if}}{{/if}}";
		expect(render(t, { a: 1, b: 1 })).toBe("AB");
		expect(render(t, { a: 1, b: 0 })).toBe("A");
		expect(render(t, { a: 0, b: 1 })).toBe("");
	});

	test("vars inside a skipped branch are not evaluated (no missing-var throw)", () => {
		expect(render("{{#if never}}{{ghost}}{{/if}}ok", {})).toBe("ok");
	});
});

describe("prompt-template: validate", () => {
	test("reports missing var names in first-use order, deduplicated", () => {
		expect(validate("{{a}} {{b}} {{a}} {{c.d}}", { b: 1 })).toEqual(["a", "c.d"]);
	});

	test("a typo'd template is detected", () => {
		const template = "Task: {{TASK}}, files: {{FLIES}}";
		const vars = { TASK: "x", FILES: "y" };
		expect(validate(template, vars)).toEqual(["FLIES"]);
	});

	test("empty for a fully satisfied template", () => {
		expect(validate("{{a}}{{#if b}}{{c}}{{/if}}", { a: 1, c: 2 })).toEqual([]);
	});

	test("does not report #if condition names (absent condition is legal falsy)", () => {
		expect(validate("{{#if maybe}}x{{/if}}", {})).toEqual([]);
	});
});

describe("prompt-template: lint", () => {
	test("clean template lints empty", () => {
		expect(lint("hello {{name}} {{#if a}}x{{else}}y{{/if}}")).toEqual([]);
	});

	test("unclosed #if block", () => {
		expect(lint("{{#if a}}x").join(" ")).toContain("Unclosed {{#if a}}");
	});

	test("{{/if}} without opener", () => {
		expect(lint("x{{/if}}").join(" ")).toContain("without a matching");
	});

	test("{{else}} outside a block", () => {
		expect(lint("x{{else}}y").join(" ")).toContain("outside");
	});

	test("unsupported block tag ({{#each}} deliberately not implemented)", () => {
		expect(lint("{{#each items}}x{{/each}}").join(" ")).toContain("Unsupported block tag");
	});

	test("malformed tag", () => {
		expect(lint("{{no spaces allowed}}").length).toBeGreaterThan(0);
		expect(lint("{{}}").length).toBeGreaterThan(0);
	});

	test("unclosed tag delimiter", () => {
		expect(lint("broken {{VAR and on").join(" ")).toContain("Unclosed tag");
	});

	test("render throws on a structurally invalid template", () => {
		expect(() => render("{{#if a}}x", { a: 1 })).toThrow("invalid template");
	});
});
