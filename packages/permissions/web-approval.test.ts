/** Web tools ask first, default No; unattended means no unless opted in. */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { PermissionManager } from "./index";
import { webApprovalRefusal } from "./web-approval";

afterAll(cleanupTempDirs);

const saved = {
	headless: process.env.EIGHT_HEADLESS,
	optIn: process.env.EIGHT_HEADLESS_APPROVE,
	tty: process.stdin.isTTY,
};
afterEach(() => {
	for (const [k, v] of [
		["EIGHT_HEADLESS", saved.headless],
		["EIGHT_HEADLESS_APPROVE", saved.optIn],
	] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	(process.stdin as { isTTY?: boolean }).isTTY = saved.tty;
});

function stub(answer: boolean, infinite = false) {
	const calls: { action: string; defaultNo?: boolean }[] = [];
	return {
		calls,
		isInfiniteMode: () => infinite,
		requestPermission: async (
			action: string,
			_d: string,
			_c?: string,
			o?: { defaultNo?: boolean },
		) => {
			calls.push({ action, defaultNo: o?.defaultNo });
			return answer;
		},
	};
}

describe("web tools in Ask mode", () => {
	test("a prompt is shown, defaults to No on a terminal, and a No refuses", async () => {
		delete process.env.EIGHT_HEADLESS;
		(process.stdin as { isTTY?: boolean }).isTTY = true;
		const pm = stub(false);
		const r = await webApprovalRefusal(pm, "web_search", "bun sqlite docs");
		expect(pm.calls).toEqual([{ action: "Web request", defaultNo: true }]);
		expect(r).toContain("[PERMISSION DENIED]");
		expect(r).toContain("web_search");
	});

	test("a Yes lets the call run", async () => {
		const pm = stub(true);
		expect(await webApprovalRefusal(pm, "web_fetch", "https://example.test")).toBeNull();
		expect(pm.calls.length).toBe(1);
	});

	test("Infinite keeps its documented behaviour: no prompt", async () => {
		const pm = stub(false, true);
		expect(await webApprovalRefusal(pm, "web_fetch", "https://example.test")).toBeNull();
		expect(pm.calls.length).toBe(0);
	});
});

describe("web tools with nobody to ask (real PermissionManager)", () => {
	const manager = () => new PermissionManager(path.join(tempDir("web-appr-"), "permissions.json"));

	test("headless without the opt-in is refused", async () => {
		process.env.EIGHT_HEADLESS = "1";
		delete process.env.EIGHT_HEADLESS_APPROVE;
		const r = await webApprovalRefusal(manager(), "web_search", "anything");
		expect(r).toContain("[PERMISSION DENIED]");
	});

	test("headless with EIGHT_HEADLESS_APPROVE=1 runs", async () => {
		process.env.EIGHT_HEADLESS = "1";
		process.env.EIGHT_HEADLESS_APPROVE = "1";
		expect(await webApprovalRefusal(manager(), "web_search", "anything")).toBeNull();
	});
});
