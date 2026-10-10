/**
 * Regression tests for the CLI-adapter dogfood defects (#2806-#2810).
 *
 * #2806: timeoutMs must terminate the WHOLE process tree and run() must yield
 *        a terminal event within a bounded window, no matter what shape the
 *        external process tree takes (grandchildren holding the pipes open,
 *        children trapping SIGTERM).
 * #2807: once the process is spawned, abandoning the stream at ANY yield
 *        point must kill it - including the post-spawn "working" yield that
 *        previously sat outside the protecting try/finally.
 * #2808: needsInputPattern is a trust boundary - a backtracking-catastrophic
 *        pattern plus adversarial CLI output must not stall the event loop;
 *        the match is length-capped and budget-guarded (fail safe: a slow
 *        pattern disables itself for the rest of the run).
 * #2809: needs_input has a real delivery path - respond() writes a follow-up
 *        line to the running child's stdin (kept open when a
 *        needsInputPattern is configured), surfaced through
 *        HarnessRunner.respond and POST /harness/respond.
 * #2810: per-line "working" events are throttled at the source and the
 *        runner caps retained events per task, so a verbose CLI cannot flood
 *        memory or SSE subscribers.
 *
 * All process-shape tests use real spawned processes (no mocks) with unique
 * tokens so leaks are provable via `ps` and cleaned up via `pkill`.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { CliHarness } from "../adapters/cli";
import { handleHarnessRoute } from "../http";
import { HarnessRegistry, type StatusEvent } from "../index";
import { HarnessRunner } from "../runner";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-cli.ts", import.meta.url));
const BUN = process.execPath;

const tokens: string[] = [];
function uniqueToken(): string {
	const token = `hxdogfood-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	tokens.push(token);
	return token;
}

afterAll(() => {
	// Never leave a stray fixture process on the host, even if a test failed.
	for (const token of tokens) {
		// pkill does not exist on Windows; the tests that leave these processes are POSIX only.
		if (process.platform !== "win32") Bun.spawnSync(["pkill", "-9", "-f", token]);
	}
});

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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Live processes whose command line contains the token, per `ps`. */
function liveProcesses(token: string): string {
	const result = Bun.spawnSync([
		"/bin/sh",
		"-c",
		`ps ax -o pid,command | grep -F "${token}" | grep -v grep || true`,
	]);
	return result.stdout.toString().trim();
}

/**
 * Drain a run with a hard watchdog so a deadlocked generator fails the test
 * instead of hanging the suite. Abandons the iterator if the watchdog fires.
 */
async function collectWithWatchdog(
	iter: AsyncIterable<StatusEvent>,
	watchdogMs: number,
): Promise<{ events: StatusEvent[]; watchdogFired: boolean }> {
	const it = iter[Symbol.asyncIterator]();
	const events: StatusEvent[] = [];
	const drain = (async () => {
		while (true) {
			const r = await it.next();
			if (r.done) break;
			events.push(r.value);
		}
	})();
	const winner = await Promise.race([
		drain.then(() => "completed" as const),
		sleep(watchdogMs).then(() => "watchdog" as const),
	]);
	if (winner === "watchdog") void it.return?.(undefined);
	return { events, watchdogFired: winner === "watchdog" };
}

