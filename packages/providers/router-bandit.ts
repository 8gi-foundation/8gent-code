/**
 * 8gent Code - Provider Router v2: per-capability-class bandit stats.
 *
 * Today's routing is a static failover chain (local 8gent -> local Qwen ->
 * OpenRouter `:free`). Frontier is LEARNED routing: for a given task class we
 * keep per-arm quality/latency/cost stats and let a bandit pick the arm that
 * has actually earned the work, so there is no hardcoded model choice in the
 * hot path.
 *
 * This module is the substrate for that: it owns the capability classes and the
 * per-class, per-arm statistics, and it exposes a Thompson-sampling `select`
 * plus a `record` that folds one call's outcome back into the stats. Host-aware
 * placement (helm vs forge) and the actual hot-path wiring are later slices;
 * this one is pure, persisted, and testable on its own with no live provider.
 *
 * Persistence mirrors the existing `failover.json` pattern in this package: a
 * single JSON document under `~/.8gent`, loaded/saved through injectable paths
 * so tests never touch a real home directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Capability classes a task can be routed for. Deliberately small and stable -
 * these are the axes the bandit keeps separate stats along, because a model
 * that is strong at `code` is not necessarily strong at `vision` or `judge`.
 */
export type CapabilityClass = "code" | "writing" | "tool-use" | "vision" | "judge";

/** All capability classes, in a stable order (for iteration and reporting). */
export const CAPABILITY_CLASSES: readonly CapabilityClass[] = [
	"code",
	"writing",
	"tool-use",
	"vision",
	"judge",
] as const;

/** True when `value` is one of the known capability classes. */
export function isCapabilityClass(value: unknown): value is CapabilityClass {
	return (
		typeof value === "string" && (CAPABILITY_CLASSES as readonly string[]).includes(value)
	);
}

/** A routable arm: one concrete model on one provider. */
export interface ArmId {
	provider: string;
	model: string;
}

/** Canonical string key for an arm (`provider:model`). */
export function armKey(arm: ArmId): string {
	return `${arm.provider}:${arm.model}`;
}

/**
 * The outcome of one call, folded back into an arm's stats.
 *
 * `quality` is the reward signal in [0, 1] (for example a judge verdict, a test
 * pass-rate, or a win/loss). `latencyMs` and `costUsd` are telemetry that feed
 * the cost/latency picture per class - captured here so the reporting slice has
 * real data and never invents numbers.
 */
export interface Outcome {
	quality: number;
	latencyMs?: number;
	costUsd?: number;
}

/**
 * Per-arm statistics inside one capability class.
 *
 * `alpha`/`beta` are the parameters of a Beta posterior over the arm's quality
 * (Bernoulli-style reward), which is what Thompson sampling draws from. They
 * both start at 1 (a uniform prior), so a brand-new arm is explored, not
 * assumed good or bad. `latencyMsEma`/`costUsdEma` are exponential moving
 * averages of the telemetry; `null` until the first observation carrying it.
 */
export interface ArmStats {
	provider: string;
	model: string;
	pulls: number;
	rewardSum: number;
	alpha: number;
	beta: number;
	latencyMsEma: number | null;
	costUsdEma: number | null;
	lastUsedTs: number | null;
}

/** Persisted document shape. `version` guards future migrations. */
export interface BanditState {
	version: 1;
	classes: Record<CapabilityClass, Record<string, ArmStats>>;
}

/** A win-rate row for reporting (Step 5): observed mean quality per arm. */
export interface WinRateRow {
	provider: string;
	model: string;
	pulls: number;
	/** Observed mean quality in [0, 1] (`rewardSum / pulls`), 0 when never pulled. */
	meanQuality: number;
	latencyMsEma: number | null;
	costUsdEma: number | null;
}

/** Weight of the newest sample in the telemetry EMAs. */
const EMA_ALPHA = 0.2;

/** Default on-disk location, alongside the existing `failover.json`. */
export function defaultBanditStorePath(): string {
	return join(homedir(), ".8gent", "router-bandit.json");
}

function emptyClasses(): Record<CapabilityClass, Record<string, ArmStats>> {
	const out = {} as Record<CapabilityClass, Record<string, ArmStats>>;
	for (const cls of CAPABILITY_CLASSES) out[cls] = {};
	return out;
}

