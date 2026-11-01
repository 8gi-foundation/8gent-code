/**
 * The counting proof.
 *
 * "Almost infinite" is a claim, and a claim needs a number. This file produces
 * it, and it produces it by EXECUTING the axes rather than by quoting a figure
 * someone typed into a README. Run it:
 *
 *   bun run packages/design-compose/space.ts
 *
 * Two numbers come out, and the difference between them is the honest part.
 *
 *   ADDRESSABLE  the product of the axis cardinalities. Every point you can
 *                name. This is the headline number and it is trivially true.
 *
 *   ADMISSIBLE   the subset that survives the constraint gate. This is the
 *                number that actually matters, and it is ESTIMATED by sampling
 *                the lattice, not asserted. The sample is deterministic (a
 *                fixed low-discrepancy stride, no RNG), so the figure is
 *                reproducible, and the interval is reported alongside it.
 *
 * A design space of three billion is only interesting if a large fraction of it
 * is usable. If the admissible fraction came back at 2 percent this file would
 * say so.
 */

import { axisCardinalities, coordinateAt, HUE_STEP, latticeSize, LEGAL_HUES, WARM_HUES } from "./axes";
import { composeAt } from "./compose";
import { DesignRefused } from "./types";

export interface SpaceReport {
	cardinalities: Record<string, number>;
	addressable: number;
	sampled: number;
	warmOnly: boolean;
	admitted: number;
	refusedByRule: Record<string, number>;
	/** Point estimate of the admissible fraction. */
	admissibleFraction: number;
	/** Wald 95 percent interval on that fraction. */
	interval: [number, number];
	/** Which colour role triggered each brand.hue refusal. */
	refusedRoles: Record<string, number>;
	/** admissibleFraction * addressable, rounded. */
	admissibleEstimate: number;
}

/**
 * Deterministic stride sampling. A prime stride coprime to the lattice size
 * walks the whole space without repeating, and without an RNG, so two runs on
 * two machines produce the identical sample. That property is worth more here
 * than statistical elegance: a proof you cannot reproduce is not a proof.
 */
const STRIDE = 2_147_483_647; // 2^31 - 1, prime, coprime to the lattice size

/**
 * Survey one PROFILE of the space.
 *
 * The distinction matters and getting it wrong would have inflated the number.
 * The hue axis carries 57 brand-legal hues, but the default profile is warm,
 * which admits only 21 of them. Sampling the full 57-hue lattice while leaving
 * the warm rule switched on measures a space the composer would never search,
 * and reports a refusal rate that is an artefact of the mismatch rather than a
 * fact about the substrate. So the addressable count is scaled to the profile
 * being surveyed, and both profiles are reported.
 */
export function surveySpace(sampleSize = 4000, warmOnly = true): SpaceReport {
	const cardinalities = { ...axisCardinalities() };
	if (warmOnly) cardinalities.accentHue = WARM_HUES.length;
	const fullLattice = latticeSize();
	const addressable = warmOnly
		? Math.round((fullLattice * WARM_HUES.length) / LEGAL_HUES.length)
		: fullLattice;
	const refusedByRule: Record<string, number> = {};
	const refusedRoles: Record<string, number> = {};
	let admitted = 0;
	let skipped = 0;

	for (let i = 0; i < sampleSize; i += 1) {
		const index = Number((BigInt(i) * BigInt(STRIDE)) % BigInt(fullLattice));
		const coord = coordinateAt(index);
		// Under the warm profile, hues outside the warm band are not addressable
		// at all, so a lattice point carrying one is not a refusal - it is not a
		// point in this profile's space. Skipping it keeps the denominator honest.
		if (warmOnly && !WARM_HUES.includes(coord.accentHue)) {
			skipped += 1;
			continue;
		}
		try {
			composeAt(coord, { product: "survey", seed: i, warmOnly });
			admitted += 1;
		} catch (err) {
			const rule = err instanceof DesignRefused ? err.rule : "error";
			refusedByRule[rule] = (refusedByRule[rule] ?? 0) + 1;
			if (rule === "brand.hue" && err instanceof DesignRefused) {
				const role = err.detail.match(/role "([a-z0-9-]+)"/)?.[1] ?? "unknown";
				refusedRoles[role] = (refusedRoles[role] ?? 0) + 1;
			}
		}
	}

	const considered = sampleSize - skipped;
	const p = considered > 0 ? admitted / considered : 0;
	const se = Math.sqrt((p * (1 - p)) / Math.max(1, considered));
	const lo = Math.max(0, p - 1.96 * se);
	const hi = Math.min(1, p + 1.96 * se);

	return {
		cardinalities,
		addressable,
		sampled: considered,
		warmOnly,
		admitted,
		refusedByRule,
		refusedRoles,
		admissibleFraction: p,
		interval: [lo, hi],
		admissibleEstimate: Math.round(p * addressable),
	};
}