// POSIX only: kills by process group and finds grandchildren with ps; Windows tree-kill is not covered here.
describe.skipIf(process.platform === "win32")(
	"#2806 timeout kills the whole process tree, bounded",
	() => {
		it("terminates a wrapper whose grandchild holds the pipes open, within a bounded window", async () => {
			const token = uniqueToken();
			const harness = fixtureHarness("hang-tree", { timeoutMs: 300 });
			const startedAt = Date.now();
			const { events, watchdogFired } = await collectWithWatchdog(
				harness.run({ id: "d1", prompt: token }),
				8_000,
			);

			expect(watchdogFired).toBe(false);
			const last = events[events.length - 1];
			expect(last?.state).toBe("error");
			expect(last?.output).toContain("timed out");
			expect(Date.now() - startedAt).toBeLessThan(6_000);

			await sleep(300);
			expect(liveProcesses(token)).toBe("");
		}, 20_000);

		it("escalates to SIGKILL when the child traps SIGTERM", async () => {
			const token = uniqueToken();
			const harness = fixtureHarness("trap-term", { timeoutMs: 300 });
			const startedAt = Date.now();
			const { events, watchdogFired } = await collectWithWatchdog(
				harness.run({ id: "d2", prompt: token }),
				8_000,
			);

			expect(watchdogFired).toBe(false);
			expect(events[events.length - 1]?.state).toBe("error");
			expect(Date.now() - startedAt).toBeLessThan(6_000);

			await sleep(300);
			expect(liveProcesses(token)).toBe("");
		}, 20_000);

		it("yields a terminal event even when the child exits 0 but a grandchild keeps the pipe open", async () => {
			const token = uniqueToken();
			const harness = fixtureHarness("orphan-pipe", { timeoutMs: 10_000 });
			const startedAt = Date.now();
			const { events, watchdogFired } = await collectWithWatchdog(
				harness.run({ id: "d3", prompt: token }),
				8_000,
			);

			// The wrapper exits 0 almost immediately; the run must settle on the
			// wrapper's exit, not wait for the orphaned grandchild's EOF.
			expect(watchdogFired).toBe(false);
			const last = events[events.length - 1];
			expect(last?.state).toBe("done");
			expect(Date.now() - startedAt).toBeLessThan(6_000);

			await sleep(300);
			expect(liveProcesses(token)).toBe("");
		}, 20_000);
	},
);

describe("#2807 abandonment at any yield point kills the spawned process", () => {
	// POSIX only: proves the kill with ps.
	it.skipIf(process.platform === "win32")(
		"kills the child when the consumer breaks right after the post-spawn working yield",
		async () => {
			const token = uniqueToken();
			const harness = fixtureHarness("hang-quiet", { timeoutMs: 60_000 });

			let n = 0;
			for await (const _e of harness.run({ id: "d4", prompt: token })) {
				n++;
				if (n >= 2) break; // queued, then the post-spawn "working" yield
			}
			expect(n).toBe(2);

			await sleep(400);
			expect(liveProcesses(token)).toBe("");
		},
		15_000,
	);
});

describe("#2808 needsInputPattern is guarded against catastrophic backtracking", () => {
	it("survives a pathological pattern against adversarial output without stalling the run", async () => {
		const harness = fixtureHarness("redos", {
			needsInputPattern: /(a+)+$/i,
			timeoutMs: 30_000,
		});
		const startedAt = Date.now();
		const { events, watchdogFired } = await collectWithWatchdog(
			harness.run({ id: "d5", prompt: "go" }),
			25_000,
		);

		expect(watchdogFired).toBe(false);
		expect(events[events.length - 1]?.state).toBe("done");
		// 10 pathological lines at ~400ms+ of synchronous backtracking each
		// would take 4s+ unguarded. Guarded: bounded to roughly one budgeted
		// probe before the pattern disables itself.
		expect(Date.now() - startedAt).toBeLessThan(2_500);
	}, 30_000);
});

