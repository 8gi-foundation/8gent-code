import { describe, expect, test } from "bun:test";
import {
	type AgentOutcomeInput,
	agentOutcome,
	needsRespawn,
	pendingRespawns,
	relativeTo,
} from "./agent-outcome";

const WD = "/work";
let clock = 0;
function agent(
	over: Partial<Omit<AgentOutcomeInput, "task">> & { scope?: string[]; task?: string } = {},
): AgentOutcomeInput {
	return {
		id: over.id ?? `agent-${++clock}`,
		status: over.status ?? "completed",
		startedAt: over.startedAt ?? new Date(1_000 + clock * 1_000),
		task: { description: over.task ?? "fix it" },
		config: { allowedPaths: over.scope, workingDirectory: WD },
		filesChanged: over.filesChanged ?? [],
	};
}

describe("needsRespawn", () => {
	test("a scoped agent that changed none of its scope needs a re-spawn", () => {
		expect(needsRespawn(agent({ scope: ["src/a.ts"] }))).toBe(true);
		expect(needsRespawn(agent({ scope: ["src/a.ts"], filesChanged: ["src/b.ts"] }))).toBe(true);
	});

	test("changing a file in scope (relative, absolute, under a directory) is done", () => {
		expect(needsRespawn(agent({ scope: ["src/a.ts"], filesChanged: ["src/a.ts"] }))).toBe(false);
		expect(needsRespawn(agent({ scope: ["./src/a.ts"], filesChanged: ["/work/src/a.ts"] }))).toBe(
			false,
		);
		expect(needsRespawn(agent({ scope: ["src"], filesChanged: ["src/deep/a.ts"] }))).toBe(false);
	});

	test("failed always needs one; running and unscoped never do", () => {
		expect(needsRespawn(agent({ status: "failed" }))).toBe(true);
		expect(needsRespawn(agent({ status: "running", scope: ["src/a.ts"] }))).toBe(false);
		expect(needsRespawn(agent({}))).toBe(false);
	});
});

describe("agentOutcome", () => {
	test("says plainly that a scoped agent that changed nothing is not done", () => {
		const out = agentOutcome(agent({ scope: ["src/wordcount.ts"] }));
		expect(out).toStartWith("ENDED WITHOUT CHANGING src/wordcount.ts.");
		expect(out).toContain("Re-spawn it now with the same task and allowedPaths");
	});

	test("a write with no verification is named as not verified, never as fixed", () => {
		expect(agentOutcome(agent({ scope: ["src/a.ts"], filesChanged: ["src/a.ts"] }))).toBe(
			"changed src/a.ts, not verified",
		);
	});

	test("verified outcomes (#3126)", () => {
		const fixed = agent({ scope: ["src/a.ts"], filesChanged: ["src/a.ts"] });
		fixed.verification = [{ file: "src/a.ts", state: "fixed", test: "src/a.test.ts" }];
		expect(agentOutcome(fixed)).toBe("FIXED src/a.ts (src/a.test.ts passes)");
		expect(needsRespawn(fixed)).toBe(false);

		const failing = agent({ scope: ["src/a.ts"], filesChanged: ["src/a.ts"] });
		failing.verification = [
			{ file: "src/a.ts", state: "test-fails", test: "src/a.test.ts", firstFailure: "(fail) adds" },
		];
		expect(agentOutcome(failing)).toStartWith(
			"CHANGED BUT ITS TEST FAILS: src/a.ts (src/a.test.ts: (fail) adds). Its task is NOT done",
		);
		expect(needsRespawn(failing)).toBe(true);

		const same = agent({ scope: ["src/a.ts"], filesChanged: ["src/a.ts"] });
		same.verification = [{ file: "src/a.ts", state: "unchanged" }];
		expect(agentOutcome(same)).toStartWith(
			"ENDED WITHOUT CHANGING src/a.ts (it wrote src/a.ts but left the content as it was).",
		);
		expect(needsRespawn(same)).toBe(true);

		const untested = agent({ scope: ["src/a.ts"], filesChanged: ["src/a.ts"] });
		untested.verification = [{ file: "src/a.ts", state: "unverified" }];
		expect(agentOutcome(untested)).toBe("changed src/a.ts, not verified (no test)");
		expect(needsRespawn(untested)).toBe(false);
	});

	test("an unscoped agent that changed nothing gets a conditional line", () => {
		expect(agentOutcome(agent({}))).toStartWith(
			"ended without changing any file. If its task needed",
		);
	});

	test("running and failed", () => {
		expect(agentOutcome(agent({ status: "running" }))).toBe("still running");
		const failed = agent({ status: "failed", scope: ["x.ts"] });
		failed.task.error = "Ollama is not running";
		expect(agentOutcome(failed)).toStartWith(
			"FAILED: Ollama is not running. Its task is NOT done.",
		);
	});
});

describe("pendingRespawns", () => {
	test("lists a sibling that ended without doing its task, never the caller", () => {
		const quit = agent({ scope: ["src/w.ts"] });
		const slow = agent({ status: "running", scope: ["src/c.ts"] });
		expect(pendingRespawns([quit, slow], slow.id)).toEqual([quit]);
		expect(pendingRespawns([quit, slow], quit.id)).toEqual([]);
	});

	test("a later agent on the same scope takes the job over", () => {
		const quit = agent({ scope: ["src/w.ts"] });
		const retry = agent({ status: "running", scope: ["./src/w.ts"] });
		expect(pendingRespawns([quit, retry])).toEqual([]);
	});

	test("unscoped agents match on the task text", () => {
		const failed = agent({ status: "failed", task: "do X" });
		expect(pendingRespawns([failed])).toEqual([failed]);
		expect(pendingRespawns([failed, agent({ status: "running", task: "do X" })])).toEqual([]);
		expect(pendingRespawns([failed, agent({ status: "running", task: "do Y" })])).toEqual([failed]);
	});
});

test("relativeTo keeps paths inside the working directory relative", () => {
	expect(relativeTo(WD, "/work/src/a.ts")).toBe("src/a.ts");
	expect(relativeTo(WD, "src/a.ts")).toBe("src/a.ts");
	expect(relativeTo(WD, "/etc/hosts")).toBe("/etc/hosts");
});
