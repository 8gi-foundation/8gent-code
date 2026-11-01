/**
 * Tests for skill capability scoping (issue #2760, Step 2).
 *
 * Covers:
 *   - capabilityForRequest maps each request kind to its manifest capability
 *   - skillEnvelope is the union of required + granted capabilities
 *   - a skill with no declarations is unscoped (envelope gate skipped)
 *   - a scoped skill is denied a capability it did not declare, before the tool
 *     manifest is consulted
 *   - a scoped skill that declared the capability still passes to the tool gate,
 *     which then allows an in-scope request and denies an out-of-scope one
 *   - required-only and granted-only declarations both open the envelope
 *   - SkillManager.enforceSkillCapability resolves the skill, denies unknowns,
 *     and applies the same two-gate result
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetToolManifests } from "../permissions/capability-manifest.js";
import type { CapabilityRequest } from "../permissions/capability-manifest.js";
import {
	SkillManager,
	capabilityForRequest,
	enforceSkillScope,
	isSkillScoped,
	skillEnvelope,
} from "./index.js";
import type { Skill } from "./index.js";

afterEach(() => {
	resetToolManifests();
});

function skill(overrides: Partial<Skill> = {}): Skill {
	return {
		name: "deploy",
		description: "Deploy the app",
		prompt: "do the thing",
		tools: [],
		filePath: "/skills/deploy.md",
		requiredCapabilities: [],
		grantedCapabilities: [],
		modelsRequired: [],
		entryPoints: [],
		...overrides,
	};
}

// A workspace path is inside write_file's declared ${workspace} scope.
const opts = { workingDirectory: process.cwd() };
const inWs: CapabilityRequest = {
	kind: "fs_read",
	path: join(process.cwd(), "src/x.ts"),
};
const inWsWrite: CapabilityRequest = {
	kind: "fs_write",
	path: join(process.cwd(), "src/x.ts"),
};

describe("capabilityForRequest", () => {
	it("maps each request kind to its manifest capability token", () => {
		expect(capabilityForRequest("fs_read")).toBe("filesystem-read");
		expect(capabilityForRequest("fs_write")).toBe("filesystem-write");
		expect(capabilityForRequest("network")).toBe("network");
		expect(capabilityForRequest("exec")).toBe("shell");
	});
});

describe("skillEnvelope + isSkillScoped", () => {
	it("is the union of required and granted capabilities", () => {
		const env = skillEnvelope(
			skill({
				requiredCapabilities: ["filesystem-read"],
				grantedCapabilities: ["network"],
			}),
		);
		expect([...env].sort()).toEqual(["filesystem-read", "network"]);
	});

	it("treats a skill with no declarations as unscoped", () => {
		expect(isSkillScoped(skill())).toBe(false);
	});

	it("treats a skill with any declaration as scoped", () => {
		expect(isSkillScoped(skill({ grantedCapabilities: ["network"] }))).toBe(true);
		expect(isSkillScoped(skill({ requiredCapabilities: ["shell"] }))).toBe(true);
	});
});

describe("enforceSkillScope", () => {
	it("lets an unscoped skill through the envelope gate (tool manifest still applies)", () => {
		// read_file is manifested for ${workspace}, so an in-workspace read is allowed.
		const d = enforceSkillScope(skill(), "read_file", inWs, opts);
		expect(d.allowed).toBe(true);
	});

	it("still bounds an unscoped skill by the tool manifest", () => {
		// read_file has no exec capability -> denied even for an unscoped skill.
		const d = enforceSkillScope(skill(), "read_file", { kind: "exec", command: "ls" }, opts);
		expect(d.allowed).toBe(false);
	});

	it("denies a scoped skill a capability it did not declare", () => {
		const s = skill({ grantedCapabilities: ["filesystem-read"] });
		const d = enforceSkillScope(
			s,
			"web_fetch",
			{ kind: "network", url: "https://example.com" },
			opts,
		);
		expect(d.allowed).toBe(false);
		if (!d.allowed) {
			expect(d.reason).toContain('declared no "network" capability');
		}
	});

	it("denies before consulting the tool manifest (an allow-all tool is still blocked)", () => {
		// web_fetch's manifest allows any host, but the skill never declared network.
		const s = skill({ grantedCapabilities: ["filesystem-read"] });
		const d = enforceSkillScope(
			s,
			"web_fetch",
			{ kind: "network", url: "https://anything.dev" },
			opts,
		);
		expect(d.allowed).toBe(false);
		if (!d.allowed) expect(d.reason).toContain("[skill-scope]");
	});

	it("passes a declared capability through to the tool gate, which allows in-scope", () => {
		const s = skill({ grantedCapabilities: ["filesystem-write"] });
		const d = enforceSkillScope(s, "write_file", inWsWrite, opts);
		expect(d.allowed).toBe(true);
	});

	it("passes the envelope gate but the tool gate denies an out-of-scope path", () => {
		const s = skill({ grantedCapabilities: ["filesystem-write"] });
		const out: CapabilityRequest = { kind: "fs_write", path: "/etc/passwd" };
		const d = enforceSkillScope(s, "write_file", out, opts);
		expect(d.allowed).toBe(false);
		if (!d.allowed) expect(d.reason).toContain("[capability-manifest]");
	});

	it("opens the envelope via a required (not granted) declaration", () => {
		const s = skill({ requiredCapabilities: ["filesystem-read"] });
		const d = enforceSkillScope(s, "read_file", inWs, opts);
		expect(d.allowed).toBe(true);
	});
});

describe("SkillManager.enforceSkillCapability", () => {
	let dir: string;

	function manager(): SkillManager {
		dir = mkdtempSync(join(tmpdir(), "skill-scope-"));
		return new SkillManager(dir);
	}

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("denies an unknown skill by default", () => {
		const m = manager();
		const d = m.enforceSkillCapability("nope", "read_file", inWs, opts);
		expect(d.allowed).toBe(false);
		if (!d.allowed) expect(d.reason).toContain("unknown skill");
	});

	it("resolves a loaded skill and applies its envelope", async () => {
		const m = manager();
		writeFileSync(
			join(dir, "netskill.md"),
			"---\nname: netskill\ndescription: reaches the network\ngrantedCapabilities: [network]\n---\nbody\n",
		);
		await m.loadSkills();
		// Declared network -> passes envelope, web_fetch manifest allows the host.
		const ok = m.enforceSkillCapability(
			"netskill",
			"web_fetch",
			{ kind: "network", url: "https://example.com" },
			opts,
		);
		expect(ok.allowed).toBe(true);
		// Did not declare filesystem-write -> denied at the envelope gate.
		const denied = m.enforceSkillCapability("netskill", "write_file", inWsWrite, opts);
		expect(denied.allowed).toBe(false);
		if (!denied.allowed) expect(denied.reason).toContain("filesystem-write");
	});
});
