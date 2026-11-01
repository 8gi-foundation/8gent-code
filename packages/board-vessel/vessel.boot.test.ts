/**
 * Boot tests for the real vessel entry point. Each case must fail closed: the
 * process exits 1 before it serves /health or takes work.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const VESSEL = join(import.meta.dir, "vessel.ts");
const STUB = join(import.meta.dir, "test-fixtures", "stub-model-list.ts");

async function boot(env: Record<string, string>): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(["bun", "--preload", STUB, VESSEL], {
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", HEALTH_PORT: "0", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), 15_000);
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	clearTimeout(timer);
	return { code, out: out + err };
}

const OFFICER = {
	BOARD_MEMBER_CODE: "8TO",
	INFERENCE_MODE: "direct",
	VESSEL_PROVIDER: "minimax",
	MINIMAX_API_KEY: "mm-test-key-not-real",
};

describe("vessel boot fails closed", () => {
	test("a model missing from MiniMax's own list exits 1", async () => {
		const r = await boot({ ...OFFICER, VESSEL_MODEL: "MiniMax-Nope", STUB_MODELS: "MiniMax-M3" });
		expect(r.code).toBe(1);
		expect(r.out).toContain("MiniMax-Nope is not on minimax's live list");
	});

	test("an unreadable model list exits 1", async () => {
		const r = await boot({ ...OFFICER, VESSEL_MODEL: "MiniMax-M3", STUB_MODELS_STATUS: "401" });
		expect(r.code).toBe(1);
		expect(r.out).toContain("MiniMax model list returned 401");
	});

	test("no MINIMAX_API_KEY exits 1", async () => {
		const { MINIMAX_API_KEY: _drop, ...noKey } = OFFICER;
		const r = await boot({ ...noKey, VESSEL_MODEL: "MiniMax-M3", STUB_MODELS: "MiniMax-M3" });
		expect(r.code).toBe(1);
		expect(r.out).toContain("MINIMAX_API_KEY is not set");
	});

	test("no VESSEL_MODEL in direct mode exits 1", async () => {
		const r = await boot({ ...OFFICER, STUB_MODELS: "MiniMax-M3" });
		expect(r.code).toBe(1);
		expect(r.out).toContain("VESSEL_MODEL is required");
	});

	test("board vessel path unchanged: default control plane still demands its token", async () => {
		const r = await boot({ BOARD_MEMBER_CODE: "8TO", INFERENCE_MODE: "proxy" });
		expect(r.code).toBe(1);
		expect(r.out).toContain("VESSEL_AUTH_TOKEN is required");
	});
});
