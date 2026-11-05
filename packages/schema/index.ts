/**
 * 8gent-schema, slice 1: compile a JSON Schema into a tree of closures once,
 * validate by calling them. No eval, no new Function, no dependencies, so it
 * runs in strict sandboxes.
 *
 * Supported: type (string or array of strings), properties, required,
 * additionalProperties (boolean), items (one schema), enum, const, minimum,
 * maximum, minLength, maxLength. Annotation keywords are ignored.
 * Any other keyword makes compile() throw, so an unsupported schema is refused
 * out loud rather than quietly passing every value.
 */

/** One compiled node. `e` null means check-only: stop at the first failure and build no strings. */
type Node = (v: unknown, p: string, e: string[] | null) => boolean;

export interface Compiled {
	check(value: unknown): boolean;
	errors(value: unknown): string[];
}

const ANNOTATIONS = new Set(["description", "title", "default", "examples", "$schema", "$comment"]);
const KEYWORDS = new Set([
	"type", "properties", "required", "additionalProperties", "items",
	"enum", "const", "minimum", "maximum", "minLength", "maxLength",
]);
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const TYPES = new Map<string, (v: unknown) => boolean>([
	["object", isRecord],
	["array", Array.isArray],
	["string", (v) => typeof v === "string"],
	["number", (v) => typeof v === "number" && Number.isFinite(v)],
	["integer", (v) => typeof v === "number" && Number.isInteger(v)],
	["boolean", (v) => typeof v === "boolean"],
	["null", (v) => v === null],
]);

function kindOf(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}

/** Code points, as JSON Schema counts string length. */
function cpLen(s: string): number {
	let n = s.length;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			const d = s.charCodeAt(i + 1);
			if (d >= 0xdc00 && d <= 0xdfff) {
				n--;
				i++;
			}
		}
	}
	return n;
}

function deepEq(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a)) {
		return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
	}
	if (isRecord(a) && isRecord(b)) {
		const ka = Object.keys(a);
		return ka.length === Object.keys(b).length && ka.every((k) => hasOwn(b, k) && deepEq(a[k], b[k]));
	}
	return false;
}

const ok: Node = () => true;

function fail(e: string[] | null, p: string, why: string): false {
	if (e !== null) e.push(`${p}: ${why}`);
	return false;
}

function numKeyword(s: Record<string, unknown>, k: string, at: string): number | null {
	if (!hasOwn(s, k)) return null;
	const n = s[k];
	if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`8gent-schema: ${at}: ${k} must be a number`);
	return n;
}

