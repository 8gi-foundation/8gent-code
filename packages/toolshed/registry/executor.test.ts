import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExecutionContext, ToolRegistration } from "../../types";
import { clearCapabilityAuditLog, getCapabilityAuditLog } from "./audit";
import {
	DEFAULT_GRANTED_TIERS,
	canInvoke,
	checkCapability,
	executeTool,
	isCapabilityDenial,
} from "./executor";
import { clearRegistry, getTool, registerTool } from "./register";

const baseSchema = { type: "object" };

const sandbox: ExecutionContext["sandbox"] = {
	type: "none",
	allowedPaths: [],
	networkAccess: false,
	timeout: 0,
};

function ctx(grantedTiers?: ExecutionContext["grantedTiers"]): ExecutionContext {
	return {
		sessionId: "test-session",
		workingDirectory: "/tmp/test",
		permissions: [],
		sandbox,
		grantedTiers,
	};
}

const readTool: ToolRegistration = {
	name: "reader",
	description: "Reads stuff",
	capabilities: ["code"],
	inputSchema: baseSchema,
	permissions: ["read:fs"],
	tiers: ["read"],
};

const writeTool: ToolRegistration = {
	name: "writer",
	description: "Writes stuff",
	capabilities: ["code"],
	inputSchema: baseSchema,
	permissions: ["write:fs"],
	tiers: ["read", "write"],
};

const pushTool: ToolRegistration = {
	name: "pusher",
	description: "Pushes to remote",
	capabilities: ["github"],
	inputSchema: baseSchema,
	permissions: ["github:write"],
	tiers: ["execute", "network", "dangerous"],
};

beforeEach(() => {
	clearRegistry();
	clearCapabilityAuditLog();
	registerTool(readTool, async () => "read-ok");
	registerTool(writeTool, async () => "write-ok");
	registerTool(pushTool, async () => "push-ok");
});

afterEach(() => {
	clearRegistry();
	clearCapabilityAuditLog();
});

describe("checkCapability", () => {
	it("allows when every required tier is granted", () => {
		const r = checkCapability(["read", "write"], ["read", "write", "execute"]);
		expect(r.allowed).toBe(true);
		expect(r.missing).toEqual([]);
	});

	it("denies and reports missing tiers when grant is partial", () => {
		const r = checkCapability(["read", "write"], ["read"]);
		expect(r.allowed).toBe(false);
		expect(r.missing).toEqual(["write"]);
	});

	it("denies with full required list when grant is empty", () => {
		const r = checkCapability(["execute", "network"], []);
		expect(r.allowed).toBe(false);
		expect(r.missing).toEqual(["execute", "network"]);
	});
});

describe("executeTool — capability gate", () => {
	it("invokes a read-tier tool when only read is granted", async () => {
		const result = await executeTool("reader", {}, ctx(["read"]));
		expect(result).toBe("read-ok");
		expect(getCapabilityAuditLog()).toHaveLength(0);
	});

	it("blocks a write-tier tool when only read is granted", async () => {
		const result = await executeTool("writer", {}, ctx(["read"]));
		expect(isCapabilityDenial(result)).toBe(true);
		if (!isCapabilityDenial(result)) throw new Error("unreachable");
		expect(result.tool).toBe("writer");
		expect(result.required).toEqual(["read", "write"]);
		expect(result.missing).toEqual(["write"]);
		expect(result.granted).toEqual(["read"]);
		expect(result.message).toContain("write");
	});

	it("blocks a tool that needs execute+network+dangerous when only read is granted", async () => {
		const result = await executeTool("pusher", {}, ctx(["read"]));
		expect(isCapabilityDenial(result)).toBe(true);
		if (!isCapabilityDenial(result)) throw new Error("unreachable");
		expect(result.missing).toEqual(["execute", "network", "dangerous"]);
	});

	it("invokes a write-tier tool when read+write are granted", async () => {
		const result = await executeTool("writer", {}, ctx(["read", "write"]));
		expect(result).toBe("write-ok");
	});

	it("uses DEFAULT_GRANTED_TIERS when context omits grantedTiers", async () => {
		expect(DEFAULT_GRANTED_TIERS).toEqual(["read"]);
		const allowed = await executeTool("reader", {}, ctx(undefined));
		expect(allowed).toBe("read-ok");

		const blocked = await executeTool("writer", {}, ctx(undefined));
		expect(isCapabilityDenial(blocked)).toBe(true);
	});

	it("throws when the tool name is unknown", async () => {
		await expect(executeTool("ghost", {}, ctx(["read"]))).rejects.toThrow(/Tool not found/);
	});
});

describe("executeTool — audit log", () => {
	it("writes an audit entry on capability denial", async () => {
		expect(getCapabilityAuditLog()).toHaveLength(0);

		const result = await executeTool("writer", {}, ctx(["read"]));
		expect(isCapabilityDenial(result)).toBe(true);

		const entries = getCapabilityAuditLog();
		expect(entries).toHaveLength(1);
		const entry = entries[0];
		expect(entry.sessionId).toBe("test-session");
		expect(entry.tool).toBe("writer");
		expect(entry.required).toEqual(["read", "write"]);
		expect(entry.missing).toEqual(["write"]);
		expect(entry.granted).toEqual(["read"]);
		expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(typeof entry.reason).toBe("string");
	});

	it("does not write an audit entry on allowed invocation", async () => {
		await executeTool("reader", {}, ctx(["read"]));
		expect(getCapabilityAuditLog()).toHaveLength(0);
	});

	it("respects a custom audit hook (no entry recorded by default sink)", async () => {
		let captured = null as null | { tool: string; missing: string[] };
		const result = await executeTool("writer", {}, ctx(["read"]), {
			audit: (denial) => {
				captured = { tool: denial.tool, missing: denial.missing };
			},
		});
		expect(isCapabilityDenial(result)).toBe(true);
		expect(captured).toEqual({ tool: "writer", missing: ["write"] });
		// Custom audit replaces the default recorder.
		expect(getCapabilityAuditLog()).toHaveLength(0);
	});
});

describe("registerTool — tier enforcement at runtime", () => {
	it("rejects a registration that lacks tiers (cast through any)", () => {
		const bad = {
			name: "untiered",
			description: "no tiers",
			capabilities: ["code"],
			inputSchema: baseSchema,
			permissions: [],
		} as unknown as ToolRegistration;
		expect(() => registerTool(bad, async () => "nope")).toThrow(/at least one capability tier/);
	});

	it("indexes tiers on the stored Tool object", () => {
		const stored = getTool("writer");
		expect(stored).toBeDefined();
		expect(stored?.tiers).toEqual(["read", "write"]);
	});
});

describe("canInvoke", () => {
	it("returns true when grant covers required tiers", () => {
		const t = getTool("writer")!;
		expect(canInvoke(t, ["read", "write"])).toBe(true);
	});

	it("returns false when grant is missing a required tier", () => {
		const t = getTool("writer")!;
		expect(canInvoke(t, ["read"])).toBe(false);
	});
});
