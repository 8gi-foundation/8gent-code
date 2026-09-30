/**
 * What a finished sub-agent actually did, in words an Orchestrator acts on.
 *
 * Pilot l4-spawn-parallel-m5 (2026-09-30_070309): a llama3.2:3b sub-agent
 * ended having changed nothing, and check_agent said only
 * `"status": "completed"` plus the agent's own claim of success. The
 * Orchestrator found out by reading the file, after its sibling had already
 * finished, so the retry ran alone and the parallel proof failed.
 *
 * check_agent now reports the files an agent changed (successful write_file /
 * edit_file calls, recorded by the pool) and, when it ended without touching
 * its scope, says plainly that its task is not done and to re-spawn it now.
 * Every check also lists sibling agents in that state, so whichever agent the
 * Orchestrator polls, it learns of the one that needs a re-spawn.
 *
 * Pure, no I/O.
 */

import * as path from "node:path";
import type { FileVerdict } from "./verify-scope";

/** The slice of a pooled agent this module reads. */
export interface AgentOutcomeInput {
	id: string;
	status: string;
	startedAt: Date;
	task: { description: string; error?: string };
	config: { allowedPaths?: string[]; workingDirectory: string };
	filesChanged?: string[];
	/** Per scoped file, set by the pool when the agent ends: hash compare plus its sibling test. */
	verification?: FileVerdict[];
}

/** A file path relative to the agent's working directory, for display and matching. */
export function relativeTo(workingDirectory: string, file: string): string {
	const abs = path.resolve(workingDirectory, file);
	const rel = path.relative(workingDirectory, abs);
	return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs;
}

/**
 * True when a finished agent did not do its task: it failed, or it had an edit
 * scope and changed none of it. With no scope the task may have been read-only,
 * so changing nothing is not by itself a failure.
 */
export function needsRespawn(agent: AgentOutcomeInput): boolean {
	if (agent.status === "failed") return true;
	if (agent.status !== "completed") return false;
	const changed = agent.filesChanged ?? [];
	const scope = agent.config.allowedPaths;
	if (!scope || scope.length === 0) return false;
	const v = agent.verification;
	if (v && v.length > 0)
		return v.some((x) => x.state === "test-fails") || v.every((x) => x.state === "unchanged");
	const wd = agent.config.workingDirectory;
	return !changed.some((f) => {
		const abs = path.resolve(wd, f);
		return scope.some((p) => {
			const allowed = path.resolve(wd, p);
			return abs === allowed || abs.startsWith(`${allowed}${path.sep}`);
		});
	});
}

/** One sentence on what this agent did, and what the Orchestrator should do next. */
export function agentOutcome(agent: AgentOutcomeInput): string {
	const changed = agent.filesChanged ?? [];
	const scope = agent.config.allowedPaths ?? [];
	if (agent.status === "running" || agent.status === "idle") {
		return changed.length > 0
			? `still running; changed so far: ${changed.join(", ")}`
			: "still running";
	}
	if (agent.status === "failed") {
		return `FAILED: ${agent.task.error ?? "no error given"}. Its task is NOT done. Re-spawn it now with the same task${scope.length ? " and allowedPaths" : ""}; do not wait for the other agents.`;
	}
	if (agent.status === "cancelled") return "cancelled";
	if (changed.length === 0 && scope.length === 0) {
		return "ended without changing any file. If its task needed a file change, it is NOT done, whatever its result says: re-spawn it now; do not wait for the other agents.";
	}
	const v = agent.verification;
	if (scope.length > 0 && v && v.length > 0 && !v.every((x) => x.state === "unchanged")) {
		const said = v.map(fileVerdictText).join("; ");
		return needsRespawn(agent)
			? `${said}. Its task is NOT done, whatever its result says. Re-spawn it now with the same task and allowedPaths; do not wait for the other agents.`
			: said;
	}
	if (!needsRespawn(agent)) return `changed ${changed.join(", ")}, not verified`;
	const wroteScope = v?.length ? changed.filter((f) => v.some((x) => x.file === f)) : [];
	const also = wroteScope.length
		? ` (it wrote ${wroteScope.join(", ")} but left the content as it was)`
		: changed.length
			? ` (it changed only ${changed.join(", ")})`
			: "";
	return `ENDED WITHOUT CHANGING ${scope.join(", ")}${also}. Its task is NOT done, whatever its result says. Re-spawn it now with the same task and allowedPaths; do not wait for the other agents.`;
}

/** One scoped file's verdict, in words. Never "fixed" without a passing test. */
export function fileVerdictText(v: FileVerdict): string {
	switch (v.state) {
		case "fixed":
			return `FIXED ${v.file} (${v.test} passes)`;
		case "test-fails":
			return `CHANGED BUT ITS TEST FAILS: ${v.file} (${v.test}: ${v.firstFailure})`;
		case "test-timeout":
			return `changed ${v.file}, not verified (${v.test} did not finish in ${Math.round(v.timeoutMs / 1000)}s)`;
		case "unverified":
			return `changed ${v.file}, not verified (no test)`;
		case "unchanged":
			return `did not change ${v.file}`;
	}
}

/** Two agents doing the same job: same scope when both have one, else the same task. */
function sameJob(a: AgentOutcomeInput, b: AgentOutcomeInput): boolean {
	const key = (x: AgentOutcomeInput) =>
		x.config.allowedPaths?.length
			? `scope:${x.config.allowedPaths
					.map((p) => path.resolve(x.config.workingDirectory, p))
					.sort()
					.join("|")}`
			: `task:${x.task.description.trim()}`;
	return key(a) === key(b);
}

/**
 * Finished agents, other than `selfId`, whose task is not done and that no
 * later agent has taken over (a later spawn with the same scope or task).
 */
export function pendingRespawns<T extends AgentOutcomeInput>(
	agents: readonly T[],
	selfId?: string,
): T[] {
	return agents.filter(
		(a) =>
			a.id !== selfId &&
			needsRespawn(a) &&
			!agents.some(
				(b) => b !== a && b.startedAt.getTime() > a.startedAt.getTime() && sameJob(a, b),
			),
	);
}
