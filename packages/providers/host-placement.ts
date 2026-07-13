/**
 * 8gent Code - Provider Router v2: host-aware placement (Step 2).
 *
 * Wave 1 landed the per-capability-class bandit (`router-bandit.ts`) that learns
 * WHICH model earns a task. This slice answers the next question: once a model
 * arm is chosen, WHERE does it run. The two-Mac fabric is helm (M5, the new
 * primary, latency-optimised) and forge (M2 96GB, the heavy box), reachable over
 * the tailnet. Latency-critical classes belong on the low-latency host; heavy
 * models belong on the box with the memory to hold them.
 *
 * Design rules kept honest here:
 *   - No hardcoded host inventory in the hot path. The caller passes in the live
 *     set of reachable hosts (discovered at runtime from the tailnet), exactly
 *     as the bandit takes its candidate arms from the live provider registry.
 *     This module is a pure decision function - it never invents a machine.
 *   - Fail closed to the cloud floor. When no reachable local host can actually
 *     fit the model, placement returns `null` so the caller spills to the
 *     `auto:free` cloud floor rather than pretending a box can serve it. That
 *     keeps "local always preferred, cloud is the floor" true without ever
 *     over-committing a machine.
 *   - Deterministic. Ties break on a stable host-id order so placement is
 *     reproducible and testable with no live network.
 */

import type { ArmId, CapabilityClass } from "./router-bandit";
import { CAPABILITY_CLASSES } from "./router-bandit";

/** A machine on the tailnet that can run local models. */
export interface Host {
	/** Stable identifier, e.g. `helm` or `forge`. */
	id: string;
	/**
	 * Usable memory for model weights, in GB. On Apple Silicon this is the
	 * unified-memory budget the caller is willing to hand to a model (not the
	 * full RAM). Supplied from real host telemetry, never assumed here.
	 */
	memoryGb: number;
	/** Typical tailnet round-trip latency from the caller to this host, in ms. */
	latencyMs: number;
	/** Whether the host is up on the tailnet right now. */
	reachable: boolean;
}

/**
 * Placement policy. Every field has a documented default in
 * `DEFAULT_PLACEMENT_CONFIG`; callers may override per task or per host fleet.
 * Nothing here is baked into the decision function - it is all injected.
 */
export interface PlacementConfig {
	/**
	 * Which capability classes are latency-critical (prefer the low-latency host
	 * over the roomy one). Interactive, short-turn work - inline tool-use and the
	 * judge that gates a turn - wants helm; heavy generation wants forge.
	 */
	latencyCritical: Record<CapabilityClass, boolean>;
	/**
	 * GB of model memory per billion parameters, keyed by quantisation tag. Used
	 * only when the caller does not supply an explicit footprint. These are
	 * deliberate over-estimates of the weight footprint (activations/KV-cache push
	 * real usage higher), so placement errs toward the box that comfortably fits.
	 */
	gbPerBillionByQuant: Record<string, number>;
	/** GB-per-billion used when the quant tag is unknown. */
	gbPerBillionDefault: number;
	/** Footprint assumed when a model name carries no parameter count, in GB. */
	unknownModelGb: number;
	/** Memory kept free above the model footprint before a host is said to fit. */
	headroomGb: number;
}

function latencyCriticalDefaults(): Record<CapabilityClass, boolean> {
	const out = {} as Record<CapabilityClass, boolean>;
	for (const cls of CAPABILITY_CLASSES) out[cls] = false;
	// Inline, per-turn work wants the fast box; heavy generation wants the roomy one.
	out["tool-use"] = true;
	out.judge = true;
	return out;
}

/** Sensible defaults for the helm/forge fabric; override per fleet as needed. */
export const DEFAULT_PLACEMENT_CONFIG: PlacementConfig = {
	latencyCritical: latencyCriticalDefaults(),
	// Rough weight footprint per billion params by quant, biased slightly high.
	gbPerBillionByQuant: {
		q2: 0.4,
		q3: 0.5,
		q4: 0.6,
		q5: 0.7,
		q6: 0.8,
		q8: 1.1,
		fp16: 2.1,
		f16: 2.1,
		bf16: 2.1,
	},
	gbPerBillionDefault: 0.7,
	unknownModelGb: 4,
	headroomGb: 2,
};

/** True when a class prefers the low-latency host under this config. */
export function isLatencyCritical(
	cls: CapabilityClass,
	config: PlacementConfig = DEFAULT_PLACEMENT_CONFIG,
): boolean {
	return config.latencyCritical[cls] === true;
}

