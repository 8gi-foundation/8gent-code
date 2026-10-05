/**
 * MCP tool schemas reach the model as the server declared them (#3546).
 *
 * The bridge used to rebuild each tool's parameters from `properties` only,
 * so enums, array item types, type lists and top-level either-or tools were
 * dropped, and the strict object stripped values sent for dropped fields.
 * The server's schema is now passed through; a top-level anyOf/oneOf/allOf is
 * flattened into one object because some providers reject the combinator.
 * EIGHT_MCP_LEGACY_SCHEMA=1 restores the old converter.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import { createPermissionHolder, runWithPermissionHolder } from "../permissions/permission-mode";
import {
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
} from "../permissions/tui-approval-channel";
import type { MCPClient } from "./client";
import { type MCPToolSchema, bridgeTools } from "./tool-bridge";

const prevLegacy = process.env.EIGHT_MCP_LEGACY_SCHEMA;
const prevHeadless = process.env.EIGHT_HEADLESS;
// The default-path tests must not depend on the caller's shell.
beforeEach(() => {
	Reflect.deleteProperty(process.env, "EIGHT_MCP_LEGACY_SCHEMA");
});
afterEach(() => {
	_resetTuiApprovalChannel();
	if (prevLegacy === undefined) Reflect.deleteProperty(process.env, "EIGHT_MCP_LEGACY_SCHEMA");
	else process.env.EIGHT_MCP_LEGACY_SCHEMA = prevLegacy;
	if (prevHeadless === undefined) Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
	else process.env.EIGHT_HEADLESS = prevHeadless;
});

let received: Array<Record<string, unknown> | undefined> = [];
const client = {
	callTool: async (_server: string, _tool: string, args?: Record<string, unknown>) => {
		received.push(args);
		return { content: [{ type: "text", text: "ok" }] };
	},
} as unknown as MCPClient;

type Bridged = { inputSchema: unknown; execute: (i: unknown, o: unknown) => Promise<string> };

function bridgeOne(schema: MCPToolSchema["inputSchema"]): Bridged {
	const tools = bridgeTools("srv", [{ name: "t", inputSchema: schema }], client);
	return tools.mcp__srv__t as unknown as Bridged;
}

/** The JSON Schema the model is shown for a bridged tool. */
async function shown(t: Bridged): Promise<any> {
	return await asSchema(t.inputSchema as Parameters<typeof asSchema>[0]).jsonSchema;
}

/** What the AI SDK hands to execute after validating the model's input. */
async function parsed(t: Bridged, value: unknown): Promise<unknown> {
	const s = asSchema(t.inputSchema as Parameters<typeof asSchema>[0]);
	if (!s.validate) return value;
	const r = await s.validate(value);
	if (!r.success) throw r.error;
	return r.value;
}

describe("MCP schema passthrough", () => {
	test("enum values are shown to the model", async () => {
		const t = bridgeOne({
			type: "object",
			properties: { action: { type: "string", enum: ["list", "create", "delete"] } },
			required: ["action"],
		});
		const js = await shown(t);
		expect(js.properties.action.enum).toEqual(["list", "create", "delete"]);
		expect(js.required).toEqual(["action"]);
	});

	test("array item types are shown to the model", async () => {
		const t = bridgeOne({
			type: "object",
			properties: { ids: { type: "array", items: { type: "integer" } } },
		});
		const js = await shown(t);
		expect(js.properties.ids.items).toEqual({ type: "integer" });
	});

	test("a nullable type list is shown to the model", async () => {
		const t = bridgeOne({
			type: "object",
			properties: { limit: { type: ["integer", "null"] } },
		});
		const js = await shown(t);
		expect(js.properties.limit.type).toEqual(["integer", "null"]);
	});

	test("an either-or tool is flattened and its argument reaches the server", async () => {
		const t = bridgeOne({
			type: "object",
			oneOf: [
				{ properties: { id: { type: "string" } }, required: ["id"] },
				{ properties: { name: { type: "string" } }, required: ["name"] },
			],
		} as MCPToolSchema["inputSchema"]);
		const js = await shown(t);
		expect(js.type).toBe("object");
		expect(js.oneOf).toBeUndefined();
		expect(Object.keys(js.properties).sort()).toEqual(["id", "name"]);
		// Neither field is required in every branch.
		expect(js.required ?? []).toEqual([]);

		const args = await parsed(t, { id: "42" });
		expect(args).toEqual({ id: "42" });

		received = [];
		registerTuiApprovalHandler(async () => "approve");
		Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
		await runWithPermissionHolder(createPermissionHolder("ask"), () => t.execute(args, {}));
		expect(received).toEqual([{ id: "42" }]);
	});

	test("allOf branches merge their required fields", async () => {
		const t = bridgeOne({
			type: "object",
			allOf: [
				{ properties: { a: { type: "string" } }, required: ["a"] },
				{ properties: { b: { type: "number" } }, required: ["b"] },
			],
		} as MCPToolSchema["inputSchema"]);
		const js = await shown(t);
		expect(js.allOf).toBeUndefined();
		expect(Object.keys(js.properties).sort()).toEqual(["a", "b"]);
		expect([...js.required].sort()).toEqual(["a", "b"]);
	});

	test("branch properties named like Object.prototype members are kept", async () => {
		const branchProps = JSON.parse(
			'{"constructor":{"type":"string"},"toString":{"type":"string"},"__proto__":{"type":"integer"}}',
		);
		const t = bridgeOne({
			type: "object",
			oneOf: [{ properties: branchProps, required: ["constructor"] }],
		} as MCPToolSchema["inputSchema"]);
		const js = await shown(t);
		expect(Object.keys(js.properties).sort()).toEqual(["__proto__", "constructor", "toString"]);
		expect(Object.hasOwn(js.properties, "__proto__")).toBe(true);
		expect(js.properties.constructor).toEqual({ type: "string" });
		expect(js.properties.toString).toEqual({ type: "string" });
		expect(js.required).toEqual(["constructor"]);
		// The global prototype is untouched.
		expect(({} as Record<string, unknown>).type).toBeUndefined();
	});

	test("a tool with no schema is an empty object", async () => {
		const js = await shown(bridgeOne(undefined));
		expect(js.type).toBe("object");
		expect(js.properties).toEqual({});
	});

	test("the server's schema object is not mutated", () => {
		const schema = {
			type: "object",
			anyOf: [{ properties: { x: { type: "string" } } }],
		} as MCPToolSchema["inputSchema"];
		const before = JSON.stringify(schema);
		bridgeOne(schema);
		expect(JSON.stringify(schema)).toBe(before);
	});
});

describe("EIGHT_MCP_LEGACY_SCHEMA=1", () => {
	test("restores the old converter, which drops the enum", async () => {
		process.env.EIGHT_MCP_LEGACY_SCHEMA = "1";
		const t = bridgeOne({
			type: "object",
			properties: { action: { type: "string", enum: ["list", "create"] } },
		});
		const js = await shown(t);
		expect(js.properties.action.type).toBe("string");
		expect(js.properties.action.enum).toBeUndefined();
	});
});
