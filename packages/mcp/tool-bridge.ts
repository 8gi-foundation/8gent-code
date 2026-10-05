/**
 * MCP Tool Bridge
 *
 * Converts MCP tool schemas into Vercel AI SDK tool() objects.
 * Namespaces tools as mcp__{server}__{tool} to avoid collisions.
 *
 * The server's JSON Schema is passed through as declared (#3546), so enums,
 * array item types, type lists and nested combinators reach the model. A
 * top-level anyOf/oneOf/allOf is flattened into one object because some
 * providers reject the combinator there. EIGHT_MCP_LEGACY_SCHEMA=1 restores
 * the old hand-written zod converter.
 */

import { jsonSchema, tool } from "ai";
import type { FlexibleSchema, JSONSchema7, ToolSet } from "ai";
import { z } from "zod";
import { gateMcpCall } from "../permissions/mcp-gate";
import type { MCPClient } from "./client";

// ── Types ────────────────────────────────────────────────────────

export interface MCPToolSchema {
	name: string;
	description?: string;
	inputSchema?: {
		type: string;
		properties?: Record<string, any>;
		required?: string[];
		[key: string]: unknown;
	};
}

// ── Schema Passthrough ───────────────────────────────────────────

const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asStrings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Return the server's input schema as a top-level object schema, without
 * mutating it. A top-level anyOf/oneOf/allOf has its branch properties merged
 * into one flat object: for allOf every branch's required fields stay
 * required, for anyOf/oneOf only fields required in every branch do.
 */
export function normalizeMcpInputSchema(schema: MCPToolSchema["inputSchema"]): JsonObject {
	const out: JsonObject = { ...asObject(schema) };
	const properties: JsonObject = { ...asObject(out.properties) };
	const required = new Set(asStrings(out.required));

	for (const key of COMBINATORS) {
		const branches = out[key];
		if (!Array.isArray(branches)) continue;
		Reflect.deleteProperty(out, key);
		const branchRequired: Set<string>[] = [];
		for (const raw of branches) {
			const branch = asObject(raw);
			for (const [name, prop] of Object.entries(asObject(branch.properties))) {
				if (!(name in properties)) properties[name] = prop;
			}
			const req = new Set(asStrings(branch.required));
			if (key === "allOf") {
				for (const r of req) required.add(r);
			} else {
				branchRequired.push(req);
			}
		}
		const [first, ...rest] = branchRequired;
		for (const r of first ?? []) {
			if (rest.every((req) => req.has(r))) required.add(r);
		}
	}

	out.type = "object";
	out.properties = properties;
	if (required.size > 0) out.required = [...required];
	else Reflect.deleteProperty(out, "required");
	return out;
}

// ── Legacy Schema Converter (EIGHT_MCP_LEGACY_SCHEMA=1) ──────────

/**
 * Convert a JSON Schema properties object to a Zod schema.
 * Handles basic types (string, number, boolean, integer, array, object).
 * Falls back to z.any() for unknown types.
 */
function jsonSchemaToZod(
	properties: Record<string, any>,
	required: string[] = [],
): z.ZodObject<any> {
	const shape: Record<string, z.ZodTypeAny> = {};

	for (const [key, prop] of Object.entries(properties)) {
		let field: z.ZodTypeAny;

		switch (prop.type) {
			case "string":
				field = z.string();
				break;
			case "number":
			case "integer":
				field = z.number();
				break;
			case "boolean":
				field = z.boolean();
				break;
			case "array":
				field = z.array(z.any());
				break;
			case "object":
				if (prop.properties) {
					field = jsonSchemaToZod(prop.properties, prop.required || []);
				} else {
					field = z.record(z.string(), z.any());
				}
				break;
			default:
				field = z.any();
		}

		if (prop.description) {
			field = field.describe(prop.description);
		}

		if (!required.includes(key)) {
			field = field.optional();
		}

		shape[key] = field;
	}

	return z.object(shape);
}

// ── Bridge ───────────────────────────────────────────────────────

/**
 * Build a namespace key for an MCP tool.
 * Format: mcp__{serverName}__{toolName}
 */
export function mcpToolKey(serverName: string, toolName: string): string {
	return `mcp__${serverName}__${toolName}`;
}

/**
 * Parse a namespaced tool key back into server + tool name.
 * Returns null if the key doesn't match the mcp__*__* pattern.
 */
export function parseMcpToolKey(key: string): { server: string; tool: string } | null {
	const match = key.match(/^mcp__([^_]+)__(.+)$/);
	if (!match) return null;
	return { server: match[1], tool: match[2] };
}

/**
 * Convert discovered MCP tools from a server into AI SDK ToolSet entries.
 * Each tool calls back through the MCPClient to execute on the remote server.
 */
export function bridgeTools(
	serverName: string,
	tools: MCPToolSchema[],
	client: MCPClient,
): ToolSet {
	const result: ToolSet = {};

	for (const mcpTool of tools) {
		const key = mcpToolKey(serverName, mcpTool.name);

		// Pass the server's schema through; the legacy switch rebuilds it in zod
		let inputSchema: FlexibleSchema<Record<string, unknown>>;
		if (process.env.EIGHT_MCP_LEGACY_SCHEMA === "1") {
			inputSchema = mcpTool.inputSchema?.properties
				? jsonSchemaToZod(mcpTool.inputSchema.properties, mcpTool.inputSchema.required || [])
				: z.object({});
		} else {
			inputSchema = jsonSchema<Record<string, unknown>>(
				normalizeMcpInputSchema(mcpTool.inputSchema) as JSONSchema7,
			);
		}

		const description = mcpTool.description
			? `[MCP:${serverName}] ${mcpTool.description}`
			: `[MCP:${serverName}] ${mcpTool.name}`;

		result[key] = tool({
			description,
			inputSchema,
			execute: async (args: Record<string, unknown>) => {
				// Policy, then the person, before anything reaches the server
				// (#3230). The agent scope is not known here; "primary" gets the
				// default ask, never a silent allow.
				const refusal = await gateMcpCall("primary", serverName, mcpTool.name, args);
				if (refusal) return refusal;
				const mcpResult = await client.callTool(serverName, mcpTool.name, args);
				// Flatten MCP content array to string for AI SDK
				if (!mcpResult?.content) return "No result";
				return mcpResult.content
					.map((c: any) => {
						if (c.type === "text") return c.text || "";
						if (c.type === "image") return `[Image: ${c.mimeType || "image"}]`;
						return `[${c.type}]`;
					})
					.join("\n");
			},
		});
	}

	return result;
}
