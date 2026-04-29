/**
 * Tests for skill-as-permission capability widening (issue #2091).
 *
 * Covers:
 *   - frontmatter parsing of requiredCapabilities / grantedCapabilities
 *   - install widens the active capability set
 *   - uninstall narrows it again
 *   - ref counting across two skills granting the same capability
 *   - install fails cleanly when required capabilities are missing
 *   - capability events are written through the audit hook
 *   - skills without capability declarations remain backward compatible
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityAuditStore } from "../audit/capability-store.js";
import { SkillManager } from "./index.js";

const PLAIN_SKILL = `---
name: plain
description: A backward-compatible skill with no capability declarations
tools: [read, grep]
---
# Plain Skill

Body content.
`;

const NET_SKILL = `---
name: web-search
description: Search the web
tools: [browser]
grantedCapabilities: [network]
---
# Web Search

Body content.
`;

const FILE_SKILL = `---
name: file-mover
description: Move files
tools: [read, write]
grantedCapabilities: [filesystem-read, filesystem-write]
---
# File Mover

Body content.
`;

const DEPENDS_ON_NET_SKILL = `---
name: news-fetcher
description: Fetch news from feeds
tools: [browser]
requiredCapabilities: [network]
grantedCapabilities: [feed-read]
---
# News Fetcher

Body content.
`;

const SECOND_NET_SKILL = `---
name: pinger
description: Ping a remote host
tools: [bash]
grantedCapabilities: [network]
---
# Pinger

Body content.
`;

let tempRoot: string;

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "skill-cap-"));
});

afterEach(() => {
	if (tempRoot && existsSync(tempRoot)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

function writeSkill(slug: string, content: string): void {
	writeFileSync(join(tempRoot, `${slug}.md`), content);
}

async function makeManager(): Promise<SkillManager> {
	const m = new SkillManager(tempRoot);
	await m.loadSkills();
	return m;
}

describe("frontmatter capability parsing", () => {
	it("parses requiredCapabilities and grantedCapabilities as string arrays", async () => {
		writeSkill("news-fetcher", DEPENDS_ON_NET_SKILL);
		const m = await makeManager();
		const skill = m.getSkill("news-fetcher")!;
		expect(skill).toBeDefined();
		expect(skill.requiredCapabilities).toEqual(["network"]);
		expect(skill.grantedCapabilities).toEqual(["feed-read"]);
	});

	it("defaults to empty arrays when fields are absent", async () => {
		writeSkill("plain", PLAIN_SKILL);
		const m = await makeManager();
		const skill = m.getSkill("plain")!;
		expect(skill.requiredCapabilities).toEqual([]);
		expect(skill.grantedCapabilities).toEqual([]);
	});
});

describe("install / uninstall", () => {
	it("widens the active capability set on install", async () => {
		writeSkill("web-search", NET_SKILL);
		const m = await makeManager();

		expect(m.hasCapability("network")).toBe(false);
		const result = m.installSkill("web-search");

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.granted).toEqual(["network"]);
		expect(m.hasCapability("network")).toBe(true);
		expect(m.getActiveCapabilities()).toEqual(["network"]);
		expect(m.isInstalled("web-search")).toBe(true);
	});

	it("narrows the active set on uninstall", async () => {
		writeSkill("web-search", NET_SKILL);
		const m = await makeManager();
		m.installSkill("web-search");

		const result = m.uninstallSkill("web-search");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.revoked).toEqual(["network"]);
		expect(m.hasCapability("network")).toBe(false);
		expect(m.getActiveCapabilities()).toEqual([]);
		expect(m.isInstalled("web-search")).toBe(false);
	});

	it("ref-counts when two skills grant the same capability", async () => {
		writeSkill("web-search", NET_SKILL);
		writeSkill("pinger", SECOND_NET_SKILL);
		const m = await makeManager();

		m.installSkill("web-search");
		m.installSkill("pinger");
		expect(m.getCapabilityRefCount("network")).toBe(2);

		// Uninstalling one keeps the capability active.
		m.uninstallSkill("web-search");
		expect(m.hasCapability("network")).toBe(true);
		expect(m.getCapabilityRefCount("network")).toBe(1);

		// Last uninstall drops it.
		m.uninstallSkill("pinger");
		expect(m.hasCapability("network")).toBe(false);
		expect(m.getCapabilityRefCount("network")).toBe(0);
	});

	it("fails install when required capabilities are missing", async () => {
		writeSkill("news-fetcher", DEPENDS_ON_NET_SKILL);
		const m = await makeManager();

		const result = m.installSkill("news-fetcher");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.missing).toEqual(["network"]);
		expect(m.isInstalled("news-fetcher")).toBe(false);
		expect(m.hasCapability("feed-read")).toBe(false);
	});

	it("succeeds when required capabilities are already granted by another skill", async () => {
		writeSkill("web-search", NET_SKILL);
		writeSkill("news-fetcher", DEPENDS_ON_NET_SKILL);
		const m = await makeManager();

		expect(m.installSkill("web-search").ok).toBe(true);
		const result = m.installSkill("news-fetcher");
		expect(result.ok).toBe(true);
		expect(m.hasCapability("feed-read")).toBe(true);
	});

	it("install is idempotent: a second install grants nothing extra", async () => {
		writeSkill("web-search", NET_SKILL);
		const m = await makeManager();

		const first = m.installSkill("web-search");
		const second = m.installSkill("web-search");
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (second.ok) expect(second.granted).toEqual([]);
		expect(m.getCapabilityRefCount("network")).toBe(1);
	});

	it("returns ok=false when installing an unknown skill", async () => {
		const m = await makeManager();
		const result = m.installSkill("does-not-exist");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/not found/);
	});

	it("removeSkill uninstalls first so capability ref counts stay correct", async () => {
		writeSkill("file-mover", FILE_SKILL);
		const m = await makeManager();
		m.installSkill("file-mover");
		expect(m.hasCapability("filesystem-read")).toBe(true);

		m.removeSkill("file-mover");
		expect(m.hasCapability("filesystem-read")).toBe(false);
		expect(m.hasCapability("filesystem-write")).toBe(false);
		expect(m.getInstalledSkills()).toEqual([]);
	});
});

describe("backward compatibility", () => {
	it("plain skills install with no grants and no required caps", async () => {
		writeSkill("plain", PLAIN_SKILL);
		const m = await makeManager();

		const result = m.installSkill("plain");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.granted).toEqual([]);
			expect(result.revoked).toEqual([]);
		}
		expect(m.getActiveCapabilities()).toEqual([]);
		expect(m.isInstalled("plain")).toBe(true);
	});

	it("plain skills can be uninstalled with no audit churn", async () => {
		writeSkill("plain", PLAIN_SKILL);
		const m = await makeManager();
		m.installSkill("plain");
		const result = m.uninstallSkill("plain");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.revoked).toEqual([]);
	});

	it("uninstalling a skill that was never installed is a no-op", async () => {
		writeSkill("plain", PLAIN_SKILL);
		const m = await makeManager();
		const result = m.uninstallSkill("plain");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.revoked).toEqual([]);
	});
});

describe("audit logging", () => {
	let dbPath: string;
	let store: CapabilityAuditStore;

	beforeEach(() => {
		dbPath = join(tempRoot, "capability.db");
		store = new CapabilityAuditStore(dbPath);
	});

	afterEach(() => {
		store.close();
	});

	it("writes a grant event per capability on install", async () => {
		writeSkill("file-mover", FILE_SKILL);
		const m = await makeManager();
		m.setCapabilityAudit({
			store,
			actor: "agent:test",
			actorKind: "agent",
			sessionId: "s_test",
			reason: "test install",
		});

		m.installSkill("file-mover");

		const events = store.queryCapability({ skill: "file-mover" });
		expect(events.length).toBe(2);
		const ops = events.map((e) => `${e.operation}:${e.capability}`).sort();
		expect(ops).toEqual(["grant:filesystem-read", "grant:filesystem-write"]);
		for (const e of events) {
			expect(e.actor).toBe("agent:test");
			expect(e.actorKind).toBe("agent");
			expect(e.sessionId).toBe("s_test");
			expect(e.reason).toBe("test install");
		}
	});

	it("writes a revoke event per capability on uninstall", async () => {
		writeSkill("file-mover", FILE_SKILL);
		const m = await makeManager();
		m.setCapabilityAudit({ store, actor: "agent:test", actorKind: "agent" });
		m.installSkill("file-mover");
		m.uninstallSkill("file-mover");

		const revokes = store.queryCapability({
			skill: "file-mover",
			operation: "revoke",
		});
		expect(revokes.length).toBe(2);
		const caps = revokes.map((e) => e.capability).sort();
		expect(caps).toEqual(["filesystem-read", "filesystem-write"]);
	});

	it("writes no events for a skill with no granted capabilities", async () => {
		writeSkill("plain", PLAIN_SKILL);
		const m = await makeManager();
		m.setCapabilityAudit({ store, actor: "agent:test", actorKind: "agent" });
		m.installSkill("plain");
		m.uninstallSkill("plain");

		expect(store.count()).toBe(0);
	});

	it("does not write any events when no audit hook is configured", async () => {
		writeSkill("file-mover", FILE_SKILL);
		const m = await makeManager();

		m.installSkill("file-mover");
		m.uninstallSkill("file-mover");

		// store was never given to the manager so it should be empty
		expect(store.count()).toBe(0);
	});
});

describe("CapabilityAuditStore", () => {
	let dbPath: string;
	let store: CapabilityAuditStore;

	beforeEach(() => {
		dbPath = join(tempRoot, "capability-direct.db");
		store = new CapabilityAuditStore(dbPath);
	});

	afterEach(() => {
		store.close();
	});

	it("inserts and reads back a capability event", () => {
		const id = store.logCapability({
			actor: "agent:8gent",
			actorKind: "agent",
			skill: "web-search",
			capability: "network",
			operation: "grant",
			reason: "install",
			sessionId: "s_1",
		});
		expect(id).toMatch(/^cap_/);

		const events = store.queryCapability({ skill: "web-search" });
		expect(events.length).toBe(1);
		expect(events[0].actor).toBe("agent:8gent");
		expect(events[0].operation).toBe("grant");
		expect(events[0].capability).toBe("network");
	});

	it("filters by capability, actor, and operation", () => {
		store.logCapability({
			actor: "a",
			actorKind: "agent",
			skill: "s1",
			capability: "network",
			operation: "grant",
			reason: "x",
		});
		store.logCapability({
			actor: "b",
			actorKind: "agent",
			skill: "s2",
			capability: "filesystem",
			operation: "grant",
			reason: "x",
		});
		store.logCapability({
			actor: "a",
			actorKind: "agent",
			skill: "s1",
			capability: "network",
			operation: "revoke",
			reason: "x",
		});

		expect(store.queryCapability({ capability: "network" }).length).toBe(2);
		expect(store.queryCapability({ actor: "b" }).length).toBe(1);
		expect(store.queryCapability({ operation: "revoke" }).length).toBe(1);
	});

	it("rejects invalid input", () => {
		const base = {
			actor: "a",
			actorKind: "agent" as const,
			skill: "s",
			capability: "c",
			operation: "grant" as const,
			reason: "r",
		};
		expect(() => store.logCapability({ ...base, actor: "" })).toThrow(/actor is required/);
		expect(() => store.logCapability({ ...base, capability: "" })).toThrow(
			/capability is required/,
		);
		// @ts-expect-error - deliberately wrong
		expect(() => store.logCapability({ ...base, operation: "leak" })).toThrow(/invalid operation/);
	});

	it("is append-only: no public mutation API", () => {
		const surface = store as unknown as Record<string, unknown>;
		expect(typeof surface.update).toBe("undefined");
		expect(typeof surface.delete).toBe("undefined");
		expect(typeof surface.remove).toBe("undefined");
		expect(typeof surface.clear).toBe("undefined");
		expect(typeof surface.truncate).toBe("undefined");
	});
});
