/**
 * #3115: the launch-time Ollama probe is bounded, and the welcome says what
 * became of it. Real sockets, no fetch stubs: the silent listener accepts TCP
 * and never writes a byte, the shape of a host that is down behind a route
 * that does not refuse.
 *
 * Before the fix `ollama list` ran unbounded, twice, and the setup waited on
 * both: 60 s to the welcome with OLLAMA_HOST=10.255.255.1:11434. On a miss the
 * welcome said nothing, which read as "nothing installed".
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	OLLAMA_PROBE_TIMEOUT_MS,
	OnboardingManager,
	ollamaCheckLine,
	probeOllama,
} from "./onboarding";

let silent: { port: number; stop: (closeActiveConnections?: boolean) => void };
let healthy: ReturnType<typeof Bun.serve>;
let silentHost = "";
let healthyHost = "";
let deadHost = "";
let home: string;
const KEYS = ["HOME", "OLLAMA_HOST", "OLLAMA_BASE_URL"] as const;
const envAtLoad = KEYS.map((k) => [k, process.env[k]] as const);

beforeAll(() => {
	silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
	silentHost = `127.0.0.1:${silent.port}`;
	healthy = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			if (new URL(req.url).pathname === "/api/tags") {
				return Response.json({ models: [{ name: "qwen3:14b" }, { name: "llama3.2:3b" }] });
			}
			return new Response("nope", { status: 404 });
		},
	});
	healthyHost = `127.0.0.1:${healthy.port}`;
	const tmp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	deadHost = `127.0.0.1:${tmp.port}`;
	tmp.stop(true);
	home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-onboarding-probe-"));
});

afterAll(() => {
	silent.stop(true);
	healthy.stop(true);
	for (const [k, v] of envAtLoad) {
		if (v === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = v;
	}
	fs.rmSync(home, { recursive: true, force: true });
});

describe("probeOllama", () => {
	test("the bound is 2 to 3 seconds", () => {
		expect(OLLAMA_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(2000);
		expect(OLLAMA_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(3000);
	});

	test("a host that accepts and never answers is unreachable within the bound", async () => {
		const t0 = performance.now();
		const r = await probeOllama({ env: { OLLAMA_HOST: silentHost }, timeoutMs: 300 });
		expect(performance.now() - t0).toBeLessThan(2000);
		expect(r).toMatchObject({ status: "unreachable", configured: true, timedOut: true });
		if (r.status === "unreachable") expect(r.reason).toBe("no answer within 0.3s");
	});

	test("a refused port is unreachable, not timed out", async () => {
		const r = await probeOllama({ env: { OLLAMA_HOST: deadHost }, timeoutMs: 300 });
		expect(r).toMatchObject({ status: "unreachable", configured: true, timedOut: false });
	});

	test("a healthy host lists its models; OLLAMA_BASE_URL wins over OLLAMA_HOST", async () => {
		const r = await probeOllama({
			env: { OLLAMA_BASE_URL: `http://${healthyHost}`, OLLAMA_HOST: deadHost },
			timeoutMs: 1000,
		});
		expect(r).toEqual({
			status: "found",
			host: `http://${healthyHost}`,
			models: ["qwen3:14b", "llama3.2:3b"],
		});
	});
});

describe("ollamaCheckLine", () => {
	test("pending says it is checking", () => {
		expect(ollamaCheckLine("pending")).toContain("Checking this machine for local models");
	});

	test("a configured host that is down is named as unreachable, never as nothing found", () => {
		const line = ollamaCheckLine({
			status: "unreachable",
			host: "http://10.255.255.1:11434",
			reason: "no answer within 2.5s",
			configured: true,
			timedOut: true,
		});
		expect(line).toBe(
			"Ollama at 10.255.255.1:11434 could not be reached (no answer within 2.5s).\n\n",
		);
	});

	test("a default localhost that times out is named too: something is there and not answering", () => {
		const line = ollamaCheckLine({
			status: "unreachable",
			host: "http://localhost:11434",
			reason: "no answer within 2.5s",
			configured: false,
			timedOut: true,
		});
		expect(line).toContain("could not be reached");
	});

	test("a refused default localhost means no Ollama here, left out like any miss", () => {
		const line = ollamaCheckLine({
			status: "unreachable",
			host: "http://localhost:11434",
			reason: "connection refused or no route",
			configured: false,
			timedOut: false,
		});
		expect(line).toBe("");
	});

	test("found, or detection not started, adds nothing", () => {
		expect(ollamaCheckLine(null)).toBe("");
		expect(ollamaCheckLine({ status: "found", host: "http://h:11434", models: [] })).toBe("");
	});
});

describe("OnboardingManager.detect", () => {
	test("the welcome reads as checking at once, then says the host could not be reached", async () => {
		process.env.HOME = home;
		Reflect.deleteProperty(process.env, "OLLAMA_BASE_URL");
		process.env.OLLAMA_HOST = silentHost;
		const m = new OnboardingManager(home);
		const t0 = performance.now();
		const detection = m.detect();
		// Synchronously after the call: the setup can render now.
		expect(m.getNextQuestion()?.question).toContain("Checking this machine for local models");
		await detection;
		const took = performance.now() - t0;
		// Bounded by the probe, with slack for the other detection commands.
		expect(took).toBeLessThan(OLLAMA_PROBE_TIMEOUT_MS + 4000);
		const welcome = m.getNextQuestion()?.question ?? "";
		expect(welcome).toContain(`Ollama at ${silentHost} could not be reached`);
		expect(welcome).not.toContain("Checking this machine");
		expect(m.getUser().integrations.ollama).toEqual({ available: false, models: [] });
	}, 15000);

	test("detection landing late never overwrites a name the person already gave", () => {
		process.env.HOME = home;
		const m = new OnboardingManager(home);
		m.getUser().identity.name = "Jamie";
		m.applyAutoDetected({
			name: "James Spalding",
			email: null,
			ollamaModels: [],
			githubUsername: null,
			preferredProvider: null,
			hasPython: false,
			hasKittenTTS: false,
		});
		expect(m.getUser().identity.name).toBe("Jamie");
	});
});
