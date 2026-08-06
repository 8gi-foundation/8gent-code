/**
 * Tests for the tasks board derivation.
 *
 * These are weighted toward the ways a board LIES, because that is the failure
 * mode that matters here: a board showing phantom work, or dressing a clean
 * shutdown up as a failure, is worse than no board. Every fixture below is
 * shaped from real payloads read off the live relay at 127.0.0.1:7890.
 */
import { describe, expect, test } from "bun:test";
import {
	BOARD_COLUMNS,
	buildBoard,
	extractRefs,
	isTaskWorker,
	toMillis,
	workerState,
	type BoardSources,
	type HelmWorker,
} from "../board";

/** An officer DESK exactly as the live relay reports one: alive, attributed,
 *  and carrying no prompt because nothing was ever asked of it. */
const desk: HelmWorker = {
	id: "889fc67b",
	kind: "codex",
	cwd: "",
	prompt: null,
	state: "running",
	status: "idle",
	started_at: 1786032005,
	last_activity: 1786040034.5,
	adopted: true,
	meta: { officer: "8TO" },
};

/** A real TASK worker: spawned by executeApproved, so it carries the prompt. */
const taskWorker: HelmWorker = {
	id: "w-task-1",
	kind: "claude",
	cwd: "/Users/x/8gent-code",
	prompt: "open a PR that fixes the failing table test",
	state: "running",
	status: "running",
	started_at: 1786047974,
	last_activity: 1786058707,
	adopted: false,
	meta: { officer: "8PO", token: "AB12CD", channel: "chan-1", isTask: true },
};

function sources(over: Partial<BoardSources> = {}): BoardSources {
	return {
		listWorkers: async () => [],
		workerOutput: async () => "",
		listPending: () => [],
		...over,
	};
}

describe("desks are not tasks", () => {
	test("an idle officer desk is never a board row", () => {
		expect(isTaskWorker(desk)).toBe(false);
	});

	test("a worker carrying a prompt is a task", () => {
		expect(isTaskWorker(taskWorker)).toBe(true);
	});

	test("an adopted worker is a desk even if a prompt survived", () => {
		// Adoption loses the original context, so claiming to know the task would
		// be a guess. Conservative direction: under-report rather than invent.
		expect(isTaskWorker({ ...taskWorker, adopted: true })).toBe(false);
	});

	test("eight live desks produce zero tasks and eight desks", async () => {
		// The regression this whole distinction exists to prevent: a board that
		// permanently shows the entire boardroom as busy.
		const eight = ["8EO", "8PO", "8TO", "8DO", "8SO", "8CO", "8MO", "8GO"].map((code, i) => ({
			...desk,
			id: `desk-${i}`,
			meta: { officer: code },
		}));
		const board = await buildBoard(sources({ listWorkers: async () => eight }));
		expect(board.tasks).toHaveLength(0);
		expect(board.desks).toHaveLength(8);
		expect(board.desks.map((d) => d.officerName)).toContain("Samantha");
	});

	test("an exited desk is not shown as a person at a desk", async () => {
		const board = await buildBoard(
			sources({ listWorkers: async () => [{ ...desk, status: "exited", state: "failed" }] }),
		);
		expect(board.desks).toHaveLength(0);
	});
});

describe("worker state is reported honestly", () => {
	test("SIGTERM is stopped, not failed", () => {
		// helm-bridge stops a worker as soon as it has watched the output settle,
		// so this pair is the most common ending for SUCCESSFUL work. Calling it
		// failed would mark most completed tasks red.
		expect(workerState({ id: "a", state: "failed", exit_code: 143 })).toBe("stopped");
		expect(workerState({ id: "a", state: "failed", exit_code: 137 })).toBe("stopped");
	});

	test("a genuine non-zero exit is a failure", () => {
		expect(workerState({ id: "a", state: "failed", exit_code: 1 })).toBe("failed");
	});

	test("exit zero is done even when helm says failed", () => {
		expect(workerState({ id: "a", state: "failed", exit_code: 0 })).toBe("done");
	});

	test("needs_input is its own state, not a failure", () => {
		expect(workerState({ id: "a", state: "needs_input" })).toBe("needs_you");
	});
});

describe("no invented data", () => {
	test("an empty system produces an empty board, not a demo row", async () => {
		const board = await buildBoard(sources());
		expect(board.tasks).toEqual([]);
		expect(board.desks).toEqual([]);
		expect(board.warnings).toEqual([]);
	});

	test("a worker with no officer attribution is dropped, not given an owner", async () => {
		const orphan = { ...taskWorker, meta: null };
		const board = await buildBoard(sources({ listWorkers: async () => [orphan] }));
		expect(board.tasks).toHaveLength(0);
	});

	test("an unknown cwd stays null rather than becoming a plausible path", async () => {
		const board = await buildBoard(
			sources({ listWorkers: async () => [{ ...taskWorker, cwd: "" }] }),
		);
		expect(board.tasks[0].cwd).toBeNull();
	});

	test("an unreachable relay warns instead of looking idle", async () => {
		// "I could not read the workers" and "nothing is running" look identical on
		// an empty board and mean opposite things.
		const board = await buildBoard(
			sources({
				listWorkers: async () => {
					throw new Error("connection refused");
				},
			}),
		);
		expect(board.warnings).toHaveLength(1);
		expect(board.warnings[0]).toContain("Could not reach the worker relay");
	});

	test("an unknown officer code falls back to the code, never a made-up name", async () => {
		const board = await buildBoard(
			sources({ listWorkers: async () => [{ ...taskWorker, meta: { officer: "8ZZ" } }] }),
		);
		expect(board.tasks[0].officerName).toBe("8ZZ");
	});
});

