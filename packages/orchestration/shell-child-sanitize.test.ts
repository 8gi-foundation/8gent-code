/**
 * The spawn_agent "shell" runtime runs its task through sh -c. It is judged by
 * the same sanitizer as run_command before anything starts (#3763).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPermissionHolder, runWithPermissionHolder } from "../permissions/permission-mode";
import { spawnAgentTool } from "./delegation-tools";
import { listCLIAgents, resetOrchestration } from "./index";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "shell-child-"));
	resetOrchestration();
});
afterEach(() => {
	resetOrchestration();
	rmSync(dir, { recursive: true, force: true });
});

const PAYLOADS = [
	["command substitution", "echo $(touch pwned)"],
	["backticks", "echo `touch pwned`"],
	["semicolon chain", "true; touch pwned"],
	["and chain", "true && touch pwned"],
	["background", "touch pwned &"],
];

describe("spawn_agent shell runtime is sanitized", () => {
	for (const [name, task] of PAYLOADS) {
		test(`${name} is blocked with no mode bound`, async () => {
			const before = listCLIAgents().length;
			const out = await spawnAgentTool(dir, task, "shell");
			expect(out).toStartWith("[BLOCKED]");
			expect(listCLIAgents().length).toBe(before);
			await Bun.sleep(50);
			expect(existsSync(join(dir, "pwned"))).toBe(false);
		});

		test(`${name} is blocked under a bound permission mode`, async () => {
			const holder = createPermissionHolder("infinite");
			const out = await runWithPermissionHolder(holder, () => spawnAgentTool(dir, task, "shell"));
			expect(out).toStartWith("[BLOCKED]");
			await Bun.sleep(50);
			expect(existsSync(join(dir, "pwned"))).toBe(false);
		});
	}
});
