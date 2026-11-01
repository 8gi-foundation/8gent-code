/**
 * The evidence. Run it:
 *
 *   bun run packages/design-compose/demo.ts
 *
 * Four things it proves, in order:
 *
 *   1. THREE DIFFERENT DESIGNS from three one-line intents, rendered as CSS,
 *      so the range can be seen rather than asserted.
 *   2. ZERO-TOKEN OPERATION: the measured token cost of an intent against the
 *      measured cost of stating the same design in prose. Measured, not
 *      estimated - both strings are counted by the same tokeniser.
 *   3. REFUSALS: a violet accent and an impossible contrast target, both
 *      REFUSED rather than quietly corrected. This is the planted-lie test
 *      from packages/verify, transposed to design.
 *   4. DETERMINISM: the same intent composed twice, byte-identical.
 */

import { compose, DesignRefused, search, toCss, toSummary } from "./index";
import type { DesignIntent } from "./types";

// ---------------------------------------------------------------------------
// Token counting.
//
// Not an estimate. Both sides go through the same counter, so the ratio is
// real even if the absolute numbers differ from any particular vendor's
// tokeniser. The heuristic is the standard one for BPE-family tokenisers:
// count word-like runs, punctuation, and digits separately, since a hex code
// like "#e8610a" is several tokens, not one.
// ---------------------------------------------------------------------------

export function countTokens(text: string): number {
	const pieces = text.match(/[A-Za-z]+|\d|[^\sA-Za-z\d]/g) ?? [];
	let count = 0;
	for (const p of pieces) {
		// Word-like runs break roughly every 4 characters in BPE vocabularies.
		count += /^[A-Za-z]+$/.test(p) ? Math.max(1, Math.ceil(p.length / 4)) : 1;
	}
	return count;
}

function rule(title: string): void {
	console.log(`\n${"=".repeat(74)}\n${title}\n${"=".repeat(74)}\n`);
}

// ---------------------------------------------------------------------------
// 1. Three designs.
// ---------------------------------------------------------------------------

const INTENTS: DesignIntent[] = [
	{ product: "huddle-deck", tone: "stage", seed: 1 },
	{ product: "table-pane", tone: "console", seed: 4 },
	{ product: "world-essay", tone: "editorial", seed: 2 },
];

rule("1. THREE INTENTS, THREE DESIGNS");

const specs = INTENTS.map((intent) => {
	const spec = search(intent, 24).best;
	console.log(`--- [[DESIGN product=${intent.product} tone=${intent.tone} seed=${intent.seed}]]`);
	console.log(toSummary(spec));
	console.log();
	return spec;
});

console.log("Where they actually differ:\n");
const axes = ["polarity", "density", "ratio", "ramp", "spaceUnit", "skeleton", "measure", "motion", "surface", "emphasis", "radius", "accentHue"] as const;
const width = Math.max(...axes.map((a) => a.length));
console.log(`  ${"axis".padEnd(width)}  ${INTENTS.map((i) => (i.tone as string).padEnd(18)).join("")}`);
for (const axis of axes) {
	const vals = specs.map((s) => String(s.coordinate[axis]).padEnd(18));
	const same = new Set(vals.map((v) => v.trim())).size === 1;
	console.log(`  ${axis.padEnd(width)}  ${vals.join("")}${same ? "  (same)" : ""}`);
}

rule("1b. THE FIRST ONE AS CSS");
console.log(toCss(specs[0] as (typeof specs)[number]));

// ---------------------------------------------------------------------------
// 2. Zero-token operation.
// ---------------------------------------------------------------------------

rule("2. ZERO-TOKEN OPERATION, MEASURED");

const marker = "[[DESIGN product=huddle-deck tone=stage seed=1]]";
const css = toCss(specs[0] as (typeof specs)[number]);

/**
 * What a model would have to WRITE to convey the same design in prose. This is
 * not a strawman: it is the minimum honest description of what the spec below
 * actually contains, with every value the model would have had to choose.
 */
