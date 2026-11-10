/**
 * #157 follow-up: a turn that ends badly is still in the session record, marked
 * failed with the real error, and the end-of-turn hook hears about it once.
 * Drives chat() against a fake OpenAI-compatible endpoint (text-tool path, the
 * local default); $HOME is faked. Exits covered: a throw out of the turn
 * (compactIfNeeded stubbed to throw), a provider failure, a stop by the user,
 * and a model that stalls past the turn timeout.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import { SessionReader } from "../specifications/session/reader";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;
const saved: Record<string, string | undefined> = {};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let mode: "ok" | "fail" | "hang" = "ok";

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "thrown157-home-"));
	repo = mkdtempSync(join(tmpdir(), "thrown157-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	const env: Record<string, string> = {
		HOME: home,
		EIGHT_DATA_DIR: join(home, ".8gent"),
		EIGHT_TOOL_CAPABILITY_GATE: "0",
		"8GENT_TWO_STAGE_COMPACT": "0",
		EIGHT_TEXT_TOOLS: "1",
	};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
	server = Bun.serve({
		port: 0,
		idleTimeout: 30,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			if (mode === "fail") return new Response("upstream-broke-157", { status: 500 });
			if (mode === "hang") await new Promise((r) => setTimeout(r, 4000));
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "Hello there." },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	saved.OLLAMA_HOST = process.env.OLLAMA_HOST;
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
	// The hook manager is shared by every test file in the run: drop the wrappers this file put on it.
	Reflect.deleteProperty((current as any).hookManager, "executeHooks");
	mode = "ok";
	Reflect.deleteProperty(process.env, "EIGHT_TURN_TIMEOUT_MS");
});

afterAll(() => {
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmRetry(home);
	rmRetry(repo);
});

const PROMPT = "Please say hello to me in one short sentence, nothing else.";

let current: AgentT;

function build(): { agent: AgentT; fired: Array<Record<string, unknown>> } {
	const agent = new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
	} as ConstructorParameters<typeof Agent>[0]);
	// Watch the end-of-turn hook without touching what it does.
	const hm = (agent as any).hookManager;
	const real = hm.executeHooks.bind(hm);
	const fired: Array<Record<string, unknown>> = [];
	hm.executeHooks = (type: string, ctx: Record<string, unknown>) => {
		if (type === "onComplete") fired.push(ctx);
		return real(type, ctx);
	};
	current = agent;
	return { agent, fired };
}

async function sessionEntries(): Promise<any[]> {
	return new SessionReader(current.getSessionFilePath()).readAll();
}

const failedRows = (entries: any[]) => entries.filter((e) => e.type === "error");

describe("a turn that throws", () => {
	const THROWN = "disk-gone-157";
	const stubThrow = (agent: AgentT) => {
		(agent as any).compactIfNeeded = async () => {
			throw new Error(THROWN);
		};
	};

	test("is in the session record, marked failed, with its real error; the error still reaches the caller", async () => {
		const { agent } = build();
		stubThrow(agent);
		await expect(agent.chat(PROMPT)).rejects.toThrow(THROWN);
		const rows = failedRows(await sessionEntries());
		expect(rows).toHaveLength(1);
		expect(rows[0].error.message).toBe(THROWN);
	}, 30_000);

	test("the end-of-turn hook fires once with a failure status and the real error", async () => {
		const { agent, fired } = build();
		stubThrow(agent);
		await expect(agent.chat(PROMPT)).rejects.toThrow(THROWN);
		expect(fired).toHaveLength(1);
		expect(fired[0].status).toBe("failed");
		expect(fired[0].error).toBe(THROWN);
	}, 30_000);

	test("a resumed session shows the failed turn", async () => {
		const { agent } = build();
		stubThrow(agent);
		await expect(agent.chat(PROMPT)).rejects.toThrow(THROWN);
		// Resume reads the file back: the user's message, then the failure.
		const types = (await sessionEntries()).map((e) => e.type);
		const user = types.indexOf("user_message");
		const err = types.indexOf("error");
		expect(user).toBeGreaterThan(-1);
		expect(err).toBeGreaterThan(user);
	}, 30_000);

	test("a throw inside the hook does not mask the original error", async () => {
		const { agent } = build();
		stubThrow(agent);
		const hm = (agent as any).hookManager;
		const real = hm.executeHooks.bind(hm);
		hm.executeHooks = async (type: string, ctx: unknown) => {
			if (type === "onComplete") throw new Error("hook-blew-up-157");
			return real(type, ctx);
		};
		await expect(agent.chat(PROMPT)).rejects.toThrow(THROWN);
	}, 30_000);

	test("a throw while writing the record does not mask the original error", async () => {
		const { agent } = build();
		stubThrow(agent);
		(agent as any).sessionWriter.writeError = () => {
			throw new Error("write-blew-up-157");
		};
		await expect(agent.chat(PROMPT)).rejects.toThrow(THROWN);
	}, 30_000);
});

describe("a turn that fails without throwing (text-tool path)", () => {
	test("a provider failure is recorded failed with the real error, hook fires once", async () => {
		mode = "fail";
		const { agent, fired } = build();
		await agent.chat(PROMPT);
		const rows = failedRows(await sessionEntries());
		expect(rows).toHaveLength(1);
		expect(rows[0].error.message).toContain("upstream-broke-157");
		expect(fired).toHaveLength(1);
		expect(fired[0].status).toBe("failed");
	}, 30_000);

	test("a stop by the user is recorded failed, hook fires once", async () => {
		mode = "hang";
		const { agent, fired } = build();
		const turn = agent.chat(PROMPT);
		await new Promise((r) => setTimeout(r, 600));
		agent.abort();
		await turn;
		const rows = failedRows(await sessionEntries());
		expect(rows).toHaveLength(1);
		expect(rows[0].error.message).toBe("stopped by user");
		expect(fired).toHaveLength(1);
		expect(fired[0].status).toBe("failed");
	}, 30_000);

	test("a turn that runs past its timeout is recorded failed, hook fires once", async () => {
		mode = "hang";
		process.env.EIGHT_TURN_TIMEOUT_MS = "500";
		const { agent, fired } = build();
		await agent.chat(PROMPT);
		const rows = failedRows(await sessionEntries());
		expect(rows).toHaveLength(1);
		expect(rows[0].error.message).toContain("timed out");
		expect(fired).toHaveLength(1);
		expect(fired[0].status).toBe("failed");
	}, 30_000);
});

describe("a normal turn", () => {
	test("records what it always did: no error row, hook carries no failure status", async () => {
		const { agent, fired } = build();
		const reply = await agent.chat(PROMPT);
		expect(reply).toContain("Hello there.");
		const entries = await sessionEntries();
		expect(failedRows(entries)).toHaveLength(0);
		// Byte-for-byte guard, captured on main before the change: the record's
		// rows, volatile fields (clock, ids, host) blanked and the flavour line cut.
		const shape = entries.map((e) => {
			const { timestamp, sequenceNumber, ...rest } = e;
			return JSON.stringify(rest, (k, v) =>
				[
					"sessionId",
					"startedAt",
					"systemPromptHash",
					"nodeVersion",
					"platform",
					"workingDirectory",
				].includes(k)
					? "_"
					: k === "text" && typeof v === "string"
						? v.split("\n")[0]
						: v,
			);
		});
		expect(shape).toEqual([
			'{"type":"session_start","meta":{"sessionId":"_","version":2,"startedAt":"_","agent":{"model":"m","runtime":"ollama","maxSteps":30,"systemPromptHash":"_"},"environment":{"workingDirectory":"_","platform":"_","nodeVersion":"_"}}}',
			'{"type":"user_message","message":{"role":"user","content":"Please say hello to me in one short sentence, nothing else."}}',
			'{"type":"assistant_content","stepNumber":0,"parts":[{"type":"text","text":"Hello there."}]}',
		]);
		for (const ctx of fired) expect(ctx.status).toBeUndefined();
	}, 30_000);
});

describe("this file's own cleanup", () => {
	test("the shared hook manager carries none of this file's wrappers (runs last, after the afterEach of the test before it)", async () => {
		const { getHookManager } = await import("../hooks");
		expect(Object.hasOwn(getHookManager(), "executeHooks")).toBe(false);
	});
});
