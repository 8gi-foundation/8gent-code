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
let modelCalls = 0;
globalThis.fetch = (async (input, init) => {
	const url = String(typeof input === "string" ? input : input?.url ?? input);
	if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "probe:1b", model: "probe:1b" }] });
	if (url.includes("/chat/completions")) {
		// Count only the real turn: requests that carry the user's message
		// (a capability probe sends its own fixed prompt).
		if (String(init?.body ?? "").includes(MARKER)) modelCalls++;
		return Response.json({
			choices: [{ message: { role: "assistant", content: "DONE: nothing to do." }, finish_reason: "stop" }],
		});
	}
	return new Response("not found", { status: 404 });
});
const { Agent } = await import(${JSON.stringify(AGENT)});
const agent = new Agent({ model: "probe:1b", runtime: "ollama", workingDirectory: process.env.LATCH_WORK, maxTurns: 2 });
const mode = process.env.LATCH_MODE;
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
	await agent.chat(PROMPT);
	result = { stubbed, modelCalls };
} else if (mode === "idle") {
	agent.abort();
	await agent.chat(PROMPT);
	result = { modelCalls };
}
process.stdout.write("\\n@@LATCH@@" + JSON.stringify(result) + "\\n");
await agent.cleanup?.();
process.exit(0);
`;

function runChild(mode: "arm" | "mid" | "idle"): Record<string, unknown> {
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
		expect(runChild("mid")).toEqual({ stubbed: true, modelCalls: 0 });
	}, 60_000);

	test("an idle stop does not cancel the next turn", () => {
		const { modelCalls } = runChild("idle") as { modelCalls: number };
		expect(modelCalls).toBeGreaterThan(0);
	}, 60_000);
});