function build(s: unknown, at: string): Node {
	if (s === true) return ok;
	if (s === false) return (_v, p, e) => fail(e, p, "no value is allowed here");
	if (!isRecord(s)) throw new Error(`8gent-schema: ${at}: a schema must be an object or a boolean`);
	for (const k of Object.keys(s)) {
		if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k)) throw new Error(`8gent-schema: ${at}: unsupported keyword ${k}`);
	}
	const steps: Node[] = [];

	if (hasOwn(s, "type")) {
		const names = Array.isArray(s.type) ? s.type : [s.type];
		const tests = names.map((n) => {
			const t = typeof n === "string" ? TYPES.get(n) : undefined;
			if (!t) throw new Error(`8gent-schema: ${at}: unknown type ${String(n)}`);
			return t;
		});
		const want = names.join(" or ");
		steps.push(
			tests.length === 1
				? (v, p, e) => tests[0](v) || fail(e, p, `expected ${want}, got ${kindOf(v)}`)
				: (v, p, e) => tests.some((t) => t(v)) || fail(e, p, `expected ${want}, got ${kindOf(v)}`),
		);
	}

	if (hasOwn(s, "enum")) {
		if (!Array.isArray(s.enum)) throw new Error(`8gent-schema: ${at}: enum must be an array`);
		const options = s.enum;
		steps.push((v, p, e) => options.some((o) => deepEq(o, v)) || fail(e, p, "not one of the allowed values"));
	}
	if (hasOwn(s, "const")) {
		const want = s.const;
		steps.push((v, p, e) => deepEq(want, v) || fail(e, p, "does not equal the required value"));
	}

	const min = numKeyword(s, "minimum", at);
	const max = numKeyword(s, "maximum", at);
	if (min !== null) {
		steps.push((v, p, e) => typeof v !== "number" || v >= min || fail(e, p, `must be >= ${min}`));
	}
	if (max !== null) {
		steps.push((v, p, e) => typeof v !== "number" || v <= max || fail(e, p, `must be <= ${max}`));
	}
	const minLen = numKeyword(s, "minLength", at);
	const maxLen = numKeyword(s, "maxLength", at);
	if (minLen !== null) {
		steps.push((v, p, e) => typeof v !== "string" || cpLen(v) >= minLen || fail(e, p, `length must be >= ${minLen}`));
	}
	if (maxLen !== null) {
		steps.push((v, p, e) => typeof v !== "string" || cpLen(v) <= maxLen || fail(e, p, `length must be <= ${maxLen}`));
	}

	if (hasOwn(s, "items")) {
		if (Array.isArray(s.items)) throw new Error(`8gent-schema: ${at}: tuple items are not supported`);
		const item = build(s.items, `${at}[]`);
		steps.push((v, p, e) => {
			if (!Array.isArray(v)) return true;
			let good = true;
			for (let i = 0; i < v.length; i++) {
				if (!item(v[i], e === null ? p : `${p}[${i}]`, e)) {
					if (e === null) return false;
					good = false;
				}
			}
			return good;
		});
	}

	const closed = hasOwn(s, "additionalProperties");
	if (closed && typeof s.additionalProperties !== "boolean") {
		throw new Error(`8gent-schema: ${at}: additionalProperties must be a boolean`);
	}
	const noExtra = closed && s.additionalProperties === false;
	let names: string[] = [];
	let kids: Node[] = [];
	if (hasOwn(s, "properties")) {
		if (!isRecord(s.properties)) throw new Error(`8gent-schema: ${at}: properties must be an object`);
		const props = s.properties;
		names = Object.keys(props);
		kids = names.map((k) => build(props[k], `${at}.${k}`));
	}
	const req = hasOwn(s, "required") ? s.required : [];
	if (!Array.isArray(req) || req.some((k) => typeof k !== "string")) {
		throw new Error(`8gent-schema: ${at}: required must be an array of strings`);
	}
	const required = req as string[];
	if (names.length > 0 || required.length > 0 || noExtra) {
		const allowed = new Set(names);
		steps.push((v, p, e) => {
			if (!isRecord(v)) return true;
			let good = true;
			// Own-property tests only, so "constructor" or "__proto__" never counts as present.
			for (const k of required) {
				if (!hasOwn(v, k)) {
					if (e === null) return false;
					e.push(`${p}.${k}: required`);
					good = false;
				}
			}
			for (let i = 0; i < names.length; i++) {
				const k = names[i];
				if (hasOwn(v, k) && !kids[i](v[k], e === null ? p : `${p}.${k}`, e)) {
					if (e === null) return false;
					good = false;
				}
			}
			if (noExtra) {
				for (const k of Object.keys(v)) {
					if (!allowed.has(k)) {
						if (e === null) return false;
						e.push(`${p}.${safeKey(k)}: not allowed`);
						good = false;
					}
				}
			}
			return good;
		});
	}

	if (steps.length === 0) return ok;
	if (steps.length === 1) return steps[0];
	return (v, p, e) => {
		let good = true;
		for (let i = 0; i < steps.length; i++) {
			if (!steps[i](v, p, e)) {
				if (e === null) return false;
				good = false;
			}
		}
		return good;
	};
}

/** Compile once, call many times. Throws on a keyword outside slice 1. */
export function compile(schema: unknown): Compiled {
	const root = build(schema, "$");
	return {
		check: (value) => root(value, "$", null),
		errors: (value) => {
			const out: string[] = [];
			root(value, "$", out);
			return out;
		},
	};
}

/** A key the model chose, made safe to print: control characters escaped as \\uXXXX, and bounded. */
function safeKey(k: string): string {
	const short = k.length > 64 ? `${k.slice(0, 64)}...` : k;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
	return short.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
