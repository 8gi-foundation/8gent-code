/**
 * Time-travel daemon verbs tests.
 *
 * Issue: 8gi-foundation/8gent-code#2757 (session time-travel, step 2).
 * Covers the protocol handler for timetravel:list / timetravel:rewind /
 * timetravel:fork over fake pool/agents backed by a REAL TimeTravelStore
 * on a temp dir, so the wire behaviour is validated against the actual
 * content-addressed persistence, not mocks of it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type CheckpointMessage, TimeTravelStore } from "../eight/timetravel/checkpoint-store";
import {
	type TimeTravelAgent,
	type TimeTravelPool,
	handleTimeTravel,
	isTimeTravelMessageType,
} from "./timetravel-verbs";

let dataDir: string;
let store: TimeTravelStore;

function msg(role: string, content: string): CheckpointMessage {
	return { role, content };
}

/**
 * Minimal in-memory Agent standing in for packages/eight Agent: same
 * time-travel surface, same restore-in-place semantics.
 */
class FakeAgent implements TimeTravelAgent {
	history: CheckpointMessage[] = [];
	constructor(private readonly ttSessionId: string) {}

	getTimeTravelSessionId(): string {
		return this.ttSessionId;
	}

	listTimeTravelCheckpoints() {
		return store.list(this.ttSessionId);
	}

	rewindTimeTravel(steps = 1) {
		const restored = store.rewind(this.ttSessionId, steps);
		if (!restored) return null;
		this.history = restored.messages;
		return restored;
	}

	adoptTimeTravelFork(sourceSessionId: string, checkpointId: string) {
		const meta = store.fork(sourceSessionId, checkpointId, this.ttSessionId);
		const { messages } = store.load(this.ttSessionId, meta.id);
		this.history = messages;
		return { meta, messages };
	}
}

class FakePool implements TimeTravelPool {
	agents = new Map<string, FakeAgent>();
	createdChannels: string[] = [];

	addSession(sessionId: string): FakeAgent {
		const agent = new FakeAgent(`tt_${sessionId}`);
		this.agents.set(sessionId, agent);
		return agent;
	}

	hasSession(sessionId: string): boolean {
		return this.agents.has(sessionId);
	}

	createSession(sessionId: string, channel: string): void {
		this.createdChannels.push(channel);
		this.addSession(sessionId);
	}

	getAgent(sessionId: string): FakeAgent | null {
		return this.agents.get(sessionId) ?? null;
	}
}

let pool: FakePool;

beforeEach(() => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "timetravel-verbs-test-"));
	store = new TimeTravelStore({ dataDir });
	pool = new FakePool();
});

