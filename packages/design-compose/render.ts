/**
 * Output. Two shapes, one source.
 *
 *   toCss(spec)     CSS custom properties, ready to paste into a stylesheet or
 *                   inject into a preview iframe. Includes the reduced-motion
 *                   block, because a token set that leaves that to the consumer
 *                   is a token set where it will not happen.
 *
 *   toTokens(spec)  A plain data object. This is what the huddle slide renderer
 *                   consumes: no CSS parsing, no string munging, just values.
 *
 * A note on DTCG: the shape below is aligned with the Design Tokens Community
 * Group's dimension/duration `{value, unit}` form and its `$type` vocabulary,
 * but it is NOT claimed to be conformant and does not carry a `$schema`. The
 * current DTCG draft (Format Module 2025.10, 30 July 2026) is a Community Group
 * report carrying an explicit banner reading "do not implement anything in this
 * document", and the color and dimension shapes have already changed
 * incompatibly once. Emitting a `$schema` we cannot honour would be worse than
 * emitting none. A conformant exporter is a separate job for when the draft
 * settles.
 */

import type { DesignSpec } from "./types";

function cssVar(name: string, value: string | number): string {
	return `  --${name}: ${value};`;
}

export function toCss(spec: DesignSpec): string {
	const lines: string[] = [];
	const c = spec.coordinate;

	lines.push(`/* ${spec.id} - ${spec.intent.product}${spec.intent.tone ? ` / ${spec.intent.tone}` : ""} */`);
	lines.push(`/* ${c.polarity}, ${c.density}, accent hue ${c.accentHue}, ${c.ratio} ramp on a ${spec.baselinePx}px baseline */`);
	lines.push(":root {");

	lines.push("  /* colour */");
	for (const role of spec.colors) lines.push(cssVar(`color-${role.name}`, role.hex));

	lines.push("");
	lines.push(`  /* type - ${c.ramp} ramp, ${c.ratio} */`);
	for (const t of spec.type) {
		lines.push(cssVar(`text-${t.role}`, t.fluid ?? `${t.px}px`));
		lines.push(cssVar(`text-${t.role}-line`, t.lineHeight));
		lines.push(cssVar(`text-${t.role}-weight`, t.weight));
		if (t.tracking !== 0) lines.push(cssVar(`text-${t.role}-tracking`, `${t.tracking}em`));
	}

	lines.push("");
	lines.push(`  /* space - ${c.spaceFamily} multipliers on a ${c.spaceUnit}px unit */`);
	for (const s of spec.space) lines.push(cssVar(`space-${s.name}`, `${s.px}px`));

	lines.push("");
	lines.push(`  /* radius - ${c.radius} */`);
	for (const r of spec.radius) lines.push(cssVar(`radius-${r.name}`, `${r.px}px`));

	lines.push("");
	lines.push(`  /* motion - ${c.motion} */`);
	for (const m of spec.motion) {
		lines.push(cssVar(`motion-${m.name}-duration`, `${m.durationMs}ms`));
		if (m.easing) lines.push(cssVar(`motion-${m.name}-easing`, `cubic-bezier(${m.easing.join(", ")})`));
		else if (m.spring) {
			lines.push(cssVar(`motion-${m.name}-damping`, m.spring.damping));
			lines.push(cssVar(`motion-${m.name}-stiffness`, m.spring.stiffness));
		}
	}

	lines.push("");
	lines.push("  /* layout */");
	lines.push(cssVar("measure", `${spec.layout.measureCh}ch`));
	lines.push(cssVar("baseline", `${spec.baselinePx}px`));
	lines.push(cssVar("target-min", `${spec.layout.minTargetPx}px`));
	lines.push("}");

	lines.push("");
	lines.push(`/* skeleton: ${spec.layout.skeleton} */`);
	lines.push(`.${spec.layout.skeleton} {`);
	lines.push(`  ${spec.layout.css}`);
	lines.push("}");
	if (spec.layout.track) {
		for (const rule of spec.layout.track.split("\n")) {
			lines.push(`.${spec.layout.skeleton} ${rule}`);
		}
	}

	// Reduced motion. Emitted from the tokens' own reduced variants, so it can
	// never disagree with them.
	lines.push("");
	lines.push("@media (prefers-reduced-motion: reduce) {");
	lines.push("  /* substitute, do not kill: positional motion becomes a cross-fade");
	lines.push("     at the same duration, opacity and colour are left alone. */");
	lines.push("  :root {");
	for (const m of spec.motion) {
		lines.push(cssVar(`motion-${m.name}-duration`, `${m.reduced.durationMs}ms`));
		lines.push(cssVar(`motion-${m.name}-axis`, m.reduced.axis));
	}
	lines.push("  }");
	lines.push("}");

	return lines.join("\n");
}

/** The plain data object. Stable shape; the huddle renderer reads this. */
export function toTokens(spec: DesignSpec): Record<string, unknown> {
	return {
		id: spec.id,
		intent: { product: spec.intent.product, tone: spec.intent.tone ?? null, seed: spec.intent.seed ?? 0 },
		coordinate: spec.coordinate,
		baseline: { value: spec.baselinePx, unit: "px" },
		color: Object.fromEntries(
			spec.colors.map((c) => [c.name, { $type: "color", value: c.hex, oklch: c.oklch, hue: c.renderedHue }]),
		),
		typography: Object.fromEntries(
			spec.type.map((t) => [
				t.role,
				{
					$type: "typography",
					fontSize: { value: t.px, unit: "px" },
					fluid: t.fluid,
					lineHeight: t.lineHeight,
					lineHeightPx: { value: t.lineHeightPx, unit: "px" },
					fontWeight: t.weight,
					letterSpacing: { value: t.tracking, unit: "em" },
				},
			]),
		),
		space: Object.fromEntries(spec.space.map((s) => [s.name, { $type: "dimension", value: s.px, unit: "px" }])),
		radius: Object.fromEntries(spec.radius.map((r) => [r.name, { $type: "dimension", value: r.px, unit: "px" }])),
		motion: Object.fromEntries(
			spec.motion.map((m) => [
				m.name,
				{
					$type: m.easing ? "transition" : "spring",
					duration: { value: m.durationMs, unit: "ms" },
					timingFunction: m.easing,
					spring: m.spring,
					axis: m.axis,
					reduced: m.reduced,
				},
			]),
		),
		layout: spec.layout,
		contrast: spec.pairs,
		score: spec.score,
	};
}

/**
 * A one-screen human summary. This is what goes back into a chat channel, and
 * it is the only thing about the design a model ever reads - roughly 60 tokens
 * instead of the several thousand it would take to state the spec in prose.
 */
export function toSummary(spec: DesignSpec): string {
	const c = spec.coordinate;
	const accent = spec.colors.find((r) => r.name === "accent")?.hex ?? "?";
	const worst = spec.pairs.reduce((m, p) => Math.min(m, p.ratio), Number.POSITIVE_INFINITY);
	return [
		`design ${spec.id}: ${c.polarity}, ${c.density}, ${c.ratio} ramp (${c.ramp}) on a ${spec.baselinePx}px baseline.`,
		`Accent ${accent} at hue ${c.accentHue}, ${c.structure} structure. ${c.skeleton} skeleton at ${c.measure}ch.`,
		`${c.motion} motion, ${c.surface} surfaces, ${c.emphasis}-led hierarchy, ${c.radius} radii.`,
		`Worst contrast pair ${worst.toFixed(2)}:1 against a WCAG 2.2 AA floor. Score ${spec.score.total.toFixed(3)}.`,
	].join(" ");
}