/** Clamp a reward into the valid [0, 1] band; non-finite -> 0. */
function clampQuality(q: number): number {
	if (!Number.isFinite(q)) return 0;
	if (q < 0) return 0;
	if (q > 1) return 1;
	return q;
}

/** Fold one sample into an EMA (or seed it when there is no history yet). */
function ema(prev: number | null, sample: number): number {
	if (prev == null || !Number.isFinite(prev)) return sample;
	return prev + EMA_ALPHA * (sample - prev);
}

/**
 * A small, self-contained PRNG (mulberry32) so tests can make Thompson sampling
 * deterministic without pulling in a dependency. Returns a `() => number` in
 * [0, 1). Exported for tests; production uses `Math.random` by default.
 */
export function seededRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Standard normal sample via Box-Muller, driven by the injected RNG. */
function sampleNormal(rng: () => number): number {
	let u = 0;
	let v = 0;
	// Avoid log(0).
	while (u === 0) u = rng();
	while (v === 0) v = rng();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Gamma(shape, 1) sample via Marsaglia-Tsang. Only shape >= 1 arises here
 * (alpha/beta start at 1 and only grow), but sub-1 shapes are handled with the
 * standard boosting trick for safety.
 */
function sampleGamma(shape: number, rng: () => number): number {
	if (shape < 1) {
		const u = Math.max(rng(), Number.EPSILON);
		return sampleGamma(shape + 1, rng) * u ** (1 / shape);
	}
	const d = shape - 1 / 3;
	const c = 1 / Math.sqrt(9 * d);
	for (;;) {
		let x = 0;
		let v = 0;
		do {
			x = sampleNormal(rng);
			v = (1 + c * x) ** 3;
		} while (v <= 0);
		const u = rng();
		if (u < 1 - 0.0331 * x ** 4) return d * v;
		if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
	}
}

/** Draw a Beta(alpha, beta) sample from two Gammas. */
function sampleBeta(alpha: number, beta: number, rng: () => number): number {
	const x = sampleGamma(alpha, rng);
	const y = sampleGamma(beta, rng);
	const denom = x + y;
	return denom === 0 ? 0.5 : x / denom;
}

/**
 * Per-capability-class bandit over provider/model arms.
 *
 * The bandit never invents an arm: `select` only ever returns something you
 * have registered (or passed in as a candidate), so the caller stays the single
 * source of truth for which models actually exist on this host. That keeps the
 * "no hardcoded model choice" property honest - the set of choices comes from
 * the live provider registry, and only the RANKING is learned here.
 */
export class RouterBandit {
	private state: BanditState;
	private rng: () => number;

	constructor(opts: { state?: BanditState; rng?: () => number } = {}) {
		this.state = opts.state ?? { version: 1, classes: emptyClasses() };
		// Back-fill any classes missing from a loaded document (forward-compat).
		for (const cls of CAPABILITY_CLASSES) {
			if (!this.state.classes[cls]) this.state.classes[cls] = {};
		}
		this.rng = opts.rng ?? Math.random;
	}

	/**
	 * Load a bandit from disk, or start empty when there is no file yet. A
	 * corrupt or unreadable file also starts empty rather than throwing, so a
	 * bad stats file never bricks routing (it just relearns).
	 */
	static load(path: string = defaultBanditStorePath(), rng?: () => number): RouterBandit {
		if (!existsSync(path)) return new RouterBandit({ rng });
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8")) as BanditState;
			if (!raw || typeof raw !== "object" || !raw.classes) return new RouterBandit({ rng });
			return new RouterBandit({ state: raw, rng });
		} catch {
			return new RouterBandit({ rng });
		}
	}

	/** Persist the current stats to disk (creating the directory if needed). */
	save(path: string = defaultBanditStorePath()): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(this.state, null, 2)}\n`, "utf-8");
	}

	/** The raw persisted document (defensive copy). */
	snapshot(): BanditState {
		return JSON.parse(JSON.stringify(this.state)) as BanditState;
	}

	/**
	 * Ensure an arm exists in a class, returning its stats. New arms get a
	 * uniform Beta(1, 1) prior so they are explored before being trusted.
	 */
	ensureArm(cls: CapabilityClass, arm: ArmId): ArmStats {
		const bucket = this.state.classes[cls];
		const key = armKey(arm);
		let stats = bucket[key];
		if (!stats) {
			stats = {
				provider: arm.provider,
				model: arm.model,
				pulls: 0,
				rewardSum: 0,
				alpha: 1,
				beta: 1,
				latencyMsEma: null,
				costUsdEma: null,
				lastUsedTs: null,
			};
			bucket[key] = stats;
		}
		return stats;
	}

	/** All arms currently known for a class. */
	arms(cls: CapabilityClass): ArmStats[] {
		return Object.values(this.state.classes[cls]);
	}

	/**
	 * Pick an arm for a task class via Thompson sampling: draw one quality
	 * sample from each candidate arm's Beta posterior and take the argmax. Ties
	 * and unexplored arms resolve naturally because a fresh Beta(1, 1) has a
	 * wide spread, so exploration happens without a separate epsilon knob.
	 *
	 * `candidates` scopes the choice to models the caller knows are reachable on
	 * this host right now; each is registered on the way through. When omitted,
	 * every previously-seen arm for the class is a candidate. Returns `null`
	 * only when there is genuinely nothing to choose from.
	 */
	select(cls: CapabilityClass, candidates?: ArmId[]): ArmId | null {
		let pool: ArmStats[];
		if (candidates && candidates.length > 0) {
			pool = candidates.map((c) => this.ensureArm(cls, c));
		} else {
			pool = this.arms(cls);
		}
		if (pool.length === 0) return null;

		let best: ArmStats | null = null;
		let bestDraw = Number.NEGATIVE_INFINITY;
		for (const arm of pool) {
			const draw = sampleBeta(arm.alpha, arm.beta, this.rng);
			if (draw > bestDraw) {
				bestDraw = draw;
				best = arm;
			}
		}
		return best ? { provider: best.provider, model: best.model } : null;
	}

	/**
	 * Deterministic greedy pick: the arm with the highest observed mean quality,
	 * unexplored arms last. Useful for reporting and for a "no more exploration"
	 * mode; `select` is the learning path.
	 */
	best(cls: CapabilityClass, candidates?: ArmId[]): ArmId | null {
		const pool = candidates && candidates.length > 0
			? candidates.map((c) => this.ensureArm(cls, c))
			: this.arms(cls);
		if (pool.length === 0) return null;
		let best: ArmStats | null = null;
		let bestScore = Number.NEGATIVE_INFINITY;
		for (const arm of pool) {
			const mean = arm.pulls > 0 ? arm.rewardSum / arm.pulls : 0;
			if (mean > bestScore) {
				bestScore = mean;
				best = arm;
			}
		}
		return best ? { provider: best.provider, model: best.model } : null;
	}

	/**
	 * Fold one call's outcome into the arm's stats: the Beta posterior is
	 * updated with the (fractional) reward, and the latency/cost EMAs absorb any
	 * telemetry that was measured. Rewards are clamped into [0, 1] so a bad
	 * signal can never push the posterior out of range.
	 */
	record(cls: CapabilityClass, arm: ArmId, outcome: Outcome, now: number = Date.now()): void {
		const stats = this.ensureArm(cls, arm);
		const q = clampQuality(outcome.quality);
		stats.pulls += 1;
		stats.rewardSum += q;
		// Fractional Bernoulli update: reward q credits alpha, (1 - q) credits beta.
		stats.alpha += q;
		stats.beta += 1 - q;
		if (outcome.latencyMs != null && Number.isFinite(outcome.latencyMs)) {
			stats.latencyMsEma = ema(stats.latencyMsEma, outcome.latencyMs);
		}
		if (outcome.costUsd != null && Number.isFinite(outcome.costUsd)) {
			stats.costUsdEma = ema(stats.costUsdEma, outcome.costUsd);
		}
		stats.lastUsedTs = now;
	}

	/**
	 * Win-rate rows for a class, highest observed mean quality first. This is the
	 * data behind Step 5 ("publish routing win-rates in-repo") - every number
	 * traces back to a real recorded outcome, never a seeded value.
	 */
	winRates(cls: CapabilityClass): WinRateRow[] {
		return this.arms(cls)
			.map((arm) => ({
				provider: arm.provider,
				model: arm.model,
				pulls: arm.pulls,
				meanQuality: arm.pulls > 0 ? arm.rewardSum / arm.pulls : 0,
				latencyMsEma: arm.latencyMsEma,
				costUsdEma: arm.costUsdEma,
			}))
			.sort((a, b) => b.meanQuality - a.meanQuality || b.pulls - a.pulls);
	}
}
