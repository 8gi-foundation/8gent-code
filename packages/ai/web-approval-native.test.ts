/** The native AI SDK loop asks before web tools leave the device (privacy lockdown). */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
} from "../permissions/tui-approval-channel";
import { agentTools } from "./tools";

const realFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(() => {
	fetchCalls = 0;
	globalThis.fetch = (async () => {
		fetchCalls++;
		return new Response("<html><body>ok</body></html>", { status: 200 });
	}) as unknown as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
	_resetTuiApprovalChannel();
});

type Exec = (input: unknown, options: unknown) => Promise<unknown>;
const run = (name: "web_search" | "web_fetch", input: unknown) =>
	(agentTools as unknown as Record<string, { execute: Exec }>)[name].execute(input, {
		toolCallId: "t",
		messages: [],
	});

describe("native path web approval", () => {
	for (const [name, input] of [
		["web_search", { query: "bun sqlite" }],
		["web_fetch", { url: "https://example.test/" }],
	] as const) {
		it(`${name}: a No on the card makes zero fetch calls`, async () => {
			registerTuiApprovalHandler(async () => "deny");
			const out = String(await run(name, input));
			expect(out).toContain("[PERMISSION DENIED]");
			expect(fetchCalls).toBe(0);
		});

		it(`${name}: a Yes lets it reach the network`, async () => {
			registerTuiApprovalHandler(async () => "approve");
			const out = String(await run(name, input));
			expect(out).not.toContain("[PERMISSION DENIED]");
			if (name === "web_search") expect(fetchCalls).toBeGreaterThan(0);
		});
	}
});
