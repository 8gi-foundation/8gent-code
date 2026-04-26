import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { emitSchema, validateAgainstSchema } from "./schema-gen";

describe("emitSchema", () => {
	it("emits JSON Schema for a simple object (name: string, age: number)", () => {
		const schema = z.object({ name: z.string(), age: z.number() });
		const result = emitSchema(schema);

		expect(result.type).toBe("object");
		expect(result.properties).toEqual({
			name: { type: "string" },
			age: { type: "number" },
		});
		expect(result.required).toEqual(["name", "age"]);
	});

	it("marks optional fields as not required", () => {
		const schema = z.object({
			name: z.string(),
			nickname: z.string().optional(),
		});
		const result = emitSchema(schema);

		expect(result.type).toBe("object");
		expect(result.required).toEqual(["name"]);
		expect(result.properties).toHaveProperty("nickname");
		expect((result.properties as Record<string, any>).nickname).toEqual({
			type: "string",
		});
	});

	it("handles z.array with items", () => {
		const schema = z.array(z.string());
		const result = emitSchema(schema);

		expect(result.type).toBe("array");
		expect(result.items).toEqual({ type: "string" });
	});

	it("handles z.enum", () => {
		const schema = z.enum(["red", "green", "blue"]);
		const result = emitSchema(schema);

		expect(result.type).toBe("string");
		expect(result.enum).toEqual(["red", "green", "blue"]);
	});

	it("handles z.union / anyOf", () => {
		const schema = z.union([z.string(), z.number()]);
		const result = emitSchema(schema);

		expect(result.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
	});

	it("preserves descriptions from .describe()", () => {
		const schema = z.string().describe("A user's full name");
		const result = emitSchema(schema);

		expect(result.type).toBe("string");
		expect(result.description).toBe("A user's full name");
	});

	it("handles nested objects", () => {
		const schema = z.object({
			user: z.object({
				name: z.string(),
				email: z.string(),
			}),
		});
		const result = emitSchema(schema);

		expect(result.type).toBe("object");
		expect(result.properties).toEqual({
			user: {
				type: "object",
				properties: {
					name: { type: "string" },
					email: { type: "string" },
				},
				required: ["name", "email"],
			},
		});
		expect(result.required).toEqual(["user"]);
	});

	it("handles z.literal", () => {
		const schema = z.literal("active");
		const result = emitSchema(schema);

		expect(result.const).toBe("active");
	});

	it("handles z.boolean", () => {
		const schema = z.boolean();
		const result = emitSchema(schema);

		expect(result.type).toBe("boolean");
	});

	it("preserves descriptions on objects", () => {
		const schema = z
			.object({ id: z.number() })
			.describe("A resource identifier");
		const result = emitSchema(schema);

		expect(result.type).toBe("object");
		expect(result.description).toBe("A resource identifier");
	});

	it("handles arrays of objects", () => {
		const schema = z.array(z.object({ tag: z.string() }));
		const result = emitSchema(schema);

		expect(result.type).toBe("array");
		expect(result.items).toEqual({
			type: "object",
			properties: { tag: { type: "string" } },
			required: ["tag"],
		});
	});
});

describe("validateAgainstSchema", () => {
	it("validates a valid object", () => {
		const schema = emitSchema(z.object({ name: z.string(), age: z.number() }));
		const result = validateAgainstSchema({ name: "Alice", age: 30 }, schema);

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("rejects an object with wrong type at top level", () => {
		const schema = emitSchema(z.string());
		const result = validateAgainstSchema(42, schema);

		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it("rejects an object missing required fields", () => {
		const schema = emitSchema(z.object({ name: z.string(), age: z.number() }));
		const result = validateAgainstSchema({ name: "Alice" }, schema);

		expect(result.valid).toBe(false);
		expect(result.errors).toContain('Missing required field: "age"');
	});

	it("validates enum values", () => {
		const schema = emitSchema(z.enum(["red", "green", "blue"]));

		expect(validateAgainstSchema("red", schema).valid).toBe(true);
		expect(validateAgainstSchema("yellow", schema).valid).toBe(false);
	});

	it("validates array types", () => {
		const schema = emitSchema(z.array(z.string()));

		expect(validateAgainstSchema(["a", "b"], schema).valid).toBe(true);
		expect(validateAgainstSchema("not-array", schema).valid).toBe(false);
	});

	it("validates nested object properties", () => {
		const schema = emitSchema(
			z.object({
				user: z.object({ name: z.string() }),
			}),
		);

		const valid = validateAgainstSchema({ user: { name: "Bob" } }, schema);
		expect(valid.valid).toBe(true);

		const invalid = validateAgainstSchema({ user: { name: 123 } }, schema);
		expect(invalid.valid).toBe(false);
	});

	it("validates boolean type", () => {
		const schema = emitSchema(z.boolean());

		expect(validateAgainstSchema(true, schema).valid).toBe(true);
		expect(validateAgainstSchema("true", schema).valid).toBe(false);
	});

	it("validates const/literal values", () => {
		const schema = emitSchema(z.literal("active"));

		expect(validateAgainstSchema("active", schema).valid).toBe(true);
		expect(validateAgainstSchema("inactive", schema).valid).toBe(false);
	});
});
