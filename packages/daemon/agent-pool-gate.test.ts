/**
 * #4530: AgentPool.chat is the one choke point before the model. A known command
 * name never reaches the session's agent, whoever the caller is (gateway frame,
 * dispatch queue, a daemon-built prompt), and the pool has one model-call site.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bus } from "./events";

let dataDir: string;
const savedData = process.env.EIGHT_DATA_DIR;
let AgentPool: typeof import("./agent-pool").AgentPool;

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), "pool-gate-"));
	process.env.EIGHT_DATA_DIR = dataDir;
	({ AgentPool } = await import("./agent-pool"));
});

afterAll(() => {
	if (savedData === undefined) Reflect.deleteProperty(process.env, "EIGHT_DATA_DIR");
	else process.env.EIGHT_DATA_DIR = savedData;
	rmSync(dataDir, { recursive: true, force: true });
});

function poolWithFake(id: string, channel: string) {
	const pool = new AgentPool({ runtime: "ollama", model: "fake" });
	pool.createSession(id, channel);
	const reached: string[] = [];
	const agent = {
		getRuntime: () => "ollama",
		getModel: () => "fake",
		getWorkingDirectory: () => "/w",
		async chat(text: string): Promise<string> {
			reached.push(text);
			return `model:${text}`;
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: test swaps the private Agent for a fake
	(pool as any).sessions.get(id).agent = agent;
	return { pool, reached };
}

describe("AgentPool.chat gate", () => {
	test("a known command never reaches the model, on any channel, for any caller", async () => {
		for (const channel of ["api", "telegram", "table", "delegation", "browser"]) {
			const { pool, reached } = poolWithFake(`g-${channel}`, channel);
			const streamed: string[] = [];
			const on = (p: { sessionId: string; chunk: string }) => {
				if (p.sessionId === `g-${channel}`) streamed.push(p.chunk);
			};
			const id = bus.on("agent:stream", on);
			const reply = await pool.chat(`g-${channel}`, "/status");
			bus.off(id);
			expect(reply).toContain(`channel ${channel}`);
			expect(streamed).toEqual([reply]);
			expect(reached).toEqual([]);
			pool.destroySession(`g-${channel}`);
		}
	});

	test("a TUI-only name is answered, not sent to the model", async () => {
		const { pool, reached } = poolWithFake("g-tui", "api");
		expect(await pool.chat("g-tui", "/theme dark")).toContain("not available");
		expect(reached).toEqual([]);
		pool.destroySession("g-tui");
	});

	test("plain text and an unknown name still reach the model", async () => {
		const { pool, reached } = poolWithFake("g-plain", "api");
		expect(await pool.chat("g-plain", "hello")).toBe("model:hello");
		expect(await pool.chat("g-plain", "/nosuchthing")).toBe("model:/nosuchthing");
		expect(reached).toEqual(["hello", "/nosuchthing"]);
		pool.destroySession("g-plain");
	});

	test("source: exactly one model-call site in the pool, after the gate", () => {
		const src = readFileSync(join(import.meta.dir, "agent-pool.ts"), "utf8");
		expect(src.match(/\.agent\.chat\(/g)?.length).toBe(1);
		expect(src.indexOf("gateInput(")).toBeGreaterThan(0);
		expect(src.indexOf("gateInput(")).toBeLessThan(src.indexOf(".agent.chat("));
	});
});