describe("#2809 needs_input has a real delivery path", () => {
	it("respond() writes a follow-up line to the child's stdin after needs_input", async () => {
		const harness = fixtureHarness("interactive", {
			needsInputPattern: /\[y\/N\]/i,
			timeoutMs: 10_000,
		});

		const events: StatusEvent[] = [];
		let responded = false;
		for await (const e of harness.run({ id: "d6", prompt: "risky op" })) {
			events.push(e);
			if (e.state === "needs_input" && !responded) {
				responded = true;
				expect(harness.respond("d6", "y")).toBe(true);
			}
		}

		expect(responded).toBe(true);
		const last = events[events.length - 1];
		expect(last?.state).toBe("done");
		expect(last?.output).toContain("confirmed, proceeding");
	}, 15_000);

	it("respond() returns false for unknown or finished tasks", async () => {
		const harness = fixtureHarness("lines", { needsInputPattern: /\[y\/N\]/i });
		expect(harness.respond("never-started", "y")).toBe(false);

		const events: StatusEvent[] = [];
		for await (const e of harness.run({ id: "d7", prompt: "x" })) events.push(e);
		expect(events[events.length - 1]?.state).toBe("done");
		expect(harness.respond("d7", "y")).toBe(false);
	}, 15_000);

	it("HarnessRunner.respond routes input to the owning harness's running task", async () => {
		const registry = new HarnessRegistry();
		registry.register(
			fixtureHarness("interactive", {
				needsInputPattern: /\[y\/N\]/i,
				timeoutMs: 10_000,
			}),
		);
		const runner = new HarnessRunner(registry);
		const taskId = runner.start({ prompt: "risky op", harness: "fake-cli" });

		// Wait for the needs_input event to land in the task buffer.
		const deadline = Date.now() + 8_000;
		while (Date.now() < deadline) {
			if (runner.getEvents(taskId).some((e) => e.state === "needs_input")) break;
			await sleep(25);
		}
		expect(runner.getEvents(taskId).some((e) => e.state === "needs_input")).toBe(true);
		expect(runner.respond(taskId, "y")).toBe(true);

		while (Date.now() < deadline) {
			const events = runner.getEvents(taskId);
			const last = events[events.length - 1];
			if (last?.state === "done" || last?.state === "error") break;
			await sleep(25);
		}
		const events = runner.getEvents(taskId);
		const last = events[events.length - 1];
		expect(last?.state).toBe("done");
		expect(last?.output).toContain("confirmed, proceeding");

		expect(runner.respond("hx_unknown", "y")).toBe(false);
	}, 15_000);

	it("POST /harness/respond delivers input over HTTP and 409s when undeliverable", async () => {
		const registry = new HarnessRegistry();
		registry.register(
			fixtureHarness("interactive", {
				needsInputPattern: /\[y\/N\]/i,
				timeoutMs: 10_000,
			}),
		);
		const runner = new HarnessRunner(registry);
		const taskId = runner.start({ prompt: "risky op", harness: "fake-cli" });

		const deadline = Date.now() + 8_000;
		while (Date.now() < deadline) {
			if (runner.getEvents(taskId).some((e) => e.state === "needs_input")) break;
			await sleep(25);
		}

		const respond = (body: unknown) =>
			handleHarnessRoute(
				new Request("http://localhost/harness/respond", {
					method: "POST",
					body: JSON.stringify(body),
				}),
				new URL("http://localhost/harness/respond"),
				runner,
			);

		const badRes = await respond({ taskId, input: 42 });
		expect(badRes?.status).toBe(400);

		const okRes = await respond({ taskId, input: "y" });
		expect(okRes?.status).toBe(200);
		expect(await okRes?.json()).toEqual({ ok: true });

		while (Date.now() < deadline) {
			const events = runner.getEvents(taskId);
			const last = events[events.length - 1];
			if (last?.state === "done" || last?.state === "error") break;
			await sleep(25);
		}
		expect(runner.getEvents(taskId)[runner.getEvents(taskId).length - 1]?.state).toBe("done");

		const goneRes = await respond({ taskId: "hx_gone", input: "y" });
		expect(goneRes?.status).toBe(409);
	}, 15_000);
});

describe("#2810 event flood is bounded at the source and in the runner", () => {
	it("throttles per-line working events instead of one event per output line", async () => {
		const harness = fixtureHarness("flood");
		const events: StatusEvent[] = [];
		for await (const e of harness.run({ id: "d8", prompt: "flood me" })) events.push(e);

		const last = events[events.length - 1];
		expect(last?.state).toBe("done");
		expect(last?.output).toContain("END-MARKER");
		// 5000 output lines must NOT become ~5000 events.
		const working = events.filter((e) => e.state === "working");
		expect(working.length).toBeLessThan(250);
	}, 20_000);

	it("HarnessRunner caps retained events per task, keeping the first and latest events", async () => {
		const runner = new HarnessRunner();
		const noisy = {
			name: "noisy",
			async *run(task: { id: string }): AsyncIterable<StatusEvent> {
				const base = { agentId: task.id, harness: "noisy", ts: Date.now() };
				yield { ...base, state: "queued" as const };
				for (let i = 0; i < 2_000; i++) {
					yield { ...base, state: "working" as const, elapsedMs: i };
				}
				yield { ...base, state: "done" as const, output: "finished" };
			},
		};
		runner.registry.register(noisy);
		const taskId = runner.start({ prompt: "spam", harness: "noisy" });

		const deadline = Date.now() + 8_000;
		while (Date.now() < deadline) {
			const events = runner.getEvents(taskId);
			if (events[events.length - 1]?.state === "done") break;
			await sleep(20);
		}

		const events = runner.getEvents(taskId);
		expect(events[events.length - 1]?.state).toBe("done");
		expect(events.length).toBeLessThanOrEqual(500);
		expect(events[0]?.state).toBe("queued");
	}, 15_000);
});