export function formatReport(r: SpaceReport): string {
	const lines: string[] = [];
	const n = (x: number) => x.toLocaleString("en-GB");

	lines.push("ADDRESSABLE DESIGN SPACE");
	lines.push("");
	const entries = Object.entries(r.cardinalities);
	const width = Math.max(...entries.map(([k]) => k.length));
	for (const [k, v] of entries) lines.push(`  ${k.padEnd(width)}  ${String(v).padStart(3)}`);
	lines.push("");
	lines.push(`  ${entries.map(([, v]) => v).join(" x ")}`);
	lines.push(`  = ${n(r.addressable)}`);
	lines.push("");
	lines.push(`  Accent hue is the largest axis: ${HUE_STEP}-degree spacing over the wheel gives`);
	lines.push(`  ${360 / HUE_STEP} candidates, of which ${LEGAL_HUES.length} survive rendering and testing against the`);
	lines.push(`  banned band. The warm profile narrows that to ${WARM_HUES.length}, which is the default.`);
	lines.push("");
	lines.push(`ADMISSIBLE SUBSET, ${r.warmOnly ? "WARM PROFILE (the default)" : "FULL BRAND-LEGAL RANGE (warmOnly: false)"}`);
	lines.push("(sampled, deterministic stride, no RNG)");
	lines.push("");
	lines.push(`  sampled     ${n(r.sampled)} lattice points`);
	lines.push(`  admitted    ${n(r.admitted)}`);
	lines.push(`  fraction    ${(r.admissibleFraction * 100).toFixed(1)}%  (95% CI ${(r.interval[0] * 100).toFixed(1)}% to ${(r.interval[1] * 100).toFixed(1)}%)`);
	lines.push(`  estimate    ~${n(r.admissibleEstimate)} designs that pass every hard constraint`);
	lines.push("");
	if (Object.keys(r.refusedByRule).length) {
		lines.push("  refused by rule:");
		for (const [rule, count] of Object.entries(r.refusedByRule).sort((a, b) => b[1] - a[1])) {
			lines.push(`    ${rule.padEnd(20)} ${String(count).padStart(5)}  ${((count / r.sampled) * 100).toFixed(1)}%`);
		}
	} else {
		lines.push("  no refusals in the sample");
	}
	if (Object.keys(r.refusedRoles).length) {
		lines.push("");
		lines.push("  brand.hue refusals by the role that triggered them:");
		for (const [role, count] of Object.entries(r.refusedRoles).sort((a, b) => b[1] - a[1])) {
			lines.push(`    ${role.padEnd(20)} ${String(count).padStart(5)}`);
		}
		lines.push("");
		lines.push("  Note which role is ABSENT: \"accent\" never appears, because the hue axis");
		lines.push("  itself is built by rendering each candidate and discarding the ones that");
		lines.push("  land in the banned band - a violet accent has no coordinate to reach.");
		lines.push("  What the gate catches is the DERIVED secondary, when a complementary or");
		lines.push("  split structure rotates a legal accent into an illegal partner. Both");
		lines.push("  layers are load-bearing; neither one alone would hold.");
	}
	lines.push("");
	lines.push("FOR COMPARISON");
	lines.push("");
	lines.push("  packages/design-systems stores 54 themes and retrieves them.");
	lines.push(`  This package stores 0 and computes ~${n(r.admissibleEstimate)}.`);
	lines.push("  That is the entire architectural difference.");

	return lines.join("\n");
}

if (import.meta.main) {
	const size = Number(process.argv[2] ?? 4000);
	console.log(formatReport(surveySpace(size, true)));
	console.log(`\n${"-".repeat(74)}\n`);
	console.log(formatReport(surveySpace(size, false)));
}
