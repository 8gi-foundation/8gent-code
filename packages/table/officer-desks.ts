/**
 * Officer terminals - provision, verify, and (on request) tear down each Table
 * officer's PERSISTENT Helm worker: their own long-lived tmux session, running
 * their bound EXECUTION harness (resolveHarness), attributed to them via the
 * spawn's `meta.officer`. This is the "8 employees at 8 real desks" layer - see
 * ~/8gi-governance/docs/8GENT-OFFICER-TERMINALS.md for the full spec.
 *
 * IDENTITY, NOT EXECUTION. This module only decides WHICH worker belongs to
 * WHICH officer and whether one is already alive; it never runs Table-approved
 * work itself (that remains helm-bridge.ts's job, unchanged, still gated on a
 * human's /approve). A desk opens with NO seeded prompt - it is a ready, idle
 * terminal, exactly like an employee's desk before their first ticket, driven
 * later via the normal /helm/worker/{id}/input path (Table, Helm pane, or a
 * human directly).
 *
 * IDEMPOTENT. Calling ensureOfficerDesks() when all 8 desks are already alive
 * spawns nothing - it only tops up whichever officer has no live worker (never
 * seen, or its worker died/finished). Safe to run on every boot, from a cron,
 * or by hand after a `helm/kill`.
 *
 * PERSISTENCE ACROSS A RELAY RESTART is Helm's job, not this script's: helm.py's
 * spawn() stamps {kind, officer} onto the tmux session itself (a @helm_meta user
 * option), and reconcile() reads it back on the next relay boot so an orphaned
 * officer desk keeps its real kind + officer attribution instead of falling back
 * to the honest-but-uninformative "adopted". This script only needs to run again
 * (e.g. from the same boot hook that starts the relay) to top up any officer
 * whose desk did NOT survive - either because reconcile() runs in "kill" mode,
 * or because the desk had already exited before the restart.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listOfficers, type Officer } from "./officers";
import { resolveHarness } from "./harness-config";
import type { HelmKind } from "./helm-bridge";

const HELM_BASE = process.env.GLASSES_RELAY || "http://127.0.0.1:7890";

/** Where an officer desk opens. All 8 officers share the primary dev repo today -
 *  per-officer cwd is a config knob for later, not something this script invents. */
const DESK_CWD = "~/8gent-code";

/** A worker state that means "this officer effectively has no live desk" - either
 *  it never existed, or its session already ended. `needs_input` and `running`
 *  both count as alive (an idle-but-open interactive session IS the desk). */
const DEAD_STATES = new Set(["done", "failed"]);

export interface DeskPlan {
	officer: Officer;
	kind: HelmKind;
	model: string | undefined;
}

export interface DeskResult extends DeskPlan {
	action: "already-alive" | "spawned" | "spawn-failed";
	workerId?: string;
	detail?: string;
}

/** The 8 officers' CURRENT desired desk (bound harness, resolved through any
 *  ~/.8gent/table-harness.json override - same source of truth Table itself uses,
 *  so a desk never drifts from what an approved proposal would actually run on). */
export function desiredDesks(): DeskPlan[] {
	return listOfficers().map((officer) => {
		const harness = resolveHarness(officer.code) ?? officer.harness;
		return { officer, kind: harness.kind as HelmKind, model: harness.model };
	});
}

/** Bearer secret, read fresh, never logged. Mirrors helm-bridge.ts's bearer(). */
function bearer(): string | null {
	const env = process.env.PAIRING_SECRET;
	if (env?.trim()) return env.trim();
	try {
		return fs.readFileSync(path.join(os.homedir(), ".8gent", "relay-pairing-secret"), "utf8").trim() || null;
	} catch {
		return null;
	}
}

async function helm(method: "GET" | "POST", route: string, body?: unknown): Promise<{ status: number; json: any }> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	const b = bearer();
	if (b) headers.Authorization = `Bearer ${b}`;
	const res = await fetch(`${HELM_BASE}${route}`, {
		method, headers, body: body === undefined ? undefined : JSON.stringify(body),
	});
	let json: any = null;
	try { json = await res.json(); } catch { /* non-json body */ }
	return { status: res.status, json };
}

