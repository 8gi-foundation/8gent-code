/**
 * 8DK device contract: what a device is and what it can do.
 *
 * A device declares typed capabilities. A sensor reads the world, an actuator
 * changes it. Every manifest that arrives from a device is untrusted input and
 * goes through validateManifest before a person ever sees it.
 */
import { createHash } from "node:crypto";

export type ParamType = "string" | "number" | "boolean";
export type CapabilityKind = "sensor" | "actuator";

export interface ParamSpec {
	type: ParamType;
	description?: string;
	required?: boolean;
}

export interface Capability {
	/** Lower snake case, unique per device, never contains "__". */
	name: string;
	kind: CapabilityKind;
	/** Shown to the model and to the person at pairing. */
	description: string;
	params?: Record<string, ParamSpec>;
	/** Ask the person on every call, even when granted (door lock, payment). */
	confirm?: boolean;
}

export interface DeviceManifest {
	/** Lower case words joined by "-", at most 24 characters. Stable per device. */
	id: string;
	name: string;
	kind: string;
	version: string;
	capabilities: readonly Capability[];
}

export type CapabilityHandler = (input: Record<string, unknown>) => unknown | Promise<unknown>;

export interface DeviceDefinition {
	manifest: DeviceManifest;
	handlers: Readonly<Record<string, CapabilityHandler>>;
}

export class ManifestError extends Error {}

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CAP_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const PARAM_TYPES: readonly string[] = ["string", "number", "boolean"];

/**
 * Limits on untrusted manifest text and size. Every string here reaches the
 * pairing consent prompt or a model tool description, so each is bounded.
 */
export const MANIFEST_LIMITS = Object.freeze({
	/** Device id, lower case words joined by "-". */
	idLength: 24,
	/** Device display name, shown in the consent prompt. */
	nameLength: 80,
	kindLength: 40,
	versionLength: 40,
	capabilities: 32,
	capabilityNameLength: 30,
	capabilityDescriptionLength: 500,
	paramsPerCapability: 16,
	paramNameLength: 30,
	paramDescriptionLength: 200,
});

/**
 * Characters refused in any device-supplied text: C0 controls (newline, tab and
 * ESC included, so no ANSI sequences), DEL, C1 controls, the Arabic letter mark,
 * zero-width and directional marks (U+200B-U+200F), line and paragraph
 * separators, bidi embeddings and overrides (U+202A-U+202E), bidi isolates
 * (U+2066-U+2069) and the zero-width no-break space. A terminal prompt or a
 * model prompt must show exactly the text a person would read.
 */