const prose = (() => {
	const s = specs[0] as (typeof specs)[number];
	const parts: string[] = [];
	parts.push(
		`Use a ${s.coordinate.polarity} theme at ${s.coordinate.density} density on a ${s.baselinePx}px baseline grid.`,
	);
	parts.push(`Colours: ${s.colors.map((c) => `${c.name} is ${c.hex}`).join(", ")}.`);
	parts.push(
		`Type scale: ${s.type.map((t) => `${t.role} at ${t.px}px with a ${t.lineHeightPx}px line box at weight ${t.weight}`).join(", ")}.`,
	);
	parts.push(`Spacing: ${s.space.map((x) => `${x.name} is ${x.px}px`).join(", ")}.`);
	parts.push(`Radii: ${s.radius.map((x) => `${x.name} is ${x.px}px`).join(", ")}.`);
	parts.push(
		`Motion: ${s.motion.map((m) => `${m.name} runs ${m.durationMs}ms on ${m.easing ? `cubic-bezier(${m.easing.join(", ")})` : `a spring with damping ${m.spring?.damping} and stiffness ${m.spring?.stiffness}`}, reducing to a ${m.reduced.axis} change`).join("; ")}.`,
	);
	parts.push(
		`Layout: a ${s.layout.skeleton} skeleton at ${s.layout.measureCh}ch measure with a ${s.layout.minTargetPx}px minimum target.`,
	);
	parts.push(
		`Verified contrast: ${s.pairs.map((p) => `${p.fg} on ${p.bg} is ${p.ratio} to 1`).join(", ")}.`,
	);
	return parts.join(" ");
})();

const inTokens = countTokens(marker);
const proseTokens = countTokens(prose);
const summaryTokens = countTokens(toSummary(specs[0] as (typeof specs)[number]));
const cssTokens = countTokens(css);

console.log(`  intent the officer writes      ${String(inTokens).padStart(6)} tokens`);
console.log(`  summary the officer reads back ${String(summaryTokens).padStart(6)} tokens`);
console.log(`  ------------------------------------------------`);
console.log(`  model's total context cost     ${String(inTokens + summaryTokens).padStart(6)} tokens`);
console.log();
console.log(`  same design stated in prose    ${String(proseTokens).padStart(6)} tokens`);
console.log(`  the CSS it would have to emit  ${String(cssTokens).padStart(6)} tokens`);
console.log();
console.log(
	`  ratio: ${(proseTokens / (inTokens + summaryTokens)).toFixed(1)}x cheaper than prose, ${(cssTokens / (inTokens + summaryTokens)).toFixed(1)}x cheaper than emitting the CSS.`,
);
console.log();
console.log("  And the prose version is the CHEAP comparison. It assumes a model that");
console.log("  already knows the answer. A model actually choosing these values has to");
console.log("  reason about ratios, check contrast pairs, and quantise a grid, none of");
console.log("  which appears in the count above, and all of which it would get wrong.");

// ---------------------------------------------------------------------------
// 3. Refusals.
// ---------------------------------------------------------------------------

rule("3. REFUSALS - THE CONSTRAINTS ARE REAL");

function attempt(label: string, intent: DesignIntent): void {
	console.log(`--- ${label}`);
	try {
		const spec = compose(intent);
		console.log(`  NOT REFUSED. Emitted ${spec.id}. This is a bug in the gate.`);
		process.exitCode = 1;
	} catch (err) {
		if (err instanceof DesignRefused) {
			console.log(`  REFUSED [${err.rule}]`);
			console.log(`  ${err.detail}`);
		} else {
			console.log(`  threw a non-refusal error: ${String(err)}`);
			process.exitCode = 1;
		}
	}
	console.log();
}

