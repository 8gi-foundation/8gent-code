/**
 * #3521: a stop pressed before the turn's abort controller exists must still
 * cancel the turn.
 *
 * Before: abort() acted only when this.abortController was set. chat() awaits
 * several pre-turn steps (pre-tool router, capability probe, ...) before the
 * controller is created, so an ESC in that window was dropped with no log and
 * the model call went ahead. abort() now latches the stop, every controller is
 * created through armController(), which honours the latch, and chat() clears
 * the latch on entry so an idle stop never cancels the next turn.
 *
 * Each case runs one real Agent in a child process with HOME in a temp dir,
 * the Ollama hosts pointed at a dead port and fetch stubbed, so no model and
 * no network is touched.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";

afterAll(cleanupTempDirs);

const AGENT = join(import.meta.dir, "..", "agent.ts");
const MARKER = "LATCH_PROBE_TURN";
// Specific enough that the proactive-questioning gate does not fire, so chat()
// reaches the pre-tool router await the "mid" case stubs.
const PROMPT = `${MARKER} add a function named sum to src/math.ts that returns a + b, using TypeScript, with a unit test in src/math.test.ts`;

// The child: stub fetch, build an Agent on the local text-tool path, run the
// scenario named by LATCH_MODE, print one JSON result line.
const CHILD = `
const MARKER = ${JSON.stringify(MARKER)};
const PROMPT = ${JSON.stringify(PROMPT)};
const mode = process.env.LATCH_MODE;
let modelCalls = 0;
let agent;
// native429: calls counted when the stop was pressed, -1 until then.
let callsAtStop = -1;
if (mode === "native429") {
	// Press stop 300 ms into the agent's own 429 backoff (its first wait is
	// 2 s). The AI SDK's internal 429 retries honour the signal already; this
	// targets the harness loop's wait, where the signal used to be lost.
	const log = console.log;
	console.log = (...args) => {
		log(...args);
		if (callsAtStop < 0 && String(args[0]).includes("rate limited, retry in")) {
			setTimeout(() => { callsAtStop = modelCalls; agent.abort(); }, 300);
		}
	};
}
globalThis.fetch = (async (input, init) => {
	const url = String(typeof input === "string" ? input : input?.url ?? input);
	if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "probe:1b", model: "probe:1b" }] });
	const body = String(init?.body ?? "");
	// Count only the real turn: requests that carry the user's message (a
	// capability probe sends its own fixed prompt). Any chat endpoint counts.
	if (body.includes(MARKER)) {
		modelCalls++;
		if (mode === "native429" && callsAtStop < 0) {
			// Rate limited until the stop; a call after it would succeed.
			return new Response(JSON.stringify({ error: { message: "429 rate limit exceeded" } }), {
				status: 429,
				headers: { "content-type": "application/json" },
			});
		}
	}
	if (url.includes("/chat/completions")) {
		return Response.json({
			choices: [{ message: { role: "assistant", content: "DONE: nothing to do." }, finish_reason: "stop" }],
		});
	}
	return new Response("not found", { status: 404 });
});
const { Agent } = await import(${JSON.stringify(AGENT)});
agent = new Agent({ model: "probe:1b", runtime: "ollama", workingDirectory: process.env.LATCH_WORK, maxTurns: 2 });
let result = {};
if (mode === "arm") {
	// No stop pressed: a freshly armed controller is live.
	const fresh = agent.armController().signal.aborted;
	// A stop with no controller in place (a second agent, so no live one exists).
	const stopped = new Agent({ model: "probe:1b", runtime: "ollama", workingDirectory: process.env.LATCH_WORK, maxTurns: 2 });
	stopped.abort();
	const afterStop = stopped.armController().signal.aborted;
	await stopped.cleanup?.();
	result = { fresh, afterStop };
} else if (mode === "mid") {
	// A stop that lands while chat() is awaiting a pre-turn step.
	let stubbed = false;
	agent.tryRunPreToolRouter = async () => { stubbed = true; agent.abort(); };
	const reply = await agent.chat(PROMPT);
	result = { stubbed, modelCalls, reply };
} else if (mode === "idle") {
	agent.abort();
	await agent.chat(PROMPT);
	result = { modelCalls };
} else if (mode === "native429") {
	// Native AI SDK path (EIGHT_TEXT_TOOLS=0). A stopped turn may end by
	// throwing the abort; either way no second model call may start.
	let reply = "";
	let threw = "";
	try { reply = await agent.chat(PROMPT); } catch (err) { threw = String(err?.name ?? err); }
	// Give a wrongly scheduled retry time to fire before counting.
	await new Promise((r) => setTimeout(r, 2500));
	result = { callsAtStop, modelCalls, threw };
}
process.stdout.write("\\n@@LATCH@@" + JSON.stringify(result) + "\\n");
await agent.cleanup?.();
process.exit(0);
`;

function runChild(mode: "arm" | "mid" | "idle" | "native429"): Record<string, unknown> {
	const root = tempDir("abort-latch-");
	mkdirSync(join(root, "home"));
	mkdirSync(join(root, "work"));
	const r = Bun.spawnSync(["bun", "-e", CHILD], {
		cwd: join(root, "work"),
		env: {
			...process.env,
			HOME: join(root, "home"),
			OLLAMA_HOST: "http://127.0.0.1:9",
			EIGHT_DECIDE_OLLAMA_HOST: "http://127.0.0.1:9",
			LATCH_MODE: mode,
			// The native case forces the AI SDK path; the others stay on text tools.
			EIGHT_TEXT_TOOLS: mode === "native429" ? "0" : "1",
			LATCH_WORK: join(root, "work"),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const line = r.stdout
		.toString()
		.split("\n")
		.find((l) => l.startsWith("@@LATCH@@"));
	if (!line) throw new Error(`child printed no result (exit ${r.exitCode}): ${r.stderr.toString().slice(-1200)}`);
	return JSON.parse(line.slice("@@LATCH@@".length));
}

describe("stop-signal latch (#3521)", () => {
	test("a stop before the controller exists aborts the controller when it is armed", () => {
		expect(runChild("arm")).toEqual({ fresh: false, afterStop: true });
	}, 60_000);

	test("a stop during a pre-turn await cancels the turn before any model call", () => {
		// stubbed: the stop really landed inside chat(), not before it.
		// The reply names the stop instead of a generic model failure.
		expect(runChild("mid")).toEqual({ stubbed: true, modelCalls: 0, reply: "Stopped." });
	}, 60_000);

	test("a stop during the native-path 429 backoff stops the retry", () => {
		const r = runChild("native429") as { callsAtStop: number; modelCalls: number; threw: string };
		// The stop really landed in the backoff, after at least one rate-limited call...
		expect(r.callsAtStop).toBeGreaterThan(0);
		// ...and no model call started after it.
		expect(r.modelCalls).toBe(r.callsAtStop);
	}, 60_000);

	test("an idle stop does not cancel the next turn", () => {
		const { modelCalls } = runChild("idle") as { modelCalls: number };
		expect(modelCalls).toBeGreaterThan(0);
	}, 60_000);
});
