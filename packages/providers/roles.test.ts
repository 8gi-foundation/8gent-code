import { describe, expect, test } from "bun:test";
import type { RolesSettings } from "../settings/schema";
import { describeRoles, resolveRole } from "./roles";

const session = { provider: "ollama", model: "qwen3:14b" };
const keys = (...have: string[]) => (p: string) => have.includes(p) || p === "ollama";

describe("resolveRole", () => {
	test("no roles set: every role is the session's own", () => {
		for (const role of ["main", "small", "slow"] as const) {
			const r = resolveRole(role, undefined, session);
			expect(r.target).toEqual(session);
			expect(r.source).toBe(role === "main" ? "session" : "main");
		}
		expect(resolveRole("small", {}, session).target).toEqual(session);
	});

	test("small set: used for small, main untouched", () => {
		const roles: RolesSettings = { small: { provider: "ollama", model: "tiny:1b" } };
		expect(resolveRole("small", roles, session).target.model).toBe("tiny:1b");
		expect(resolveRole("main", roles, session).target).toEqual(session);
	});

	test("small unset falls back to main when main is set", () => {
		const roles: RolesSettings = { main: { provider: "openrouter", model: "big" } };
		const r = resolveRole("small", roles, session, keys("openrouter"));
		expect(r.target.model).toBe("big");
		expect(r.source).toBe("main");
	});

	test("a provider with no credentials is skipped, the next in the chain wins", () => {
		const roles: RolesSettings = {
			small: [
				{ provider: "openrouter", model: "x" },
				{ provider: "ollama", model: "tiny:1b" },
			],
		};
		const r = resolveRole("small", roles, session, keys());
		expect(r.target).toEqual({ provider: "ollama", model: "tiny:1b" });
		expect(r.skipped).toEqual(["openrouter"]);
	});

	test("every entry keyless: falls back to main, then the session", () => {
		const roles: RolesSettings = { small: { provider: "openrouter", model: "x" } };
		const r = resolveRole("small", roles, session, keys());
		expect(r.target).toEqual(session);
		expect(r.skipped).toEqual(["openrouter"]);
	});

	test("malformed entries are ignored", () => {
		const roles = { small: { provider: "", model: "x" } } as unknown as RolesSettings;
		expect(resolveRole("small", roles, session).target).toEqual(session);
	});
});

describe("describeRoles", () => {
	test("one line per role", () => {
		const lines = describeRoles({ small: { provider: "ollama", model: "tiny:1b" } }, session);
		expect(lines).toEqual([
			"main: ollama/qwen3:14b (session default)",
			"small: ollama/tiny:1b",
			"slow: ollama/qwen3:14b (main)",
		]);
	});
});
