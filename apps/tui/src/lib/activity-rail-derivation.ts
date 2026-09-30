/**
 * Pure helpers that translate the agent's running state into the
 * shapes the V2 ActivityRail expects.
 *
 * Everything in this module is a pure function of inputs - no side
 * effects, no fs, no subprocess, no React. Lets the TUI pass live
 * data to ActivityRail without ActivityRail caring where it came from.
 */

import type {
	ActiveTask as ActivityRailTask,
	ToolStatus as ActivityRailToolStatus,
	ToolState as ActivityRailToolState,
	ProviderRow as ActivityRailProviderRow,
	ProviderState as ActivityRailProviderState,
	AgentRow as ActivityRailAgentRow,
} from "../components/ActivityRail.js";
import type { Message } from "../app.js";
import type { PlanStep } from "./plan-state.js";

/**
 * Derive the last N tool calls from the message stream.
 *
 * onToolStart appends `tool-start-{callId}` (content `→ name(args)`) and
 * onToolEnd appends a separate `tool-end-{callId}` carrying toolSuccess
 * and the trail entry. The two rows are one call, so they are paired by
 * call id: a start with an end is finished (ok / fail), a start with no
 * end is still running, but only while a turn is live. Once the turn is
 * over nothing is running, whatever the message stream says.
 *
 * Counting the start rows as separate "idle" tools is what made the rail
 * print `queued 2` for the whole session (audit 2026-09-29, #4).
 */
export function deriveTools(
	messages: ReadonlyArray<Pick<Message, "role" | "content" | "toolSuccess" | "id" | "toolTrail">>,
	isProcessing: boolean,
	limit = 5,
): ActivityRailToolStatus[] {
	const ended = new Map<string, Pick<Message, "toolSuccess" | "toolTrail">>();
	for (const m of messages) {
		if (m?.role === "tool" && m.id.startsWith("tool-end-")) ended.set(m.id.slice("tool-end-".length), m);
	}
	const tools: ActivityRailToolStatus[] = [];
	for (let i = messages.length - 1; i >= 0 && tools.length < limit; i--) {
		const m = messages[i];
		if (!m || m.role !== "tool" || m.id.startsWith("tool-end-")) continue;
		const callId = m.id.startsWith("tool-start-") ? m.id.slice("tool-start-".length) : null;
		const end = callId ? ended.get(callId) : undefined;
		const name = end?.toolTrail?.tool ?? parseToolName(m.content) ?? "tool";
		const success = end ? end.toolSuccess : m.toolSuccess;
		let state: ActivityRailToolState;
		if (typeof success === "boolean") state = success ? "ok" : "fail";
		else state = isProcessing ? "running" : "idle";
		tools.push({ name, state });
	}
	return tools;
}

/**
 * Calls the model has issued this turn that are waiting behind the active
 * one. Zero whenever no turn is live, so it always drains.
 */
export function queuedToolCount(tools: ReadonlyArray<ActivityRailToolStatus>, isProcessing: boolean): number {
	if (!isProcessing) return 0;
	return Math.max(0, tools.filter((tl) => tl.state === "running").length - 1);
}

/**
 * Tool messages render as `→ {name}({argsPreview})`. Recover the name
 * from that prefix. Returns null if the message doesn't match.
 */