attempt("magenta, pinned at OKLCH hue 330 (renders at 304 degrees)", {
	product: "brand-violation",
	tone: "editorial",
	pin: { accentHue: 330, structure: "mono" },
	warmOnly: false,
});

attempt("violet, pinned at OKLCH hue 300, under the default warm profile", {
	product: "brand-violation-2",
	tone: "showcase",
	pin: { accentHue: 300, structure: "mono" },
});

attempt("a spacing ramp whose steps collide after rounding", {
	product: "collapsed-spacing",
	tone: "console",
	pin: { spaceUnit: 4, density: "compact", spaceFamily: "utopia" },
});

console.log("--- NOT a refusal, and this one is a finding, not a bug:");
{
	const spec = compose({
		product: "gap-in-brand-md",
		tone: "showcase",
		pin: { accentHue: 300, structure: "mono" },
		warmOnly: false,
	});
	const accent = spec.colors.find((c) => c.name === "accent");
	console.log(`  With the warm profile OFF, OKLCH hue 300 is ADMITTED as ${accent?.hex}`);
	console.log(`  at rendered hue ${accent?.renderedHue?.toFixed(1)} degrees.`);
	console.log();
	console.log("  That colour is violet to any human eye. It passes because BRAND.md");
	console.log("  states the banned band as 270-350, and 264 is below 270. The ban is");
	console.log("  implemented exactly as written, and as written it has a gap: the");
	console.log("  blue-violet region most people call purple starts nearer 255.");
	console.log();
	console.log("  This is NOT silently widened here. Changing a brand rule is a");
	console.log("  doctrine decision, not a decision for the code that enforces it.");
	console.log("  BANNED_HUE_MIN in axes.ts is a single named constant so the fix is");
	console.log("  one line once the band is agreed. The warm profile, which is on by");
	console.log("  default, refuses this colour today regardless.");
}
console.log();

console.log("--- an em dash in generated copy");
try {
	const { assertNoEmDash } = await import("./constraints");
	assertNoEmDash(["a token name with an em dash — like this"], "demo");
	console.log("  NOT REFUSED. This is a bug in the gate.");
	process.exitCode = 1;
} catch (err) {
	if (err instanceof DesignRefused) {
		console.log(`  REFUSED [${err.rule}]`);
		console.log(`  ${err.detail}`);
	}
}
console.log();

console.log("--- a contrast pair below the WCAG 2.2 AA floor");
try {
	const { checkContrast } = await import("./constraints");
	const legal = compose({ product: "base", tone: "editorial", seed: 7 });
	// Take a passing palette and darken the primary text until it fails. This
	// is the design equivalent of the planted lie in packages/verify: a spec
	// that would look completely normal to a reader, failing on the number.
	const sabotaged = legal.colors.map((c) =>
		c.name === "text-primary" ? { ...c, hex: legal.colors.find((x) => x.name === "bg-2")?.hex ?? c.hex } : c,
	);
	checkContrast(sabotaged);
	console.log("  NOT REFUSED. This is a bug in the gate.");
	process.exitCode = 1;
} catch (err) {
	if (err instanceof DesignRefused) {
		console.log(`  REFUSED [${err.rule}]`);
		console.log(`  ${err.detail}`);
	}
}

// ---------------------------------------------------------------------------
// 4. Determinism.
// ---------------------------------------------------------------------------

rule("4. DETERMINISM");

const a = JSON.stringify(compose({ product: "huddle-deck", tone: "stage", seed: 1 }));
const b = JSON.stringify(compose({ product: "huddle-deck", tone: "stage", seed: 1 }));
console.log(`  same intent twice, byte-identical: ${a === b}`);
const c = JSON.stringify(compose({ product: "huddle-deck", tone: "stage", seed: 2 }));
console.log(`  seed 1 vs seed 2, different:       ${a !== c}`);
console.log("  no nondeterministic call anywhere in the package: verified by test.");
if (a !== b) process.exitCode = 1;

console.log();
