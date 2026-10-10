/**
 * CliHarness - generic external-CLI harness adapter (part of #2797).
 *
 * Driven end-to-end against a real spawned process: the fake CLI fixture
 * (fixtures/fake-cli.ts) emits known lines and exit codes so every mapping
 * heuristic is exercised with real subprocess I/O, no mocks.
 *
 * Covers:
 *   - lifecycle: queued -> working -> done on exit 0, output carries stdout
 *   - non-zero exit ends the stream with exactly one error event
 *   - a prompt-pattern line surfaces as a needs_input event
 *   - honesty: never fabricates tokens or tool names (external CLIs report
 *     neither), elapsedMs is real wall clock on the terminal event
 *   - security: prompt travels as a single argv element (no shell, metachar
 *     payloads arrive verbatim), stdin delivery works, spawn failures fail
 *     safe as error events, runaway processes are killed on timeout
 *   - opt-in registration: env-var config registers named CLI harnesses;
 *     invalid config registers nothing; the default registry stays local-only
 */

import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import {
	CLI_HARNESS_ENV,
	CliHarness,
	parseCliHarnessConfigs,
	registerCliHarnessesFromEnv,
} from "../adapters/cli";
import { HarnessRegistry, type StatusEvent, createDefaultRegistry } from "../index";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-cli.ts", import.meta.url));
const BUN = process.execPath;

function fixtureHarness(
	mode: string,
	overrides: Partial<ConstructorParameters<typeof CliHarness>[0]> = {},
): CliHarness {
	return new CliHarness({
		name: "fake-cli",
		command: BUN,
		args: [FIXTURE, mode],
		...overrides,
	});
}

async function collect(iter: AsyncIterable<StatusEvent>): Promise<StatusEvent[]> {
	const out: StatusEvent[] = [];
	for await (const e of iter) out.push(e);
	return out;
}

describe("CliHarness", () => {
	it("uses the configured harness name", () => {
		expect(fixtureHarness("lines").name).toBe("fake-cli");
	});

	it("streams queued -> working -> done on exit 0 with stdout as output", async () => {
		const harness = fixtureHarness("lines");
		const events = await collect(harness.run({ id: "c1", prompt: "do work" }));

		expect(events[0]?.state).toBe("queued");
		expect(events.some((e) => e.state === "working")).toBe(true);
		const last = events[events.length - 1];
		expect(last?.state).toBe("done");
		expect(last?.output).toContain("scanning repository");
		expect(last?.output).toContain("applying patch");
		for (const e of events) {
			expect(e.agentId).toBe("c1");
			expect(e.harness).toBe("fake-cli");
			expect(typeof e.ts).toBe("number");
		}
	});

	it("ends with exactly one error event on non-zero exit", async () => {
		const harness = fixtureHarness("fail");
		const events = await collect(harness.run({ id: "c2", prompt: "explode" }));

		const errors = events.filter((e) => e.state === "error");
		expect(errors.length).toBe(1);
		expect(events[events.length - 1]?.state).toBe("error");
		expect(errors[0]?.output).toContain("boom");
		expect(events.some((e) => e.state === "done")).toBe(false);
	});

	it("surfaces a prompt-pattern line as needs_input, then still terminates done", async () => {
		const harness = fixtureHarness("prompt", { needsInputPattern: /\[y\/N\]/i });
		const events = await collect(harness.run({ id: "c3", prompt: "risky" }));

		expect(events.some((e) => e.state === "needs_input")).toBe(true);
		expect(events[events.length - 1]?.state).toBe("done");
	});

	it("never fabricates tokens or tool names and stamps real elapsedMs", async () => {
		const harness = fixtureHarness("lines");
		const events = await collect(harness.run({ id: "c4", prompt: "honest" }));

		for (const e of events) {
			expect(e.tokens).toBeUndefined();
			expect(e.tool).toBeUndefined();
		}
		const last = events[events.length - 1];
		expect(typeof last?.elapsedMs).toBe("number");
		expect(last?.elapsedMs).toBeGreaterThanOrEqual(0);
	});

	it("passes the prompt as one argv element: shell metacharacters arrive verbatim", async () => {
		const payload = 'fix bug; rm -rf / && echo "$(whoami)" `id` | cat';
		const harness = fixtureHarness("echo-args");
		const events = await collect(harness.run({ id: "c5", prompt: payload }));

		const last = events[events.length - 1];
		expect(last?.state).toBe("done");
		// The fixture prints each argv element on its own line. The whole
		// payload must be ONE line, proving it was never shell-interpreted
		// or split.
		expect(last?.output?.split("\n")).toContain(payload);
	});

	it("substitutes a {prompt} placeholder arg instead of appending", async () => {
		const harness = new CliHarness({
			name: "fake-cli",
			command: BUN,
			args: [FIXTURE, "echo-args", "--task", "{prompt}", "--json"],
		});
		const events = await collect(harness.run({ id: "c6", prompt: "the task" }));

		const last = events[events.length - 1];
		expect(last?.output?.split("\n")).toEqual(
			expect.arrayContaining(["--task", "the task", "--json"]),
		);
		// Appended-duplicate check: the prompt appears exactly once.
		const lines = last?.output?.split("\n") ?? [];
		expect(lines.filter((l) => l === "the task").length).toBe(1);
	});

	it("delivers the prompt over stdin when promptVia is stdin", async () => {
		const harness = fixtureHarness("stdin-echo", { promptVia: "stdin" });
		const events = await collect(harness.run({ id: "c7", prompt: "hello stdin" }));

		const last = events[events.length - 1];
		expect(last?.state).toBe("done");
		expect(last?.output).toContain("STDIN:hello stdin");
	});

	it("fails safe: a nonexistent command yields an error event, never throws", async () => {
		const harness = new CliHarness({
			name: "ghost",
			command: "/nonexistent/definitely-not-a-real-cli-8gent",
		});
		const events = await collect(harness.run({ id: "c8", prompt: "hi" }));

		expect(events[0]?.state).toBe("queued");
		expect(events[events.length - 1]?.state).toBe("error");
		expect(events.filter((e) => e.state === "error").length).toBe(1);
	});

	it("kills a runaway process and errors after timeoutMs", async () => {
		const harness = fixtureHarness("hang", { timeoutMs: 300 });
		const startedAt = Date.now();
		const events = await collect(harness.run({ id: "c9", prompt: "hang" }));

		const last = events[events.length - 1];
		expect(last?.state).toBe("error");
		expect(last?.output).toContain("timed out");
		// The fixture would sleep 60s; finishing fast proves the kill.
		expect(Date.now() - startedAt).toBeLessThan(10_000);
	});
});

