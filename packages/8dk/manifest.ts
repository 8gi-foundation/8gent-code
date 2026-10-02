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

function text(value: unknown, field: string, max = 200): string {
	if (typeof value !== "string" || value.trim() === "" || value.length > max) {
		throw new ManifestError(
			`manifest ${field} must be a non-empty string of at most ${max} characters`,
		);
	}
	return value;
}

/** Validate an untrusted manifest and return a frozen copy. Throws ManifestError. */
export function validateManifest(input: unknown): DeviceManifest {
	if (!input || typeof input !== "object") throw new ManifestError("manifest must be an object");
	const m = input as Record<string, unknown>;
	const id = text(m.id, "id", 24);
	if (!ID_RE.test(id))
		throw new ManifestError(`manifest id "${id}" must be lower case words joined by "-"`);
	if (!Array.isArray(m.capabilities) || m.capabilities.length === 0) {
		throw new ManifestError("manifest must declare at least one capability");
	}
	const seen = new Set<string>();
	const capabilities = m.capabilities.map((raw): Capability => {
		const c = (raw ?? {}) as Record<string, unknown>;
		const name = text(c.name, "capability name", 30);
		if (!CAP_RE.test(name))
			throw new ManifestError(`capability name "${name}" must be lower snake case without "__"`);
		if (seen.has(name)) throw new ManifestError(`duplicate capability "${name}"`);
		seen.add(name);
		if (c.kind !== "sensor" && c.kind !== "actuator") {
			throw new ManifestError(`capability "${name}" kind must be sensor or actuator`);
		}
		const params: Record<string, ParamSpec> = {};
		for (const [key, spec] of Object.entries((c.params ?? {}) as Record<string, ParamSpec>)) {
			if (!CAP_RE.test(key) || !spec || !PARAM_TYPES.includes(spec.type)) {
				throw new ManifestError(
					`capability "${name}" param "${key}" must have type string, number or boolean`,
				);
			}
			params[key] = Object.freeze({
				type: spec.type,
				...(spec.description ? { description: String(spec.description) } : {}),
				...(spec.required ? { required: true } : {}),
			});
		}
		return Object.freeze({
			name,
			kind: c.kind,
			description: text(c.description, `capability "${name}" description`, 500),
			...(Object.keys(params).length ? { params: Object.freeze(params) } : {}),
			...(c.confirm === true ? { confirm: true } : {}),
		});
	});
	return Object.freeze({
		id,
		name: text(m.name, "name"),
		kind: text(m.kind, "kind", 40),
		version: text(m.version, "version", 40),
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
		if (typeof handlers[name] !== "function")
			throw new ManifestError(`no handler for capability "${name}"`);
	}
	for (const key of Object.keys(handlers)) {
		if (!names.has(key)) throw new ManifestError(`handler given for no capability named "${key}"`);
	}
	return Object.freeze({ manifest: valid, handlers: Object.freeze({ ...handlers }) });
}

/** Check a tool call's input against a capability's params. Returns an error or null. */
export function validateInput(capability: Capability, input: unknown): string | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
	const params = capability.params ?? {};
	const values = input as Record<string, unknown>;
	for (const key of Object.keys(values)) {
		if (!(key in params)) return `unknown param "${key}"`;
	}
	for (const [key, spec] of Object.entries(params)) {
		const value = values[key];
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