const UNSAFE_TEXT_RE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the purpose
	/[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/;

function text(value: unknown, field: string, max: number): string {
	if (typeof value !== "string" || value.trim() === "" || value.length > max) {
		throw new ManifestError(
			`manifest ${field} must be a non-empty string of at most ${max} characters`,
		);
	}
	if (UNSAFE_TEXT_RE.test(value)) {
		throw new ManifestError(
			`manifest ${field} contains control, escape or bidirectional characters`,
		);
	}
	return value;
}

/** Validate an untrusted manifest and return a frozen copy. Throws ManifestError. */
export function validateManifest(input: unknown): DeviceManifest {
	if (!input || typeof input !== "object") throw new ManifestError("manifest must be an object");
	const m = input as Record<string, unknown>;
	const id = text(m.id, "id", MANIFEST_LIMITS.idLength);
	if (!ID_RE.test(id))
		throw new ManifestError(`manifest id "${id}" must be lower case words joined by "-"`);
	if (!Array.isArray(m.capabilities) || m.capabilities.length === 0) {
		throw new ManifestError("manifest must declare at least one capability");
	}
	if (m.capabilities.length > MANIFEST_LIMITS.capabilities) {
		throw new ManifestError(
			`manifest declares more than ${MANIFEST_LIMITS.capabilities} capabilities`,
		);
	}
	const seen = new Set<string>();
	const capabilities = m.capabilities.map((raw): Capability => {
		const c = (raw ?? {}) as Record<string, unknown>;
		const name = text(c.name, "capability name", MANIFEST_LIMITS.capabilityNameLength);
		if (!CAP_RE.test(name))
			throw new ManifestError(`capability name "${name}" must be lower snake case without "__"`);
		if (seen.has(name)) throw new ManifestError(`duplicate capability "${name}"`);
		seen.add(name);
		if (c.kind !== "sensor" && c.kind !== "actuator") {
			throw new ManifestError(`capability "${name}" kind must be sensor or actuator`);
		}
		// Null prototype: a param lookup can never find an inherited name.
		const params: Record<string, ParamSpec> = Object.create(null);
		const entries = Object.entries((c.params ?? {}) as Record<string, ParamSpec>);
		if (entries.length > MANIFEST_LIMITS.paramsPerCapability) {
			throw new ManifestError(
				`capability "${name}" declares more than ${MANIFEST_LIMITS.paramsPerCapability} params`,
			);
		}
		for (const [key, spec] of entries) {
			if (
				key.length > MANIFEST_LIMITS.paramNameLength ||
				!CAP_RE.test(key) ||
				!spec ||
				!PARAM_TYPES.includes(spec.type)
			) {
				throw new ManifestError(
					`capability "${name}" param "${key.slice(0, MANIFEST_LIMITS.paramNameLength)}" must be lower snake case with type string, number or boolean`,
				);
			}
			params[key] = Object.freeze({
				type: spec.type,
				...(spec.description
					? {
							description: text(
								spec.description,
								`capability "${name}" param "${key}" description`,
								MANIFEST_LIMITS.paramDescriptionLength,
							),
						}
					: {}),
				...(spec.required ? { required: true } : {}),
			});
		}
		return Object.freeze({
			name,
			kind: c.kind,
			description: text(
				c.description,
				`capability "${name}" description`,
				MANIFEST_LIMITS.capabilityDescriptionLength,
			),
			...(Object.keys(params).length ? { params: Object.freeze(params) } : {}),
			...(c.confirm === true ? { confirm: true } : {}),
		});
	});
	return Object.freeze({
		id,
		name: text(m.name, "name", MANIFEST_LIMITS.nameLength),
		kind: text(m.kind, "kind", MANIFEST_LIMITS.kindLength),
		version: text(m.version, "version", MANIFEST_LIMITS.versionLength),
		capabilities: Object.freeze(capabilities),
	});
}

/** Declare a device: a validated manifest plus exactly one handler per capability. */
export function defineDevice(
	manifest: DeviceManifest,
	handlers: Record<string, CapabilityHandler>,
): DeviceDefinition {
	const valid = validateManifest(manifest);
	const names = new Set(valid.capabilities.map((c) => c.name));
	for (const name of names) {
		// Own properties only: a capability named "constructor" must not find Object.
		if (!Object.hasOwn(handlers, name) || typeof handlers[name] !== "function")
			throw new ManifestError(`no handler for capability "${name}"`);
	}
	for (const key of Object.keys(handlers)) {
		if (!names.has(key)) throw new ManifestError(`handler given for no capability named "${key}"`);
	}
	const own: Record<string, CapabilityHandler> = Object.create(null);
	for (const name of names) own[name] = handlers[name];
	return Object.freeze({ manifest: valid, handlers: Object.freeze(own) });
}

/** Check a tool call's input against a capability's params. Returns an error or null. */
export function validateInput(capability: Capability, input: unknown): string | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
	const params: Record<string, ParamSpec> = capability.params ?? Object.create(null);
	const values = input as Record<string, unknown>;
	// Own properties only: "constructor", "toString" and "__proto__" are extra keys.
	for (const key of Object.keys(values)) {
		if (!Object.hasOwn(params, key)) return `unknown param "${key.slice(0, 64)}"`;
	}
	for (const [key, spec] of Object.entries(params)) {
		const value = Object.hasOwn(values, key) ? values[key] : undefined;
		if (value === undefined) {
			if (spec.required) return `missing required "${key}"`;
			continue;
		}
		const ok =
			spec.type === "number"
				? typeof value === "number" && Number.isFinite(value)
				: spec.type === "boolean"
					? typeof value === "boolean"
					: typeof value === "string";
		if (!ok) return `"${key}" must be ${spec.type}`;
	}
	return null;
}

/** Stable digest of a manifest. A device whose manifest changes must pair again. */
export function manifestDigest(manifest: DeviceManifest): string {
	const v = validateManifest(manifest);
	return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}