/**
 * Estimate a model's weight footprint in GB from its name. Parses the parameter
 * count (`14b`, `27b`, `1.5b`, `70b`) and, when present, a quant tag (`q3`,
 * `q4`, `q8`, `fp16`) to pick a GB-per-billion factor. A name with no parameter
 * count falls back to `unknownModelGb` - a conservative small footprint that can
 * land on either host rather than being wrongly excluded.
 *
 * This is an estimate, not a measurement: it exists so placement has a real
 * signal to reason about when the caller has no exact footprint. Callers that DO
 * know the true VRAM cost should pass it as `requiredGb` and skip this entirely.
 */
export function estimateModelMemoryGb(
	model: string,
	config: PlacementConfig = DEFAULT_PLACEMENT_CONFIG,
): number {
	const name = model.toLowerCase();
	// Parameter count: a number immediately followed by `b`, e.g. `14b`, `1.5b`.
	const paramMatch = name.match(/(\d+(?:\.\d+)?)\s*b(?![a-z])/);
	if (!paramMatch) return config.unknownModelGb;
	const billions = Number.parseFloat(paramMatch[1] ?? "");
	if (!Number.isFinite(billions) || billions <= 0) return config.unknownModelGb;

	// Quant tag: `q` followed by digits, or a float width tag.
	let gbPerB = config.gbPerBillionDefault;
	const quantMatch = name.match(/q\d+/);
	if (quantMatch && config.gbPerBillionByQuant[quantMatch[0]] != null) {
		gbPerB = config.gbPerBillionByQuant[quantMatch[0]] as number;
	} else if (/(?:^|[^a-z])(fp16|bf16|f16)(?![a-z])/.test(name)) {
		const tag = name.match(/(fp16|bf16|f16)/)?.[0] ?? "";
		if (config.gbPerBillionByQuant[tag] != null) {
			gbPerB = config.gbPerBillionByQuant[tag] as number;
		}
	}
	return billions * gbPerB;
}

/** Where the router decided to run an arm, and why. */
export interface PlacementDecision {
	host: Host;
	/** The footprint (GB) placement reasoned about, incl. no headroom. */
	requiredGb: number;
	/** Whether this class was treated as latency-critical. */
	latencyCritical: boolean;
	/** Human-readable rationale, for logs and the brain-vitals surface. */
	reason: string;
}

/** Options for a single placement decision. */
export interface PlacementOptions {
	/**
	 * Exact model footprint in GB, from a real registry/telemetry. When given, the
	 * name-based estimate is skipped entirely - the honest path when the number is
	 * actually known.
	 */
	requiredGb?: number;
	config?: PlacementConfig;
}

/**
 * Decide which reachable host should run `arm` for capability class `cls`.
 *
 * Algorithm:
 *   1. Keep only reachable hosts. None -> `null` (spill to cloud floor).
 *   2. Compute the footprint (explicit `requiredGb`, else the name estimate) and
 *      require `memoryGb >= footprint + headroom`. No host fits -> `null`.
 *   3. Latency-critical class: pick the lowest-latency host that fits, breaking
 *      ties toward the leaner box then the stable host id. Otherwise (heavy):
 *      pick the roomiest host, breaking ties toward the faster box then id.
 *
 * Returning `null` is a first-class outcome, not an error: it is the signal that
 * local placement declined and the caller should use the cloud floor.
 */
export function placeArm(
	cls: CapabilityClass,
	arm: ArmId,
	hosts: Host[],
	options: PlacementOptions = {},
): PlacementDecision | null {
	const config = options.config ?? DEFAULT_PLACEMENT_CONFIG;
	const reachable = hosts.filter((h) => h.reachable);
	if (reachable.length === 0) return null;

	const requiredGb =
		options.requiredGb != null && Number.isFinite(options.requiredGb) && options.requiredGb >= 0
			? options.requiredGb
			: estimateModelMemoryGb(arm.model, config);
	const needed = requiredGb + config.headroomGb;

	const fits = reachable.filter((h) => h.memoryGb >= needed);
	if (fits.length === 0) return null;

	const critical = isLatencyCritical(cls, config);
	const sorted = [...fits].sort((a, b) => {
		if (critical) {
			// Fast first, then leaner, then stable id.
			return a.latencyMs - b.latencyMs || a.memoryGb - b.memoryGb || cmpId(a.id, b.id);
		}
		// Roomiest first, then faster, then stable id.
		return b.memoryGb - a.memoryGb || a.latencyMs - b.latencyMs || cmpId(a.id, b.id);
	});

	const host = sorted[0] as Host;
	const reason = critical
		? `latency-critical ${cls}: lowest-latency reachable host that fits ${requiredGb.toFixed(1)}GB`
		: `heavy ${cls}: roomiest reachable host for ${requiredGb.toFixed(1)}GB`;
	return { host, requiredGb, latencyCritical: critical, reason };
}

function cmpId(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
