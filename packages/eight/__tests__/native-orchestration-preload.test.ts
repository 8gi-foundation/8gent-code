import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../tool-registry";

describe("native provider tool preload (#3881)", () => {
	test("deferred registry has no spawn_agent until preloadForNative", () => {
		const reg = new ToolRegistry(false);
		expect(Object.keys(reg.getTools())).not.toContain("spawn_agent");
		reg.preloadForNative();
		const names = Object.keys(reg.getTools());
		expect(names).toContain("spawn_agent");
		expect(names).toContain("check_agent");
		expect(names).toContain("discover_tools");
	});
});