afterEach(() => {
	fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Seed a session with three checkpoints of growing history. */
function seedSession(sessionId: string): FakeAgent {
	const agent = pool.addSession(sessionId);
	const tt = agent.getTimeTravelSessionId();
	store.save(tt, [msg("user", "fix the bug")], { reason: "manual", toolCallCount: 0 });
	store.save(tt, [msg("user", "fix the bug"), msg("assistant", "reading tests")], {
		reason: "interval",
		toolCallCount: 8,
	});
	store.save(
		tt,
		[msg("user", "fix the bug"), msg("assistant", "reading tests"), msg("assistant", "patching")],
		{ reason: "interval", toolCallCount: 16 },
	);
	return agent;
}

describe("isTimeTravelMessageType", () => {
	it("recognises the three verbs and nothing else", () => {
		expect(isTimeTravelMessageType("timetravel:list")).toBe(true);
		expect(isTimeTravelMessageType("timetravel:rewind")).toBe(true);
		expect(isTimeTravelMessageType("timetravel:fork")).toBe(true);
		expect(isTimeTravelMessageType("prompt")).toBe(false);
		expect(isTimeTravelMessageType("timetravel:destroy")).toBe(false);
	});
});

describe("timetravel:list", () => {
	it("returns checkpoint summaries oldest first, without message hashes", () => {
		seedSession("s_one");
		const out = handleTimeTravel({ type: "timetravel:list" }, { pool, activeSessionId: "s_one" });
		if (out.type !== "timetravel:list") throw new Error(`expected list, got ${out.type}`);
		expect(out.sessionId).toBe("s_one");
		expect(out.checkpoints.length).toBe(3);
		expect(out.checkpoints[0].messageCount).toBe(1);
		expect(out.checkpoints[2].messageCount).toBe(3);
		expect(out.checkpoints[2].toolCallCount).toBe(16);
		expect("messageHashes" in out.checkpoints[0]).toBe(false);
	});

	it("uses the explicit sessionId over the connection's active session", () => {
		seedSession("s_target");
		pool.addSession("s_active");
		const out = handleTimeTravel(
			{ type: "timetravel:list", sessionId: "s_target" },
			{ pool, activeSessionId: "s_active" },
		);
		if (out.type !== "timetravel:list") throw new Error(`expected list, got ${out.type}`);
		expect(out.sessionId).toBe("s_target");
		expect(out.checkpoints.length).toBe(3);
	});

	it("errors when there is no session at all", () => {
		const out = handleTimeTravel({ type: "timetravel:list" }, { pool, activeSessionId: null });
		expect(out.type).toBe("error");
	});

	it("errors when the session is not in the pool", () => {
		const out = handleTimeTravel(
			{ type: "timetravel:list", sessionId: "s_ghost" },
			{ pool, activeSessionId: null },
		);
		if (out.type !== "error") throw new Error("expected error");
		expect(out.message).toContain("s_ghost");
	});
});

describe("timetravel:rewind", () => {
	it("rewinds one checkpoint by default and restores that history in place", () => {
		const agent = seedSession("s_one");
		const out = handleTimeTravel({ type: "timetravel:rewind" }, { pool, activeSessionId: "s_one" });
		if (out.type !== "timetravel:rewound") throw new Error(`expected rewound, got ${out.type}`);
		expect(out.steps).toBe(1);
		expect(out.messageCount).toBe(2);
		expect(agent.history.map((m) => m.content)).toEqual(["fix the bug", "reading tests"]);
	});

	it("rewind steps=0 restores the latest checkpoint", () => {
		const agent = seedSession("s_one");
		const out = handleTimeTravel(
			{ type: "timetravel:rewind", steps: 0 },
			{ pool, activeSessionId: "s_one" },
		);
		if (out.type !== "timetravel:rewound") throw new Error(`expected rewound, got ${out.type}`);
		expect(out.messageCount).toBe(3);
		expect(agent.history.length).toBe(3);
	});

	it("errors when rewinding past the oldest checkpoint", () => {
		seedSession("s_one");
		const out = handleTimeTravel(
			{ type: "timetravel:rewind", steps: 99 },
			{ pool, activeSessionId: "s_one" },
		);
		if (out.type !== "error") throw new Error("expected error");
		expect(out.message).toContain("99");
	});

	it("rejects negative and non-integer steps without touching the agent", () => {
		const agent = seedSession("s_one");
		for (const steps of [-1, 1.5]) {
			const out = handleTimeTravel(
				{ type: "timetravel:rewind", steps },
				{ pool, activeSessionId: "s_one" },
			);
			expect(out.type).toBe("error");
		}
		expect(agent.history.length).toBe(0);
	});
});

describe("timetravel:fork", () => {
	it("forks the latest checkpoint into a new session on the connection's channel", () => {
		seedSession("s_one");
		const out = handleTimeTravel(
			{ type: "timetravel:fork" },
			{
				pool,
				activeSessionId: "s_one",
				channel: "os",
				generateSessionId: () => "s_fork1",
			},
		);
		if (out.type !== "timetravel:forked") throw new Error(`expected forked, got ${out.type}`);
		expect(out.sessionId).toBe("s_fork1");
		expect(out.sourceSessionId).toBe("s_one");
		expect(out.messageCount).toBe(3);
		expect(pool.createdChannels).toEqual(["os"]);

		const forkAgent = pool.getAgent("s_fork1");
		if (!forkAgent) throw new Error("fork session missing from pool");
		expect(forkAgent.history.map((m) => m.content)).toEqual([
			"fix the bug",
			"reading tests",
			"patching",
		]);
	});

	it("forks a specific earlier checkpoint and the lineages diverge independently", () => {
		const agent = seedSession("s_one");
		const first = agent.listTimeTravelCheckpoints()[0];
		const out = handleTimeTravel(
			{ type: "timetravel:fork", checkpointId: first.id },
			{ pool, activeSessionId: "s_one", generateSessionId: () => "s_fork2" },
		);
		if (out.type !== "timetravel:forked") throw new Error(`expected forked, got ${out.type}`);
		expect(out.forkedFrom).toBe(first.id);
		expect(out.messageCount).toBe(1);
		expect(out.checkpoint.forkedFrom).toBe(first.id);

		// The fork's lineage grows without touching the source session.
		const forkAgent = pool.getAgent("s_fork2");
		if (!forkAgent) throw new Error("fork session missing from pool");
		store.save(
			forkAgent.getTimeTravelSessionId(),
			[msg("user", "fix the bug"), msg("assistant", "approach B")],
			{ reason: "interval", toolCallCount: 4 },
		);
		expect(store.list(forkAgent.getTimeTravelSessionId()).length).toBe(2);
		expect(agent.listTimeTravelCheckpoints().length).toBe(3);
	});

	it("errors on an unknown checkpoint id without creating a session", () => {
		seedSession("s_one");
		const out = handleTimeTravel(
			{ type: "timetravel:fork", checkpointId: "cp_missing" },
			{ pool, activeSessionId: "s_one" },
		);
		if (out.type !== "error") throw new Error("expected error");
		expect(out.message).toContain("cp_missing");
		expect(pool.createdChannels.length).toBe(0);
	});

	it("errors when the session has no checkpoints to fork", () => {
		pool.addSession("s_empty");
		const out = handleTimeTravel({ type: "timetravel:fork" }, { pool, activeSessionId: "s_empty" });
		if (out.type !== "error") throw new Error("expected error");
		expect(out.message).toContain("no checkpoints");
	});

	it("explicit channel on the message wins over the connection channel", () => {
		seedSession("s_one");
		const out = handleTimeTravel(
			{ type: "timetravel:fork", channel: "delegation" },
			{ pool, activeSessionId: "s_one", channel: "os", generateSessionId: () => "s_fork3" },
		);
		expect(out.type).toBe("timetravel:forked");
		expect(pool.createdChannels).toEqual(["delegation"]);
	});
});
