/**
 * Layout skeletons.
 *
 * Every one of these is a CSS mechanism rather than a set of breakpoints, taken
 * from Every Layout (Heydon Pickering and Andy Bell). The property that makes
 * them generatable: the breakpoint is a fact about the COMPONENT, not about the
 * viewport, so a composer can emit one without knowing anything about the page
 * it will live in. A media-query-based layout cannot be generated this way,
 * because the correct breakpoint depends on content the composer has not seen.
 */

import type { Density, Skeleton } from "./axes";
import { DENSITIES } from "./axes";
import type { LayoutSpec } from "./types";

/** SC 2.5.8 Target Size (Minimum), AA. Hard floor, enforced in constraints.ts. */
export const MIN_TARGET_PX = 24;

/** SC 1.4.8 Visual Presentation, AAA: no more than 80 characters per line. */
export const MAX_MEASURE_CH = 80;

export function buildLayout(
	skeleton: Skeleton,
	measureCh: number,
	density: Density,
	spaceMd: number,
	spaceLg: number,
): LayoutSpec {
	const gap = `${spaceMd}px`;
	const minTargetPx = DENSITIES[density].minTarget;
	let css: string;
	let track: string | null = null;

	switch (skeleton) {
		case "stack":
			// The owl selector. `* + *` never leaves a trailing margin, so there is
			// nothing to strip at the end of a list and nothing to collapse.
			css = [
				"display: flex;",
				"flex-direction: column;",
				"justify-content: flex-start;",
			].join("\n  ");
			break;

		case "sidebar":
			// flex-basis holds the sidebar at its intrinsic width; flex-grow 999
			// against 1 gives the main content 999/1000 of the free space, so the
			// sidebar effectively does not grow. min-inline-size: 50% is the wrap
			// trigger - once main would drop below half the container, flex wrapping
			// forces both children full width. No media query anywhere.
			css = [
				"display: flex;",
				"flex-wrap: wrap;",
				`gap: ${gap};`,
			].join("\n  ");
			track = `> :first-child { flex-basis: ${spaceLg * 8}px; flex-grow: 1; }\n> :last-child { flex-basis: 0; flex-grow: 999; min-inline-size: 50%; }`;
			break;

		case "switcher": {
			// calc((threshold - 100%) * 999) as a step function. Above the
			// threshold the basis goes negative, the declaration is invalid and
			// dropped, and only flex-grow applies so items share a row. Below it,
			// the basis vastly exceeds the container so each item takes a full row.
			// The :nth-last-child(n+5) guard is a quantity query, not a width one:
			// a five-way switcher is unreadable at any size.
			const threshold = Math.round(measureCh * 0.55);
			css = [
				"display: flex;",
				"flex-wrap: wrap;",
				`gap: ${gap};`,
				`--threshold: ${threshold}ch;`,
			].join("\n  ");
			track = "> * { flex-grow: 1; flex-basis: calc((var(--threshold) - 100%) * 999); }\n> :nth-last-child(n+5), > :nth-last-child(n+5) ~ * { flex-basis: 100%; }";
			break;
		}

		case "grid": {
			// The RAM pattern. The inner min(...) is not optional: a bare
			// minmax(20rem, 1fr) overflows any container narrower than 20rem,
			// because the min track size is a hard floor.
			const minTrack = `${Math.round(measureCh * 0.42)}ch`;
			track = `repeat(auto-fit, minmax(min(${minTrack}, 100%), 1fr))`;
			css = ["display: grid;", `grid-template-columns: ${track};`, `gap: ${gap};`].join("\n  ");
			break;
		}

		case "cover":
			css = [
				"display: flex;",
				"flex-direction: column;",
				`min-block-size: 100svh;`,
				`padding: ${spaceLg}px;`,
			].join("\n  ");
			track = "> :where(h1, h2, .principal) { margin-block: auto; }";
			break;

		case "centre":
			// content-box is deliberate: the measure stays a pure text measure and
			// the gutter sits outside it, so a 66ch measure is actually 66ch.
			css = [
				"box-sizing: content-box;",
				"margin-inline: auto;",
				`max-inline-size: ${measureCh}ch;`,
				`padding-inline: ${spaceLg}px;`,
			].join("\n  ");
			break;
	}

	return { skeleton, measureCh, css, minTargetPx, track };
}
