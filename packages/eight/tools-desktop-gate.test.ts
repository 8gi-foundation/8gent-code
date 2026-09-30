/**
 * Desktop tools are gated under the rules written for them (#3213).
 *
 * The executor checked every desktop_* call as `computer_use`, but the
 * desktop rules in default-policies.yaml are written as `desktop_use`, and
 * the engine's default is allow. So desktop_quit_app ran with no approval
 * card, straight into a shell-built pkill. Now desktop_* is gated as
 * `desktop_use` with the `action` descriptor its rules match on, a
 * require_approval rule asks the person, no person means no action, and a
 * desktop action no rule covers asks instead of running.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePolicy } from "../permissions/policy-engine";
import {
	type TuiApprovalRequest,
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
} from "../permissions/tui-approval-channel";
import { ToolExecutor } from "./tools";

const dir = mkdtempSync(join(tmpdir(), "desktop-gate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("desktop_use policy", () => {
	test("quitting an app requires approval", () => {
		const d = evaluatePolicy("desktop_use", { action: "quit_app" });
		expect(d.allowed).toBe(false);
		expect(d.allowed === false && d.requiresApproval).toBe(true);
	});

	test("read-only desktop actions are allowed", () => {
		expect(evaluatePolicy("desktop_use", { action: "screenshot" }).allowed).toBe(true);
		expect(evaluatePolicy("desktop_use", { action: "list_processes" }).allowed).toBe(true);
	});

	test("a desktop action no rule covers asks, never allows", () => {
		const d = evaluatePolicy("desktop_use", { action: "desktop_brand_new_tool" });
		expect(d.allowed).toBe(false);
		expect(d.allowed === false && d.requiresApproval).toBe(true);
	});

	test("other action classes keep the default allow", () => {
		expect(evaluatePolicy("read_file", { path: join(dir, "x.txt") }).allowed).toBe(true);
	});
});

describe("ToolExecutor asks before desktop_quit_app", () => {
	let asked: TuiApprovalRequest[];
	const prevHeadless = process.env.EIGHT_HEADLESS;

	beforeEach(() => {
		asked = [];
	});
	afterEach(() => {
		_resetTuiApprovalChannel();
		if (prevHeadless === undefined) Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
		else process.env.EIGHT_HEADLESS = prevHeadless;
	});

	test("the approval card appears, and a declined quit runs nothing", async () => {
		registerTuiApprovalHandler(async (req) => {
			asked.push(req);
			return "deny";
		});
		const marker = join(dir, "pwned-declined");
		const exec = new ToolExecutor(dir, "desktop-gate-test");
		const out = await exec.execute("desktop_quit_app", { name: `Safari$(touch ${marker})` });

		expect(asked.length).toBe(1);
		expect(asked[0].action).toBe("Desktop control");
		expect(asked[0].details).toContain("desktop_quit_app");
		expect(out).toContain("[PERMISSION DENIED]");
		expect(out).toContain("Do not retry");
		expect(existsSync(marker)).toBe(false);
	});

	test("an approved quit with an injected name still runs no shell", async () => {
		registerTuiApprovalHandler(async (req) => {
			asked.push(req);
			return "approve";
		});
		const marker = join(dir, "pwned-approved");
		const exec = new ToolExecutor(dir, "desktop-gate-test");
		const out = await exec.execute("desktop_quit_app", {
			name: `Safari\`touch ${marker}\`; touch ${marker}`,
		});

		expect(asked.length).toBe(1);
		expect(existsSync(marker)).toBe(false);
		expect(out).toContain("desktop_quit_app failed");
	});

	test("with no one to ask, the quit is refused and nothing runs", async () => {
		process.env.EIGHT_HEADLESS = "1";
		const marker = join(dir, "pwned-headless");
		const exec = new ToolExecutor(dir, "desktop-gate-test");
		const out = await exec.execute("desktop_quit_app", { name: `Safari$(touch ${marker})` });

		expect(out).toStartWith("[BLOCKED]");
		expect(out).toContain("Do not retry");
		expect(existsSync(marker)).toBe(false);
	});
});

describe("Table agents cannot reach desktop_use", () => {
	test("desktop_use is hard-blocked for the shadow scope", () => {
		const d = evaluatePolicy("desktop_use", { agentId: "__shadow__", action: "screenshot" });
		expect(d.allowed).toBe(false);
		expect(d.allowed === false && d.requiresApproval).toBeFalsy();
	});
});
