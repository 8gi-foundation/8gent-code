/**
 * agent-node.ts - an ExecutorNode that wraps a tool-capable local model
 * (e.g. ornith-1.0-9b in LM Studio) so the adaptive pipeline can hand it a
 * scoped goal and let it run its OWN agentic tool loop to actually write files.
 *
 * The pipeline's deterministic brain plans and verifies; this node ACTS. We do
 * not trust the model's prose about what it did - we snapshot the working
 * directory before and after the run and report what changed on disk. The agent
 * only "succeeded" if it actually produced a non-empty file.
 *
 * The real loop lives in ../eight/agent.ts (class Agent). It is injected via
 * `runAgent` so tests can pass a fake and never touch a live model.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../eight/types.js";
import type { ExecRequest, ExecResult, ExecutorNode } from "./pipeline-contracts.js";

/**
 * Injection seam for the agentic loop. The default implementation drives the
 * real Agent; tests substitute a fake so no live model is ever called.
 */
export type RunAgentFn = (args: {
	model: string;
	runtime: string;
	workingDirectory: string;
	maxTurns: number;
	message: string;
	signal?: AbortSignal;
}) => Promise<string>;

/** Directories that never count as agent output. */
const IGNORED_DIRS = new Set(["node_modules", ".git", ".next"]);

/** Max characters of assistant text we keep in the transcript. */
const TRANSCRIPT_LIMIT = 600;

/**
 * Default runAgent: construct the real Agent, run its tool loop, return text.
 * Imported lazily so tests that inject a fake never load the heavy agent stack.
 */
const defaultRunAgent: RunAgentFn = async ({
	model,
	runtime,
	workingDirectory,
	maxTurns,
	message,
}) => {
	const { Agent } = await import("../eight/agent.js");
	// `runtime` is a provider string chosen upstream by the pipeline/CLI; Agent's
	// config narrows it to the known provider union. The value is validated before
	// it reaches here, so we assert the narrower type at the construction seam.
	const agent = new Agent({
		model,
		runtime: runtime as AgentConfig["runtime"],
		workingDirectory,
		maxTurns,
	});
	try {
		const text = await agent.chat(message);
		return text ?? "";
	} finally {
		await agent.cleanup();
	}
};

/** Recursively list files under `dir`, skipping ignored directories. */
function snapshotFiles(dir: string): Map<string, number> {
	const out = new Map<string, number>();
	if (!existsSync(dir)) return out;
	const walk = (current: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(current);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(current, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (IGNORED_DIRS.has(name)) continue;
				walk(full);
			} else if (st.isFile()) {
				out.set(full, st.mtimeMs);
			}
		}
	};
	walk(dir);
	return out;
}

/**
 * Files that are new or modified versus `before` AND currently exist non-empty.
 * This is the disk-truth check: prose is irrelevant, bytes are not.
 */
function diffWritten(before: Map<string, number>, after: Map<string, number>): string[] {
	const written: string[] = [];
	for (const [path, mtime] of after) {
		const prior = before.get(path);
		const changed = prior === undefined || mtime > prior;
		if (!changed) continue;
		try {
			if (statSync(path).size > 0) written.push(path);
		} catch {
			// vanished between snapshot and stat; skip.
		}
	}
	return written.sort();
}

/** Convert a soft token budget into a bounded turn count for the agent loop. */
function budgetToMaxTurns(budgetTokens: number): number {
	return Math.max(4, Math.min(12, Math.round(budgetTokens / 2000)));
}

/**
 * Build an agentic ExecutorNode for a tool-capable local model.
 *
 * @param opts.provider  runtime/provider key, e.g. "lmstudio".
 * @param opts.model     model id, e.g. "ornith-1.0-9b".
 * @param opts.runAgent  optional injected loop (defaults to the real Agent).
 */
export function createAgentNode(opts: {
	provider: string;
	model: string;
	runAgent?: RunAgentFn;
}): ExecutorNode {
	const runAgent = opts.runAgent ?? defaultRunAgent;

	return {
		key: `${opts.provider}:${opts.model}`,
		kind: "agent",
		async run(req: ExecRequest): Promise<ExecResult> {
			// 1. Snapshot disk before the agent touches anything.
			const before = snapshotFiles(req.workingDirectory);

			// 2. Compose the scoped message and bound the loop.
			const message = req.context
				? `${req.goal}\n\nProject structure / context:\n${req.context}`
				: req.goal;
			const maxTurns = budgetToMaxTurns(req.budgetTokens);

			// 3. Run the agent's own tool loop.
			let assistantText: string;
			try {
				assistantText = await runAgent({
					model: opts.model,
					runtime: opts.provider,
					workingDirectory: req.workingDirectory,
					maxTurns,
					message,
					signal: req.signal,
				});
			} catch (err) {
				return {
					ok: false,
					filesWritten: [],
					transcript: "",
					error: err instanceof Error ? err.message : String(err),
				};
			}

			// 4. Snapshot after and trust the disk, not the prose.
			const after = snapshotFiles(req.workingDirectory);
			const filesWritten = diffWritten(before, after);

			// 5. Success = the agent actually wrote a non-empty file.
			return {
				ok: filesWritten.length > 0,
				filesWritten,
				transcript: (assistantText ?? "").slice(0, TRANSCRIPT_LIMIT),
			};
		},
	};
}
