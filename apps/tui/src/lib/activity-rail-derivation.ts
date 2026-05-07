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

/**
 * Derive the last N tool calls from the message stream.
 *
 * Each onToolStart appends a message with id `tool-start-{callId}` and
 * role `tool`. onToolEnd does NOT push a separate message; instead it
 * sets `toolSuccess` on the same row (best effort - some agents reuse
 * the same id, some overwrite). We treat the absence of `toolSuccess`
 * on a recent tool message as "running".
 */
export function deriveTools(
	messages: ReadonlyArray<Pick<Message, "role" | "content" | "toolSuccess" | "id">>,
	activeToolName: string | null,
	limit = 5,
): ActivityRailToolStatus[] {
	const tools: ActivityRailToolStatus[] = [];
	// Walk from newest to oldest, pick tool messages.
	for (let i = messages.length - 1; i >= 0 && tools.length < limit; i--) {
		const m = messages[i];
		if (!m || m.role !== "tool") continue;
		const name = parseToolName(m.content) ?? "tool";
		let state: ActivityRailToolState;
		if (typeof m.toolSuccess === "boolean") {
			state = m.toolSuccess ? "ok" : "fail";
		} else if (activeToolName && name.toLowerCase() === activeToolName.toLowerCase()) {
			state = "running";
		} else {
			// No success flag and not active: assume running unless older than the
			// active tool. Default to idle for older entries to keep the rail honest.
			state = "idle";
		}
		tools.push({ name, state });
	}
	return tools;
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
 * Derive providers from the failover chain. The runtime ModelFailover
 * exposes only `resolve(model)` which returns the active head. We treat
 * the head as `local` and synthesize a fallback + offline placeholder
 * so the rail always shows three tiers - matches the spec "local +
 * fallback + offline".
 */
export interface ProviderSnapshot {
	primary: { name: string; latencyMs?: number } | null;
	fallback: { name: string; latencyMs?: number } | null;
	offline: { name: string; latencyMs?: number } | null;
}

export function deriveProviders(snap: ProviderSnapshot): ActivityRailProviderRow[] {
	const rows: ActivityRailProviderRow[] = [];
	const fmt = (ms?: number) => (typeof ms === "number" ? `${Math.round(ms)}ms` : "—");
	if (snap.primary) {
		rows.push({ name: snap.primary.name, state: "local", latency: fmt(snap.primary.latencyMs) });
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
 * Derive an active-tasks row from kanban + planning state. Today we
 * surface the in-progress kanban items (one row each) plus a synthetic
 * "tool: {activeTool}" row when the agent is mid-call but kanban is
 * empty. Returns [] when nothing is in flight - ActivityRail renders
 * "idle" in that case.
 */
export interface KanbanLike {
	inProgress: ReadonlyArray<{ id: string; description: string }>;
	ready: ReadonlyArray<unknown>;
}

export function deriveActiveTasks(
	kanban: KanbanLike | null,
	activeTool: string | null,
	isProcessing: boolean,
): ActivityRailTask[] {
	const out: ActivityRailTask[] = [];
	if (kanban && kanban.inProgress.length > 0) {
		for (const item of kanban.inProgress) {
			out.push({ id: item.id, label: item.description, progress: 50 });
		}
	}
	if (out.length === 0 && isProcessing && activeTool) {
		out.push({ id: "tool-active", label: `tool: ${activeTool}`, progress: 50 });
	}
	return out;
}
