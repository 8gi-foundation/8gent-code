import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProviderManager } from "./index";

// Drive the gate's fail-closed path WITHOUT mocking the anonymizer module
// (a `mock.module` would poison the shared registry for every other suite in
// the same `bun test` process). Instead we hand the gate a message whose
// `content` getter throws: the anonymizer cannot read it, so the gate cannot
// produce a verified-clean payload and MUST fail closed - rerouting to a local
// provider rather than sending anything to the cloud.

let tmpDir: string;
let settingsPath: string;
const realFetch = globalThis.fetch;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pii-failclosed-"));
	settingsPath = path.join(tmpDir, "providers.json");
});

afterEach(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A message whose content throws on the FIRST read (the anonymization pass) but
 * returns a benign string afterward. This simulates the anonymizer raising
 * mid-run: the gate cannot prove the payload clean, so it must fail closed and
 * reroute to a local provider - which then dispatches normally.
 */
function poisonMessage(): { role: "user"; content: string } {
	const msg = { role: "user" as const };
	let reads = 0;
	Object.defineProperty(msg, "content", {
		enumerable: true,
		get() {
			reads += 1;
			if (reads === 1) throw new Error("anonymizer failed mid-run");
			return "benign local payload";
		},
	});
	return msg as { role: "user"; content: string };
}

describe("fail-closed when anonymization cannot run", () => {
	test("cloud request reroutes to a LOCAL endpoint, never sent to cloud", async () => {
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({
				activeProvider: "openrouter",
				activeModel: "minimax/minimax-m2",
				providers: { openrouter: { enabled: true, apiKey: "test-key" } },
			}),
		);
		const mgr = new ProviderManager(settingsPath);

		const calledUrls: string[] = [];
		globalThis.fetch = (async (url: string) => {
			calledUrls.push(String(url));
			if (/openrouter\.ai|api\.anthropic\.com|api\.openai\.com/.test(String(url))) {
				throw new Error("LEAK: cloud was contacted on a fail-closed request");
			}
			return new Response(JSON.stringify({ message: { content: "local ok" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const res = await mgr.chat({ messages: [poisonMessage()] });

		// Completed via a LOCAL endpoint, and never touched a public cloud host.
		expect(res.content).toBe("local ok");
		expect(calledUrls.length).toBeGreaterThan(0);
		for (const u of calledUrls) {
			expect(u).toMatch(/localhost|127\.0\.0\.1/);
		}
	});

	test("refuses (throws) when fail-closed and no local provider can be resolved", async () => {
		// Disable every local provider so resolveLocalFallback returns null.
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({
				activeProvider: "openrouter",
				activeModel: "minimax/minimax-m2",
				providers: {
					openrouter: { enabled: true, apiKey: "test-key" },
				},
			}),
		);
		const mgr = new ProviderManager(settingsPath);

		// Monkeypatch the instance's local-fallback resolver to simulate "no
		// local provider available" (e.g. a headless cloud host).
		(mgr as unknown as { resolveLocalFallback: () => null }).resolveLocalFallback = () => null;

		globalThis.fetch = (async () => {
			throw new Error("network must not be reached on a refused request");
		}) as unknown as typeof fetch;

		await expect(mgr.chat({ messages: [poisonMessage()] })).rejects.toThrow(/fail-closed/i);
	});
});
