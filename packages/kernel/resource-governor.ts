/**
 * ResourceGovernor - "to infinity within resources without overheating."
 *
 * Composes the EXISTING pieces (UsageMonitor token/request budget, telemetry
 * cost attribution) plus a small thermal/CPU/mem vitals read, and emits one
 * verdict that the hedge executor and the daemon pool gate both consult.
 *
 * Adopted default policy (8TO + 8SO):
 *   - thermal ceiling  = HARD-HALT       (machine is hot, the flywheel parks)
 *   - spend ceiling    = halt-and-ask    (do not silently burn money)
 *   - token cap        = degrade-to-local (drop to free/local, keep working)
 *
 * Everything here is additive and reversible. The governor only ever NARROWS
 * what the agent may do (fewer hedge candidates, prefer local, deny paid cloud,
 * or hard-halt). It never widens beyond what the existing budget already allows.
 * When constructed with defaults and nominal vitals, `verdict()` returns
 * allow=true with full hedge width, so wiring it in is safe by default.
 *
 * Budget POLICY thresholds (spend ceilings, per-turn token caps) are owned by
 * the permissions package (Agent B). This file codes to a small `BudgetPolicy`
 * SEAM and does not import permissions. A caller passes a policy in; absent one,
 * conservative built-in defaults apply.
 */

import { execSync } from "node:child_process";
import { type UsageMonitor, getUsageMonitor } from "../providers/usage-monitor";
import { estimateCostUsd } from "../telemetry/cost";

export type ThermalState = "nominal" | "fair" | "serious" | "critical";

export interface ResourceSnapshot {
	tokens: { dailyPct: number; weeklyPct: number; allowed: boolean; reason?: string };
	spendUsd: { today: number };
	thermal: ThermalState;
	cpuPct: number;
	memPct: number;
	loadAvg: number;
}

export interface GovernorVerdict {
	/** Hard stop if false. New heavy turns are refused. */
	allow: boolean;
	/** True when the only blocker is spend; caller should ask the human. */
	haltAndAsk: boolean;
	/** K candidates the hedge executor may fire (0..maxHedgeWidth). */
	hedgeWidth: number;
	/** Force local-only chain entries. */
	preferLocal: boolean;
	/** Paid cloud tiers (openai/anthropic/etc.) permitted. Free cloud always allowed. */
	allowCloud: boolean;
	/** Free tiers (local + ":free" cloud) permitted. Only false on hard-halt. */
	allowFree: boolean;
	reason: string;
}

/**
 * The seam the permissions package fills. The governor reads thresholds; it
 * does not define policy. Defaults below are conservative fallbacks only.
 */
export interface BudgetPolicy {
	/** Daily USD spend ceiling. At/above -> halt-and-ask. */
	dailySpendCeilingUsd: number;
	/** Token usage fraction (0..1) above which hedging collapses to single-shot. */
	tokenDegradeFraction: number;
	/** Max hedge candidates when fully nominal. */
	maxHedgeWidth: number;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
	dailySpendCeilingUsd: 5,
	tokenDegradeFraction: 0.8,
	maxHedgeWidth: 2,
};

/** Vitals provider seam. Mirrors the pill's dimensions.py discipline:
 * stdlib-only, short-TTL cached, never network. */
export interface Vitals {
	thermal: ThermalState;
	cpuPct: number;
	memPct: number;
	loadAvg: number;
}

const VITALS_TTL_MS = 20_000;

export interface ResourceGovernorOptions {
	policy?: Partial<BudgetPolicy>;
	usage?: UsageMonitor;
	/** Inject a vitals reader (tests). Defaults to a cached macOS/stdlib read. */
	readVitals?: () => Vitals;
	/** Inject today's attributed spend (tests / daemon supplies real value). */
	getSpendTodayUsd?: () => number;
}

export class ResourceGovernor {
	private policy: BudgetPolicy;
	private usage: UsageMonitor;
	private readVitalsFn: () => Vitals;
	private getSpendTodayUsd: () => number;
	private vitalsCache: { at: number; value: Vitals } | null = null;

	constructor(opts: ResourceGovernorOptions = {}) {
		this.policy = { ...DEFAULT_BUDGET_POLICY, ...opts.policy };
		this.usage = opts.usage ?? getUsageMonitor();
		this.readVitalsFn = opts.readVitals ?? defaultReadVitals;
		this.getSpendTodayUsd = opts.getSpendTodayUsd ?? (() => 0);
	}

	/** Read vitals with a 20s TTL cache (mirrors dimensions.py:_TTL). */
	private vitals(): Vitals {
		const now = Date.now();
		if (this.vitalsCache && now - this.vitalsCache.at < VITALS_TTL_MS) {
			return this.vitalsCache.value;
		}
		const value = safeVitals(this.readVitalsFn);
		this.vitalsCache = { at: now, value };
		return value;
	}

	/** Compose the current resource snapshot from existing sources + vitals. */
	snapshot(): ResourceSnapshot {
		const check = this.usage.check();
		const v = this.vitals();
		return {
			tokens: {
				dailyPct: check.dailyPct,
				weeklyPct: check.weeklyPct,
				allowed: check.allowed,
				reason: check.reason,
			},
			spendUsd: { today: this.getSpendTodayUsd() },
			thermal: v.thermal,
			cpuPct: v.cpuPct,
			memPct: v.memPct,
			loadAvg: v.loadAvg,
		};
	}

	/**
	 * The one verdict both call sites read. Pure function of the snapshot +
	 * policy, so it is deterministic and easy to test.
	 */
	verdict(): GovernorVerdict {
		return decide(this.snapshot(), this.policy);
	}