describe("parseCliHarnessConfigs", () => {
	it("returns [] for missing or empty input", () => {
		expect(parseCliHarnessConfigs(undefined)).toEqual([]);
		expect(parseCliHarnessConfigs("")).toEqual([]);
	});

	it("returns [] for invalid JSON or non-array JSON", () => {
		expect(parseCliHarnessConfigs("not json")).toEqual([]);
		expect(parseCliHarnessConfigs('{"name":"x"}')).toEqual([]);
	});

	it("parses valid entries and skips invalid ones", () => {
		const raw = JSON.stringify([
			{ name: "codex-cli", command: "codex", args: ["exec"] },
			{ name: "", command: "bad" },
			{ command: "no-name" },
			{ name: "no-command" },
			{ name: "bad-args", command: "x", args: [1, 2] },
			{ name: "bad-regex", command: "x", needsInputPattern: "([" },
		]);
		const configs = parseCliHarnessConfigs(raw);
		expect(configs.length).toBe(1);
		expect(configs[0]?.name).toBe("codex-cli");
		expect(configs[0]?.command).toBe("codex");
		expect(configs[0]?.args).toEqual(["exec"]);
	});
});

describe("registerCliHarnessesFromEnv", () => {
	it("is a no-op when the env var is unset", () => {
		const registry = new HarnessRegistry();
		const registered = registerCliHarnessesFromEnv(registry, {});
		expect(registered).toEqual([]);
		expect(registry.list()).toEqual([]);
	});

	it("registers configured CLI harnesses opt-in via the env var", () => {
		const registry = createDefaultRegistry();
		const env = {
			[CLI_HARNESS_ENV]: JSON.stringify([
				{ name: "codex-cli", command: "codex", args: ["exec"] },
				{ name: "claude-cli", command: "claude", promptVia: "stdin" },
			]),
		};
		const registered = registerCliHarnessesFromEnv(registry, env);
		expect(registered).toEqual(["codex-cli", "claude-cli"]);
		expect(registry.list()).toEqual(["8gent-local", "codex-cli", "claude-cli"]);
		expect(registry.get("codex-cli")).toBeInstanceOf(CliHarness);
	});

	it("skips entries that collide with an already-registered name", () => {
		const registry = createDefaultRegistry();
		const env = {
			[CLI_HARNESS_ENV]: JSON.stringify([
				{ name: "8gent-local", command: "evil" },
				{ name: "ok-cli", command: "ok" },
			]),
		};
		const registered = registerCliHarnessesFromEnv(registry, env);
		expect(registered).toEqual(["ok-cli"]);
		expect(registry.list()).toEqual(["8gent-local", "ok-cli"]);
	});

	it("stays NOT default: a fresh default registry has only 8gent-local", () => {
		expect(createDefaultRegistry().list()).toEqual(["8gent-local"]);
	});
});
