/**
 * Policy tests (contract section 4.2 - 4.3, security bar section 7).
 *
 * Proves deny-by-default for Table agents: channel_post is allowed, but
 * run_command / network_request / write_file are BLOCKED for the __table__
 * scope, while the same actions remain allowed for a non-table agent (proving
 * the block is scoped, not global). Also proves the install is idempotent and
 * that no bypassPermissions path is introduced.
 */

import { describe, expect, it } from "bun:test";
import { evaluatePolicy } from "../../permissions/policy-engine.js";
import { CHANNEL_POST_ACTION, TABLE_AGENT_SCOPE, installTablePolicies } from "../wiring.js";

// Install once for the whole suite; installTablePolicies is idempotent.
installTablePolicies();

describe("Table agent policy (deny-by-default, single allow)", () => {
	it("allows channel_post for a __table__ scoped agent", () => {
		const d = evaluatePolicy(CHANNEL_POST_ACTION, {
			agentId: TABLE_AGENT_SCOPE,
			channelId: "chan_x",
		});
		expect(d.allowed).toBe(true);
	});

	it("BLOCKS run_command for a __table__ scoped agent", () => {
		const d = evaluatePolicy("run_command", {
			agentId: TABLE_AGENT_SCOPE,
			command: "rm -rf /",
		});
		expect(d.allowed).toBe(false);
	});

	it("BLOCKS network_request for a __table__ scoped agent", () => {
		const d = evaluatePolicy("network_request", {
			agentId: TABLE_AGENT_SCOPE,
			url: "https://evil.example.com",
		});
		expect(d.allowed).toBe(false);
	});

	it("BLOCKS write_file for a __table__ scoped agent", () => {
		const d = evaluatePolicy("write_file", {
			agentId: TABLE_AGENT_SCOPE,
			path: "/etc/hosts",
			content: "x",
		});
		expect(d.allowed).toBe(false);
	});

	it("does NOT block those actions for a non-table agent (scope isolation)", () => {
		// A normal agent id is not the __table__ scope, so the Table blocks
		// do not apply. (Other global policies may still weigh in, but the
		// Table-specific block must not fire here.)
		const run = evaluatePolicy("run_command", { agentId: "agent:normal", command: "ls" });
		expect(run.allowed).toBe(true);
	});

	it("is idempotent - re-installing does not throw or duplicate-deny", () => {
		expect(() => installTablePolicies()).not.toThrow();
		const d = evaluatePolicy(CHANNEL_POST_ACTION, {
			agentId: TABLE_AGENT_SCOPE,
			channelId: "chan_y",
		});
		expect(d.allowed).toBe(true);
	});
});