/** Live workers whose meta.officer names a real officer, keyed by officer code.
 *  Only the FIRST live worker per officer is kept (list_workers sorts newest
 *  first, so a duplicate from a bug or a race resolves to the newest one; a
 *  caller who cares about the duplicate should stop the older one explicitly). */
export async function liveOfficerWorkers(): Promise<Map<string, { id: string; kind: string; state: string }>> {
	const { status, json } = await helm("GET", "/helm/workers");
	const map = new Map<string, { id: string; kind: string; state: string }>();
	if (status !== 200 || !Array.isArray(json?.workers)) return map;
	for (const w of json.workers) {
		const code = w?.meta?.officer;
		if (typeof code !== "string" || !code) continue;
		if (DEAD_STATES.has(w.state)) continue;
		if (!map.has(code)) map.set(code, { id: w.id, kind: w.kind, state: w.state });
	}
	return map;
}

/**
 * Ensure every officer has a live desk. Idempotent: an officer already holding a
 * live worker (any state outside DEAD_STATES) is left untouched - never double-
 * spawned, never restarted mid-task. Returns one DeskResult per officer, in
 * roster order, so a caller can print or assert on the exact outcome.
 */
export async function ensureOfficerDesks(): Promise<DeskResult[]> {
	const plans = desiredDesks();
	const live = await liveOfficerWorkers();
	const results: DeskResult[] = [];
	for (const plan of plans) {
		const existing = live.get(plan.officer.code);
		if (existing) {
			results.push({ ...plan, action: "already-alive", workerId: existing.id });
			continue;
		}
		const spawn = await helm("POST", "/helm/spawn", {
			kind: plan.kind,
			cwd: DESK_CWD,
			...(plan.model ? { model: plan.model } : {}),
			meta: { officer: plan.officer.code },
		});
		if (spawn.status === 200 && spawn.json?.id) {
			results.push({ ...plan, action: "spawned", workerId: String(spawn.json.id) });
		} else {
			results.push({
				...plan, action: "spawn-failed",
				detail: `spawn failed (${spawn.status}): ${JSON.stringify(spawn.json).slice(0, 300)}`,
			});
		}
	}
	return results;
}

/** Stop every CURRENTLY LIVE officer desk (not ad-hoc Table-approved workers,
 *  which already self-stop in helm-bridge.ts). Explicit opt-in only - never
 *  called by ensureOfficerDesks() or any automatic path. */
export async function stopOfficerDesks(): Promise<{ code: string; workerId: string; stopped: boolean }[]> {
	const live = await liveOfficerWorkers();
	const out: { code: string; workerId: string; stopped: boolean }[] = [];
	for (const [code, w] of live) {
		const { status } = await helm("POST", `/helm/worker/${w.id}/stop`, {});
		out.push({ code, workerId: w.id, stopped: status === 200 });
	}
	return out;
}

function fmt(results: DeskResult[]): string {
	const lines = results.map((r) => {
		const tag = r.action === "spawn-failed" ? "FAILED " : r.action === "spawned" ? "SPAWNED" : "ALIVE  ";
		const id = r.workerId ? ` id=${r.workerId}` : "";
		const why = r.detail ? ` (${r.detail})` : "";
		return `  ${tag}  ${r.officer.code.padEnd(4)} ${r.officer.name.padEnd(10)} kind=${r.kind}${id}${why}`;
	});
	return lines.join("\n");
}

// CLI entry point: `bun run packages/table/officer-desks.ts` (spawn/top-up) or
// `bun run packages/table/officer-desks.ts --kill` (stop every live officer desk).
if (import.meta.main) {
	const kill = process.argv.includes("--kill");
	if (kill) {
		const stopped = await stopOfficerDesks();
		if (stopped.length === 0) {
			console.log("No live officer desks to stop.");
		} else {
			console.log(`Stopped ${stopped.length} officer desk(s):`);
			for (const s of stopped) console.log(`  ${s.stopped ? "OK    " : "FAILED"}  ${s.code} id=${s.workerId}`);
		}
	} else {
		const results = await ensureOfficerDesks();
		console.log(fmt(results));
		const failed = results.filter((r) => r.action === "spawn-failed").length;
		if (failed > 0) process.exitCode = 1;
	}
}