export function parseToolName(content: string): string | null {
	if (!content) return null;
	const m = content.match(/^[→>\s]*([A-Za-z_][\w.\-]*)\s*\(/);
	return m?.[1] ?? null;
}

/**
 * Derive the PROVIDERS rows. Every row names a real route:
 *   - primary: the provider and model the TUI is configured to use;
 *   - fallback: the next hop in the real failover chain for that model
 *     (see `fallbackFromChain`), or no row at all when the chain has none;
 *   - offline: only when something reports a route down.
 * Latency is shown only when it was measured. There is no placeholder
 * glyph for an unknown value: the slot is simply empty.
 */
export interface ProviderSnapshot {
	primary: { name: string; latencyMs?: number } | null;
	fallback: { name: string; latencyMs?: number } | null;
	offline: { name: string; latencyMs?: number } | null;
}

export function deriveProviders(snap: ProviderSnapshot): ActivityRailProviderRow[] {
	const rows: ActivityRailProviderRow[] = [];
	const fmt = (ms?: number) => (typeof ms === "number" ? `${Math.round(ms)}ms` : undefined);
	if (snap.primary) {
		rows.push({ name: snap.primary.name, state: "primary", latency: fmt(snap.primary.latencyMs) });
	}
	if (snap.fallback) {
		rows.push({
			name: snap.fallback.name,
			state: "fallback",
			latency: fmt(snap.fallback.latencyMs),
		});
	}
	if (snap.offline) {
		rows.push({ name: snap.offline.name, state: "offline", latency: fmt(snap.offline.latencyMs) });
	}
	return rows;
}

/** The one call the rail needs from `ModelFailover` (packages/providers/failover.ts). */
export interface FailoverChainReader {
	nextHop(model: string, provider: string): { model: string; provider: string } | null;
}

/**
 * The fallback row for the configured route: where the agent would really
 * go if this provider/model failed now, read from the failover chain
 * (`~/.8gent/failover.json`, else the built-in chains). Null, so the rail
 * shows no fallback row, when the chain has no entry for the model or no
 * model is set. Never a fixed "free tier" guess.
 */
export function fallbackFromChain(
	chain: FailoverChainReader | null,
	provider: string,
	model: string,
): { name: string } | null {
	if (!chain || !provider || !model) return null;
	const hop = chain.nextHop(model, provider);
	return hop ? { name: `${hop.provider}:${hop.model}` } : null;
}

/**
 * Derive agent pool view from the orchestration hook. Maps the live
 * agents array into the rail's two-state shape (idle / active /
 * blocked). We collapse arbitrary persona statuses into those buckets.
 */
export interface OrchestrationAgentSnapshot {
	id: string;
	name: string;
	status: string;
}

export function deriveAgents(
	agents: ReadonlyArray<OrchestrationAgentSnapshot>,
): ActivityRailAgentRow[] {
	if (agents.length === 0) {
		// No real agents wired - return a quiet idle row instead of stub names.
		return [{ name: "main", state: "idle" }];
	}
	return agents.map((a) => {
		const s = (a.status || "").toLowerCase();
		let state: ActivityRailAgentRow["state"] = "idle";
		if (s.includes("block") || s.includes("wait") || s.includes("deny")) state = "blocked";
		else if (s.includes("run") || s.includes("active") || s.includes("work")) state = "active";
		return { name: a.name || "agent", state };
	});
}

/**
 * Derive the TASKS rows from the same plan the PLAN column shows.
 *
 * The plan (update_plan events, or the agent's own PLAN: block) is the only
 * source, so TASKS and PLAN can never disagree:
 *   - a step the agent marked in progress is the task, with a bar that is
 *     the real share of steps done (`2/5`), never a guessed percentage;
 *   - a plan with no step in progress shows its tally;
 *   - a live turn with no plan says `working`, never `idle`;
 *   - no turn and no plan is `idle` (an empty list).
 * The active tool is not a task: it is already in TOOLS › active.
 */
export function deriveActiveTasks(
	plan: ReadonlyArray<Pick<PlanStep, "id" | "text" | "status">>,
	isProcessing: boolean,
): ActivityRailTask[] {
	if (plan.length === 0) {
		return isProcessing ? [{ id: "working", label: "working, no plan yet" }] : [];
	}
	const done = plan.filter((s) => s.status === "done").length;
	const total = plan.length;
	const progress = Math.round((done / total) * 100);
	const detail = `${done}/${total}`;
	const active = plan.filter((s) => s.status === "active");
	if (active.length > 0) {
		return active.map((s) => ({ id: s.id, label: s.text, progress, detail }));
	}
	return [{ id: "plan-tally", label: `${done} of ${total} steps done`, progress, detail }];
}

/**
 * Extract plan steps from text the agent itself wrote during a run.
 *
 * This is the only source that may seed the plan board: a `PLAN:` block
 * followed by numbered (`1.` / `1)`) or bulleted (`-` / `•`) lines. The
 * user's own words are never inspected, and nothing is invented when no
 * plan is present - the result is simply empty.
 */
export function planStepsFromText(text: string | null | undefined): string[] {
	if (!text) return [];
	const planMatch = text.match(/PLAN:\s*([\s\S]*?)(?:\n\n|$)/i);
	if (!planMatch?.[1]) return [];
	// A plan written on one line ("PLAN: 1) read 2) patch 3) test") becomes
	// one step per number. Only a marker after whitespace splits, so "1.2"
	// or "v2.1" inside a step never does.
	const block = planMatch[1].replace(/\s+(?=\d+[.)]\s)/g, "\n");
	const stepMatches = block.match(/(?:\d+[.)]\s*|[-•]\s+)([^\n]+)/g);
	if (!stepMatches) return [];
	return stepMatches
		.map((s) => s.replace(/^\d+[.)]\s*|^[-•]\s+/, "").trim())
		.filter((s) => s.length > 0);
}
