/**
 * #4530: AgentPool.chat is the one choke point before the model. A known command
 * name never reaches the session's agent, whoever the caller is (gateway frame,
 * dispatch queue, a daemon-built prompt), and the pool has one model-call site.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_CHANNELS } from "./agent-pool";
import { bus } from "./events";
import { setClassifyObserver } from "./input-gate";

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

const order: string[] = [];

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
			order.push("model");
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

	test("plain text reaches the model; an unknown slash name never does", async () => {
		const { pool, reached } = poolWithFake("g-plain", "api");
		expect(await pool.chat("g-plain", "hello")).toBe("model:hello");
		expect(await pool.chat("g-plain", "/nosuchthing")).toContain("Unknown command /nosuchthing");
		expect(reached).toEqual(["hello"]);
		pool.destroySession("g-plain");
	});

	test("source: exactly one model-call site in the pool, after the gate", () => {
		const src = readFileSync(join(import.meta.dir, "agent-pool.ts"), "utf8");
		expect(src.match(/\.agent\.chat\(/g)?.length).toBe(1);
		expect(src).not.toContain("isSlashLine");
		expect(src.indexOf("classifyInput(")).toBeGreaterThan(0);
		expect(src.indexOf("classifyInput(")).toBeLessThan(src.indexOf("gateInput("));
		expect(src.indexOf("gateInput(")).toBeLessThan(src.indexOf(".agent.chat("));
	});

	test("plain text passes through classify on every channel and still reaches the model", async () => {
		const seen: string[] = [];
		setClassifyObserver((_t, ctx, r) => {
			if (r.kind === "pass") {
				seen.push(ctx.channel);
				order.push(`classify:${ctx.channel}`);
			}
		});
		try {
			for (const channel of KNOWN_CHANNELS) {
				order.length = 0;
				const { pool, reached } = poolWithFake(`c-${channel}`, channel);
				expect(await pool.chat(`c-${channel}`, "plain words")).toBe("model:plain words");
				expect(reached).toEqual(["plain words"]);
				expect(seen).toContain(channel);
				expect(order).toEqual([`classify:${channel}`, "model"]);
				pool.destroySession(`c-${channel}`);
			}
		} finally {
			setClassifyObserver();
		}
	});
});
