/**
 * #3762: a daemon session started from inside a pinned agent's turn.
 *
 * Chosen behaviour:
 *  - no explicit runtime: follows the pin's runtime and model, pinned.
 *  - explicit overrides.runtime: the explicit choice wins. It is pinned only if
 *    it names the pin's own runtime (and then takes the pin's model unless one
 *    is given); otherwise it is the officer's deliberate backend and not pinned.
 *  - Table session on a cloud pin: forced local as before, so it is neither
 *    pinned nor given the pin's model.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithProviderPin } from "../orchestration/provider-pin";
import { AgentPool } from "./agent-pool";

let dataDir: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), "pool3762-"));
	for (const [k, v] of Object.entries({ EIGHT_DATA_DIR: dataDir, EIGHT_TABLE_CONSENT_CLOUD: undefined })) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});
afterAll(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dataDir, { recursive: true, force: true });
});

type Overrides = Parameters<AgentPool["createSession"]>[2];

function session(pin: { runtime: string; model?: string } | undefined, channel: string, overrides?: Overrides) {
	const pool = new AgentPool({ runtime: "ollama", model: "pool-m" });
	runWithProviderPin(pin, () => pool.createSession("s1", channel, overrides));
	const cfg = (pool as unknown as { sessions: Map<string, { agent: { config: Record<string, unknown> } }> })
		.sessions.get("s1")!.agent.config;
	pool.destroySession("s1");
	return { runtime: cfg.runtime, model: cfg.model, pinned: cfg.providerPinned };
}

const PIN = { runtime: "lmstudio", model: "qwen-local" };

describe("daemon pool session under a pin (#3762)", () => {
	test("inherits the pin's runtime and model, pinned", () => {
		expect(session(PIN, "api")).toEqual({ runtime: "lmstudio", model: "qwen-local", pinned: true });
	});

	test("an explicit model is kept, runtime and pin still the parent's", () => {
		expect(session(PIN, "api", { model: "mine" })).toEqual({
			runtime: "lmstudio",
			model: "mine",
			pinned: true,
		});
	});

	test("explicit overrides.runtime wins and is not pinned", () => {
		expect(session(PIN, "api", { runtime: "ollama", model: "off-m" })).toEqual({
			runtime: "ollama",
			model: "off-m",
			pinned: undefined,
		});
	});

	test("an explicit runtime that matches the pin is pinned and takes the pin's model", () => {
		expect(session(PIN, "api", { runtime: "lmstudio" })).toEqual({
			runtime: "lmstudio",
			model: "qwen-local",
			pinned: true,
		});
	});

	test("a Table session on a cloud pin is forced local: not pinned, pool model", () => {
		expect(session({ runtime: "openrouter", model: "x/y" }, "table")).toEqual({
			runtime: "ollama",
			model: "pool-m",
			pinned: undefined,
		});
	});

	test("a Table session on a local pin stays on it, pinned", () => {
		expect(session(PIN, "table")).toEqual({ runtime: "lmstudio", model: "qwen-local", pinned: true });
	});

	test("no pin: exactly the pool defaults", () => {
		expect(session(undefined, "api")).toEqual({ runtime: "ollama", model: "pool-m", pinned: undefined });
	});
});