	/**
	 * True only when thermal is nominal. The MadMax sleep/idle gate is ANDed with
	 * this so the overnight LoRA run never cooks the laptop.
	 */
	thermalNominal(): boolean {
		return this.vitals().thermal === "nominal";
	}
}

/**
 * Pure degrade-policy decision. Extracted so it is trivially testable.
 *
 * Order of precedence (most severe first):
 *   1. thermal serious/critical -> HARD-HALT (allow=false, allowFree=false)
 *   2. token budget exhausted (UsageMonitor !allowed) -> HARD-HALT
 *   3. spend ceiling hit -> halt-and-ask (allow=false, haltAndAsk=true, free still ok)
 *   4. thermal fair OR tokens >= degrade fraction -> single-shot, prefer local,
 *      deny paid cloud (degrade-to-local)
 *   5. nominal -> full hedge width, cloud allowed if budget remains
 */
export function decide(snap: ResourceSnapshot, policy: BudgetPolicy): GovernorVerdict {
	// 1. Thermal hard ceiling.
	if (snap.thermal === "serious" || snap.thermal === "critical") {
		return {
			allow: false,
			haltAndAsk: false,
			hedgeWidth: 0,
			preferLocal: true,
			allowCloud: false,
			allowFree: false,
			reason: `thermal ${snap.thermal}: hard-halt to protect the machine`,
		};
	}

	// 2. Token budget exhausted entirely (daily/weekly/request cap from UsageMonitor).
	if (!snap.tokens.allowed) {
		return {
			allow: false,
			haltAndAsk: false,
			hedgeWidth: 0,
			preferLocal: true,
			allowCloud: false,
			allowFree: false,
			reason: snap.tokens.reason ?? "token budget exhausted",
		};
	}

	// 3. Spend ceiling: halt-and-ask. Free tiers remain usable, but no new heavy
	// (paid) turn proceeds without a human yes.
	if (snap.spendUsd.today >= policy.dailySpendCeilingUsd) {
		return {
			allow: false,
			haltAndAsk: true,
			hedgeWidth: 0,
			preferLocal: true,
			allowCloud: false,
			allowFree: true,
			reason: `daily spend ceiling reached ($${snap.spendUsd.today.toFixed(2)} >= $${policy.dailySpendCeilingUsd}); halt-and-ask`,
		};
	}

	// 4. Degrade-to-local: thermal fair, or token usage past the degrade fraction.
	const tokenPressured =
		snap.tokens.dailyPct >= policy.tokenDegradeFraction ||
		snap.tokens.weeklyPct >= policy.tokenDegradeFraction;
	if (snap.thermal === "fair" || tokenPressured) {
		return {
			allow: true,
			haltAndAsk: false,
			hedgeWidth: 1, // hedging off: single shot
			preferLocal: true,
			allowCloud: false, // deny paid cloud; free local/cloud fallback still ok
			allowFree: true,
			reason:
				snap.thermal === "fair"
					? "thermal fair: degrade to local single-shot"
					: "token pressure: degrade to local single-shot",
		};
	}

	// 5. Nominal: full hedge width, cloud allowed if budgeted.
	return {
		allow: true,
		haltAndAsk: false,
		hedgeWidth: Math.max(1, policy.maxHedgeWidth),
		preferLocal: true,
		allowCloud: true,
		allowFree: true,
		reason: "nominal: full hedge width, cloud allowed within budget",
	};
}

/** Cost helper re-exported so the daemon can attribute spend with one import. */
export function turnCostUsd(
	provider: string,
	model: string,
	promptTokens: number,
	completionTokens: number,
): number {
	return estimateCostUsd(provider, model, promptTokens, completionTokens);
}

// ── Vitals read (macOS-first, stdlib-only, fail-safe to nominal) ─────────────

function safeVitals(read: () => Vitals): Vitals {
	try {
		return read();
	} catch {
		// Fail SAFE-OPEN on vitals: if we cannot read thermal, assume nominal so
		// the governor never bricks a healthy machine on a read error. The token
		// and spend ceilings (which fail closed) remain the hard brakes.
		return { thermal: "nominal", cpuPct: 0, memPct: 0, loadAvg: 0 };
	}
}

/**
 * Default vitals read. macOS: `pmset -g therm` thermal pressure + load average +
 * a coarse CPU/mem read. Non-macOS: load average only, thermal nominal. Never
 * touches the network. Short timeouts so a turn is never blocked on vitals.
 */
function defaultReadVitals(): Vitals {
	const loadAvg = readLoadAvg();
	if (process.platform !== "darwin") {
		return { thermal: "nominal", cpuPct: 0, memPct: 0, loadAvg };
	}
	const thermal = readMacThermal();
	const memPct = readMacMemPct();
	return { thermal, cpuPct: 0, memPct, loadAvg };
}

function readLoadAvg(): number {
	try {
		// os.loadavg is stdlib; require lazily to keep this file import-light.
		const os = require("node:os") as typeof import("node:os");
		return os.loadavg()[0] ?? 0;
	} catch {
		return 0;
	}
}

function readMacThermal(): ThermalState {
	try {
		const out = execSync("pmset -g therm", { timeout: 1500, encoding: "utf-8" });
		// CPU_Speed_Limit < 100 means the machine is throttling under thermal load.
		const m = out.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
		if (m) {
			const limit = Number.parseInt(m[1], 10);
			if (limit <= 50) return "critical";
			if (limit <= 75) return "serious";
			if (limit < 100) return "fair";
		}
		return "nominal";
	} catch {
		return "nominal";
	}
}

function readMacMemPct(): number {
	try {
		const os = require("node:os") as typeof import("node:os");
		const total = os.totalmem();
		const free = os.freemem();
		if (total <= 0) return 0;
		return Math.round(((total - free) / total) * 100);
	} catch {
		return 0;
	}
}