describe("proposals", () => {
	const pending = {
		token: "AB12CD",
		channelId: "chan-1",
		agentId: "agent:8PO",
		createdAt: 1_700_000_000_000,
		kind: "claude" as const,
		cwd: "/Users/x/8gent-code",
		command: "add a regression test for the board",
		isTask: true,
	};

	test("a staged proposal becomes a proposed row owned by its officer", async () => {
		const board = await buildBoard(sources({ listPending: () => [pending] }));
		expect(board.tasks).toHaveLength(1);
		const t = board.tasks[0];
		expect(t.state).toBe("proposed");
		expect(t.officerCode).toBe("8PO");
		expect(t.officerName).toBe("Samantha");
		expect(t.token).toBe("AB12CD");
		expect(t.title).toBe("add a regression test for the board");
		// A proposal has not run, so it must not carry evidence.
		expect(t.evidence).toBeUndefined();
	});

	test("a proposal carries the deadline after which approving it fails", async () => {
		const board = await buildBoard(sources({ listPending: () => [pending] }));
		expect(board.tasks[0].expiresAt).toBe(pending.createdAt + 15 * 60 * 1000);
	});
});

describe("evidence", () => {
	test("a finished task is verified and a running one is only asserted", async () => {
		const done = { ...taskWorker, id: "w-done", state: "done", status: "exited", exit_code: 0 };
		const board = await buildBoard(
			sources({
				listWorkers: async () => [done, taskWorker],
				workerOutput: async () => "all good",
			}),
		);
		const byId = Object.fromEntries(board.tasks.map((t) => [t.id, t]));
		expect(byId["w-done"].evidence?.label).toBe("verified");
		expect(byId["w-task-1"].evidence?.label).toBe("asserted");
	});

	test("a worker whose output cannot be read still shows its row", async () => {
		const board = await buildBoard(
			sources({
				listWorkers: async () => [taskWorker],
				workerOutput: async () => {
					throw new Error("gone");
				},
			}),
		);
		expect(board.tasks).toHaveLength(1);
		expect(board.tasks[0].evidence?.output).toBe("");
	});
});

describe("references are extracted, never guessed", () => {
	test("a full PR url is captured with its link", () => {
		const refs = extractRefs("opened https://github.com/8gi-foundation/8gent-code/pull/2847 for review");
		expect(refs).toContainEqual({
			kind: "pr",
			label: "#2847",
			url: "https://github.com/8gi-foundation/8gent-code/pull/2847",
		});
	});

	test("an issue url is an issue, not a PR", () => {
		const refs = extractRefs("see https://github.com/8gi-foundation/8gent-code/issues/12");
		expect(refs[0].kind).toBe("issue");
	});

	test("a bare number is ignored unless something names it", () => {
		// "#2847" in a diff or a log line is not a PR reference.
		expect(extractRefs("changed 42 files, #2847 lines moved")).toEqual([]);
		expect(extractRefs("Closes #2847").map((r) => r.label)).toEqual(["#2847"]);
	});

	test("a loose hex string is not mistaken for a commit", () => {
		expect(extractRefs("integrity sha512 deadbeefcafe1234")).toEqual([]);
		expect(extractRefs("commit a1b2c3d4e5")[0]).toEqual({ kind: "commit", label: "a1b2c3d4" });
	});

	test("branch names are picked up from real git output", () => {
		const refs = extractRefs("Switched to a new branch 'feat/table-tasks-board'");
		expect(refs).toContainEqual({ kind: "branch", label: "feat/table-tasks-board" });
	});

	test("the same reference twice yields one row", () => {
		const out = "Closes #10 and again Closes #10";
		expect(extractRefs(out)).toHaveLength(1);
	});

	test("empty output yields no references", () => {
		expect(extractRefs("")).toEqual([]);
	});
});

describe("ordering and columns", () => {
	test("what needs James comes before what is merely running", async () => {
		const asking = { ...taskWorker, id: "w-ask", state: "needs_input" };
		const board = await buildBoard(sources({ listWorkers: async () => [taskWorker, asking] }));
		expect(board.tasks[0].id).toBe("w-ask");
	});

	test("every column maps to a state the sources can prove", () => {
		// Guards against a future column being added that nothing can populate.
		const states = new Set(BOARD_COLUMNS.map((c) => c.state));
		expect(states.size).toBe(BOARD_COLUMNS.length);
		expect(states.has("needs_you")).toBe(true);
		// "approved" is deliberately absent - approval and execution happen in the
		// same tick, so it is not an observable state. See board.ts's header.
		expect([...states]).not.toContain("approved");
	});
});

describe("timestamps", () => {
	test("relay seconds become milliseconds", () => {
		expect(toMillis(1786032005)).toBe(1786032005000);
	});

	test("a value already in milliseconds is left alone", () => {
		expect(toMillis(1786032005000)).toBe(1786032005000);
	});

	test("a missing or zero timestamp is undefined, not 1970", () => {
		expect(toMillis(undefined)).toBeUndefined();
		expect(toMillis(0)).toBeUndefined();
	});
});
