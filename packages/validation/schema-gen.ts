/**
 * Zod to JSON Schema generation pipeline.
 *
 * Converts Zod schemas to JSON Schema objects and provides
 * basic runtime validation against the emitted schemas.
 *
 * Closes #1370 - prevents Zod type drift from becoming an injection vector.
 */
import type { z } from "zod";

export interface EmittedSchema {
	$schema?: string;
	type?: string;
	properties?: Record<string, unknown>;
	required?: string[];
	description?: string;
	items?: unknown;
	enum?: unknown[];
	anyOf?: unknown[];
	const?: unknown;
}

/**
 * Convert a Zod schema to a JSON Schema object.
 *
 * Walks the Zod v4 internal _def structure to produce a
 * standards-compatible JSON Schema representation.
 */
export function emitSchema(schema: z.ZodType, name?: string): EmittedSchema {
	const result = convertZodToJsonSchema(schema);

	// Attach description if the Zod schema has one
	if ((schema as any).description) {
		result.description = (schema as any).description;
	}

	return result;
}

function convertZodToJsonSchema(schema: z.ZodType): EmittedSchema {
	const def = (schema as any)._def;
	const type: string = def?.type;

	switch (type) {
		case "string":
			return { type: "string" };

		case "number":
			return { type: "number" };

		case "boolean":
			return { type: "boolean" };

		case "object": {
			const shape = (schema as any).shape as Record<string, z.ZodType>;
			const properties: Record<string, unknown> = {};
			const required: string[] = [];

			for (const [key, fieldSchema] of Object.entries(shape)) {
				const fieldDef = (fieldSchema as any)._def;

				if (fieldDef?.type === "optional") {
					// Unwrap optional: emit the inner type, don't add to required
					const inner = fieldDef.innerType as z.ZodType;
					const innerResult = convertZodToJsonSchema(inner);
					if ((inner as any).description) {
						innerResult.description = (inner as any).description;
					}
					properties[key] = innerResult;
				} else {
					const fieldResult = convertZodToJsonSchema(fieldSchema);
					if ((fieldSchema as any).description) {
						fieldResult.description = (fieldSchema as any).description;
					}
					properties[key] = fieldResult;
					required.push(key);
				}
			}

			const result: EmittedSchema = { type: "object", properties };
			if (required.length > 0) {
				result.required = required;
			}
			return result;
		}

		case "array": {
			const element = def.element as z.ZodType;
			const items = convertZodToJsonSchema(element);
			if ((element as any).description) {
				items.description = (element as any).description;
			}
			return { type: "array", items };
		}

		case "enum": {
			const entries = def.entries as Record<string, string>;
			return { type: "string", enum: Object.values(entries) };
		}

		case "optional": {
			// Standalone optional (not inside an object shape)
			const inner = def.innerType as z.ZodType;
			const result = convertZodToJsonSchema(inner);
			if ((inner as any).description) {
				result.description = (inner as any).description;
			}
			return result;
		}

		case "union": {
			const options = def.options as z.ZodType[];
			return {
				anyOf: options.map((opt) => {
					const r = convertZodToJsonSchema(opt);
					if ((opt as any).description) {
						r.description = (opt as any).description;
					}
					return r;
				}),
			};
		}

		case "literal": {
			const values = def.values as unknown[];
			// JSON Schema uses "const" for a single literal value
			return { const: values[0] };
		}

		default:
			// Fallback: return empty schema (accepts anything)
			return {};
	}
}

/**
 * Basic runtime validation of data against an emitted JSON Schema.
 *
 * Not a full JSON Schema validator, but covers the common cases
 * produced by emitSchema: type checks, required fields, enums,
 * const, and recursive object/array validation.
 */
export function validateAgainstSchema(
	data: unknown,
	schema: EmittedSchema,
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];
	validate(data, schema, errors, "");
	return { valid: errors.length === 0, errors };
}

function validate(data: unknown, schema: EmittedSchema, errors: string[], path: string): void {
	// Handle anyOf (union)
	if (schema.anyOf) {
		const anyValid = (schema.anyOf as EmittedSchema[]).some((sub) => {
			const subErrors: string[] = [];
			validate(data, sub, subErrors, path);
			return subErrors.length === 0;
		});
		if (!anyValid) {
			errors.push(`${path || "value"} does not match any of the union types`);
		}
		return;
	}

	// Handle const (literal)
	if (schema.const !== undefined) {
		if (data !== schema.const) {
			errors.push(
				`${path || "value"} must be ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`,
			);
		}
		return;
	}

	// Handle enum
	if (schema.enum) {
		if (!schema.enum.includes(data)) {
			errors.push(
				`${path || "value"} must be one of [${schema.enum.map((v) => JSON.stringify(v)).join(", ")}], got ${JSON.stringify(data)}`,
			);
		}
		return;
	}

	// Type check
	if (schema.type) {
		const actualType = getJsonType(data);
		if (actualType !== schema.type) {
			errors.push(`${path || "value"} expected type "${schema.type}", got "${actualType}"`);
			return; // No point checking further if type is wrong
		}
	}

	// Object: check required fields and validate properties
	if (schema.type === "object" && schema.properties && typeof data === "object" && data !== null) {
		const obj = data as Record<string, unknown>;

		if (schema.required) {
			for (const field of schema.required) {
				if (!(field in obj)) {
					errors.push(`Missing required field: "${field}"`);
				}
			}
		}

		for (const [key, propSchema] of Object.entries(schema.properties)) {
			if (key in obj) {
				validate(obj[key], propSchema as EmittedSchema, errors, path ? `${path}.${key}` : key);
			}
		}
	}

	// Array: validate items
	if (schema.type === "array" && schema.items && Array.isArray(data)) {
		for (let i = 0; i < data.length; i++) {
			validate(data[i], schema.items as EmittedSchema, errors, `${path}[${i}]`);
		}
	}
}

function getJsonType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value; // "string", "number", "boolean", "object", "undefined"
}
