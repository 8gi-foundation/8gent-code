/**
 * Tests for the harness/host contract validator.
 *
 * Run:  bun test packages/runtime/contract-validator.test.ts
 *
 * Issue: #2086
 */

import { describe, expect, it } from "bun:test";
import type {
	HarnessCapability,
	HarnessHostContract,
	HostRequest,
} from "@8gent/types";
import { ContractViolationError } from "@8gent/types";
import {
	buildContract,
	createValidator,
	enforceRequest,
	formatDenial,
	matchTarget,
	validateRequest,
} from "./contract-validator.js";

// ---------------------------------------------------------------------------
// Target matching
// ---------------------------------------------------------------------------

describe("matchTarget", () => {
	it("wildcard matches anything", () => {
		expect(matchTarget("anything", "*")).toBe(true);
		expect(matchTarget("/etc/passwd", "*")).toBe(true);
	});

	it("exact match works", () => {
		expect(matchTarget("git", "git")).toBe(true);
		expect(matchTarget("git", "node")).toBe(false);
	});

	it("suffix patterns (*.example) match", () => {
		expect(matchTarget("api.openrouter.ai", "*.openrouter.ai")).toBe(true);
		expect(matchTarget("evil.api.openrouter.ai", "*.openrouter.ai")).toBe(true);
		expect(matchTarget("openrouter.ai", "*.openrouter.ai")).toBe(false);
		expect(matchTarget("openrouter.ai.evil.com", "*.openrouter.ai")).toBe(false);
	});

	it("prefix-slash-star (prefix/*) matches one segment", () => {
		expect(matchTarget("./src", "./*")).toBe(true);
		expect(matchTarget("./README.md", "./*")).toBe(true);
		expect(matchTarget("./src/index.ts", "./*")).toBe(false);
	});

	it("prefix-slash-double-star (prefix/**) matches multi-segment", () => {
		expect(matchTarget("./src", "./**")).toBe(true);
		expect(matchTarget("./src/foo/bar.ts", "./**")).toBe(true);
		expect(matchTarget("./", "./**")).toBe(true);
		expect(matchTarget("/etc/passwd", "./**")).toBe(false);
	});

	it("trailing-star matches simple prefix", () => {
		expect(matchTarget("/tmp/foo", "/tmp/*")).toBe(true);
		expect(matchTarget("/tmp/foo/bar", "/tmp/*")).toBe(false);
	});

	it("non-matching patterns return false", () => {
		expect(matchTarget("api.openai.com", "api.anthropic.com")).toBe(false);
		expect(matchTarget("git", "git ")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CLAUDE_CONTRACT: HarnessHostContract = {
	flavor: "claude",
	capabilities: [
		{
			category: "filesystem",
			actions: ["read", "write", "list"],
			targets: ["./*", "./**"],
		},
		{
			category: "network",
			actions: ["fetch"],
			targets: ["api.anthropic.com", "*.openrouter.ai"],
		},
		{
			category: "process",
			actions: ["spawn"],
			targets: ["git", "node"],
		},
		{
			category: "memory",
			actions: ["read", "write", "search"],
			targets: ["episodic", "semantic"],
		},
		{
			category: "tools",
			actions: ["execute", "list"],
			targets: ["read_file", "edit_file"],
		},
	],
};

// ---------------------------------------------------------------------------
// validateRequest
// ---------------------------------------------------------------------------

describe("validateRequest — allows", () => {
	it("allows declared filesystem read", () => {
		const req: HostRequest = {
			category: "filesystem",
			action: "read",
			target: "./src/index.ts",
		};
		expect(validateRequest(CLAUDE_CONTRACT, req)).toEqual({ ok: true });
	});

	it("allows declared network fetch with wildcard host", () => {
		const req: HostRequest = {
			category: "network",
			action: "fetch",
			target: "api.openrouter.ai",
		};
		expect(validateRequest(CLAUDE_CONTRACT, req)).toEqual({ ok: true });
	});

	it("allows declared process spawn", () => {
		const req: HostRequest = {
			category: "process",
			action: "spawn",
			target: "git",
		};
		expect(validateRequest(CLAUDE_CONTRACT, req)).toEqual({ ok: true });
	});

	it("allows declared memory read", () => {
		const req: HostRequest = {
			category: "memory",
			action: "read",
			target: "episodic",
		};
		expect(validateRequest(CLAUDE_CONTRACT, req)).toEqual({ ok: true });
	});

	it("allows declared tool execution", () => {
		const req: HostRequest = {
			category: "tools",
			action: "execute",
			target: "read_file",
		};
		expect(validateRequest(CLAUDE_CONTRACT, req)).toEqual({ ok: true });
	});
});

describe("validateRequest — denies with structured error", () => {
	it("denies missing category", () => {
		const noNetwork: HarnessHostContract = {
			flavor: "claude",
			capabilities: CLAUDE_CONTRACT.capabilities.filter(
				(c) => c.category !== "network",
			),
		};
		const req: HostRequest = {
			category: "network",
			action: "fetch",
			target: "api.anthropic.com",
		};
		const result = validateRequest(noNetwork, req);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected denial");
		expect(result.reason).toBe("missing_category");
		expect(result.missing.category).toBe("network");
		expect(result.flavor).toBe("claude");
		expect(result.message).toContain("network");
	});

	it("denies missing action", () => {
		const req: HostRequest = {
			category: "filesystem",
			action: "delete",
			target: "./src/index.ts",
		};
		const result = validateRequest(CLAUDE_CONTRACT, req);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected denial");
		expect(result.reason).toBe("missing_action");
		expect(result.missing.action).toBe("delete");
	});

	it("denies target not in allowlist", () => {
		const req: HostRequest = {
			category: "process",
			action: "spawn",
			target: "rm",
		};
		const result = validateRequest(CLAUDE_CONTRACT, req);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected denial");
		expect(result.reason).toBe("target_not_allowed");
		expect(result.missing.target).toBe("rm");
		expect(result.missing.action).toBe("spawn");
	});

	it("denies network host outside allowlist", () => {
		const req: HostRequest = {
			category: "network",
			action: "fetch",
			target: "evil.example.com",
		};
		const result = validateRequest(CLAUDE_CONTRACT, req);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected denial");
		expect(result.reason).toBe("target_not_allowed");
	});

	it("denies filesystem write outside repo glob", () => {
		const req: HostRequest = {
			category: "filesystem",
			action: "write",
			target: "/etc/passwd",
		};
		const result = validateRequest(CLAUDE_CONTRACT, req);
		expect(result.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// enforceRequest / createValidator / formatDenial
// ---------------------------------------------------------------------------

describe("enforceRequest", () => {
	it("returns silently when allowed", () => {
		expect(() =>
			enforceRequest(CLAUDE_CONTRACT, {
				category: "filesystem",
				action: "read",
				target: "./README.md",
			}),
		).not.toThrow();
	});

	it("throws ContractViolationError when denied", () => {
		expect(() =>
			enforceRequest(CLAUDE_CONTRACT, {
				category: "process",
				action: "spawn",
				target: "rm",
			}),
		).toThrow(ContractViolationError);
	});

	it("attaches the structured denial to the error", () => {
		try {
			enforceRequest(CLAUDE_CONTRACT, {
				category: "network",
				action: "fetch",
				target: "evil.example.com",
			});
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ContractViolationError);
			const violation = err as ContractViolationError;
			expect(violation.denial.ok).toBe(false);
			expect(violation.denial.reason).toBe("target_not_allowed");
			expect(violation.denial.flavor).toBe("claude");
		}
	});
});

describe("createValidator", () => {
	it("returns a curried validator bound to one contract", () => {
		const check = createValidator(CLAUDE_CONTRACT);
		const allow = check({
			category: "memory",
			action: "search",
			target: "semantic",
		});
		const deny = check({
			category: "memory",
			action: "delete",
			target: "semantic",
		});
		expect(allow.ok).toBe(true);
		expect(deny.ok).toBe(false);
	});
});

describe("formatDenial", () => {
	it("formats allow as a one-liner", () => {
		expect(formatDenial({ ok: true })).toBe("[contract] allow");
	});

	it("formats denial with all available fields", () => {
		const formatted = formatDenial({
			ok: false,
			reason: "target_not_allowed",
			missing: {
				category: "process",
				action: "spawn",
				target: "rm",
			},
			message: "x",
			flavor: "claude",
		});
		expect(formatted).toContain("flavor=claude");
		expect(formatted).toContain("reason=target_not_allowed");
		expect(formatted).toContain("category=process");
		expect(formatted).toContain("action=spawn");
		expect(formatted).toContain("target=rm");
	});
});

// ---------------------------------------------------------------------------
// buildContract — flavor wiring
// ---------------------------------------------------------------------------

describe("buildContract", () => {
	it("builds a contract for the claude flavor", () => {
		const contract = buildContract("claude");
		expect(contract.flavor).toBe("claude");
		expect(contract.capabilities.length).toBeGreaterThan(0);
		const categories = new Set(contract.capabilities.map((c) => c.category));
		expect(categories.has("filesystem")).toBe(true);
		expect(categories.has("network")).toBe(true);
		expect(categories.has("process")).toBe(true);
		expect(categories.has("memory")).toBe(true);
		expect(categories.has("tools")).toBe(true);
	});

	it("builds a contract for the openclaw flavor", () => {
		const contract = buildContract("openclaw");
		expect(contract.flavor).toBe("openclaw");
		expect(contract.capabilities.length).toBeGreaterThan(0);
	});

	it("hermes is read-mostly: no filesystem write, no process kill", () => {
		const contract = buildContract("hermes");
		const fs = contract.capabilities.find((c) => c.category === "filesystem");
		expect(fs).toBeDefined();
		expect((fs!.actions as readonly string[]).includes("write")).toBe(false);
		expect((fs!.actions as readonly string[]).includes("delete")).toBe(false);
		const proc = contract.capabilities.find((c) => c.category === "process");
		expect(proc).toBeDefined();
		expect((proc!.actions as readonly string[]).includes("kill")).toBe(false);
	});

	it("throws on unknown flavor", () => {
		expect(() => buildContract("nonexistent")).toThrow(/Unknown harness flavor/);
	});

	it("attaches metadata when provided", () => {
		const contract = buildContract("claude", {
			metadata: { spawnId: "abc123" },
		});
		expect(contract.metadata).toEqual({ spawnId: "abc123" });
	});

	it("applies narrow function to subset capabilities", () => {
		const contract = buildContract("claude", {
			narrow: (caps: HarnessCapability[]) =>
				caps.filter((c) => c.category === "filesystem"),
		});
		expect(contract.capabilities.length).toBeGreaterThan(0);
		for (const cap of contract.capabilities) {
			expect(cap.category).toBe("filesystem");
		}
	});
});

// ---------------------------------------------------------------------------
// End-to-end: hermes is locked down vs claude
// ---------------------------------------------------------------------------

describe("flavor differences", () => {
	it("hermes denies a write that claude would allow", () => {
		const claude = buildContract("claude");
		const hermes = buildContract("hermes");
		const writeRequest: HostRequest = {
			category: "filesystem",
			action: "write",
			target: "./src/foo.ts",
		};
		expect(validateRequest(claude, writeRequest).ok).toBe(true);
		expect(validateRequest(hermes, writeRequest).ok).toBe(false);
	});

	it("openclaw allows broader fetch than claude", () => {
		const claude = buildContract("claude");
		const openclaw = buildContract("openclaw");
		const fetchRequest: HostRequest = {
			category: "network",
			action: "fetch",
			target: "github.com",
		};
		expect(validateRequest(claude, fetchRequest).ok).toBe(false);
		expect(validateRequest(openclaw, fetchRequest).ok).toBe(true);
	});
});
