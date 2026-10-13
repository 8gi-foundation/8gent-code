import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ToolRegistry } from "../tool-registry";

const names = (r: ToolRegistry) => Object.keys(r.getTools());

describe("native provider orchestration preload (#3881)", () => {
	test("orchestrator gets spawn_agent before the first request", () => {
		const reg = new ToolRegistry(false);
		expect(names(reg)).not.toContain("spawn_agent");
		reg.preloadForNative("orchestrator");
		expect(names(reg)).toContain("spawn_agent");
		expect(names(reg)).toContain("check_agent");
	});

	test.each(["engineer", "qa", undefined])("role %s gets no delegation tools", (role) => {
		const reg = new ToolRegistry(false);
		reg.preloadForNative(role);
		expect(names(reg)).not.toContain("spawn_agent");
		expect(names(reg).some((n) => n.startsWith("term_"))).toBe(false);
	});

	test("discover_tools does not claim the tools are callable this turn", async () => {
		const reg = new ToolRegistry(false, "orchestrator");
		const d: any = reg.getTools().discover_tools;
		expect(d.description).not.toContain("unlock");
		const out: any = await d.execute({ category: "orchestration" }, {});
		expect(out.message).toContain("next turn");
		expect(out.message).not.toMatch(/^Loaded/);
	});

	test.each([
		["engineer", false],
		["qa", false],
		[undefined, false],
		["orchestrator", true],
	])("discover_tools orchestration for role %s allowed=%p", async (role, allowed) => {
		const reg = new ToolRegistry(false, role as string | undefined);
		const d: any = reg.getTools().discover_tools;
		const out: any = await d.execute({ category: "orchestration" }, {});
		expect(Object.keys(reg.getTools()).includes("spawn_agent")).toBe(allowed);
		expect(Boolean(out.error)).toBe(!allowed);
	});

	test("agent.ts passes config.role to the registry", () => {
		const src = readFileSync(join(import.meta.dir, "..", "agent.ts"), "utf8");
		expect(src).toContain("new ToolRegistry(config.allTools ?? false, config.role)");
	});

	test("agent.ts calls the preload for non-local providers with the config role", () => {
		const src = readFileSync(join(import.meta.dir, "..", "agent.ts"), "utf8");
		expect(src).toMatch(/if \(!isLocalProvider\) this\.toolRegistry\.preloadForNative\(this\.config\.role\);/);
	});
});
