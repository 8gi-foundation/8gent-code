/**
 * The bridge: packages/design-compose -> the huddle slide renderer.
 *
 * Before this file, slide-render.ts carried a hand-written PALETTE constant and
 * roughly forty hard-coded pixel values. design-compose existed, had 86 tests
 * and 1.19 billion admissible warm designs, and had exactly zero callers. This
 * is the wiring.
 *
 * ONE DESIGN PER HUDDLE. `themeFor(huddleId)` composes a single DesignSpec and
 * every slide in that deliberation is rendered from it, so a huddle looks like
 * one thing rather than eight unrelated cards. Two different huddles get two
 * different designs; the same huddle re-baked six months later gets the same
 * one, because the only input is the huddle id.
 *
 * DETERMINISM. No Math.random, no Date.now, no filesystem, no locale. The
 * huddle id is hashed into design-compose's own `product` field, which the
 * composer mixes with FNV-1a. Same id, same coordinate, same spec, byte for
 * byte, on any machine.
 *
 * THE GATE STILL BITES. Nothing here reimplements a brand or accessibility
 * rule. Officer accents are solved with design-compose's own solver and then
 * pushed back through `assertBrandHue`, `assertWarmProfile` and `checkContrast`
 * before they are allowed into a theme. A violet accent throws DesignRefused
 * here exactly as it does inside the composer, because it IS the composer's
 * check being called. See __tests__/slide-theme.test.ts.
 *
 * WHY A STAGE RAMP AND NOT THE COMPOSED ONE. design-compose builds a ramp for a
 * reading surface: body lands at 14-18px. A slide is a 1920x1080 poster read
 * from across a room, and a 16px body on it is invisible. So the stage ramp is
 * built by calling design-compose's OWN `buildTypeRamp` a second time, at the
 * same coordinate (same ratio, same generator, same baseline, same emphasis
 * weights, same tracking), with the base size solved so the reading role lands
 * at slide scale. Every design decision in the coordinate survives; only the
 * anchor moves. Rhythm is exact by construction rather than by re-snapping,
 * because it is the same generator doing the snapping.
 */

import {
	accentChroma,
	assertBrandHue,
	assertSpacingDistinct,
	assertWarmProfile,
	buildPalette,
	buildSpaceRamp,
	buildTypeRamp,
	checkContrast,
	CONTRAST_FLOOR,
	DENSITIES,
	DesignRefused,
	fromHex,
	gamutMap,
	renderedHue,
	compose,
	solveLegibleHex,
	toHex,
	toSummary,
	WARM_HUES,
	type ColorRole,
	type Coordinate,
	type DesignSpec,
	type Polarity,
} from "../design-compose";
import { OFFICERS } from "./officers";

// ---------------------------------------------------------------------------
// Canvas constants. The slide is authored at exactly this size (spec 4.6) and
// screenshotted at it by bake.ts. These are facts about the medium, not design
// decisions, so they are not axes.
// ---------------------------------------------------------------------------

export const CANVAS_W = 1920;
export const CANVAS_H = 1080;

/** Target size for the reading role (bullets, timeline text, compare text) at
 *  canvas scale. Chosen so a 48-character bullet fits one line in the column. */
const LEAD_TARGET_PX = 40;

/** Widest a display numeral is allowed to get. Beyond this a 4-character metric
 *  starts colliding with the officer band above it. */
const HERO_MAX_PX = 236;

/** Average advance width of a digit or capital, as a fraction of the em, for
 *  the system display face at weight 700+. Used only to size the metric hero to
 *  its own content. Measured off SF Pro Display, not guessed at. */
const DISPLAY_ADVANCE_EM = 0.62;

// ---------------------------------------------------------------------------
// The officer roster, in a FIXED order.
//
// Officer accents are spread across the warm band by POSITION IN THIS LIST, not
// by hashing the code. Hashing would cluster two officers onto neighbouring
// hues about a third of the time; spreading by position guarantees the maximum
// separation the band allows.
//
// Honest limit, stated rather than hidden: BRAND.md's warm band is 355-75
// degrees, an 80-degree arc. Nine officers spread across it are about nine
// degrees apart, which is NOT reliably distinguishable. So colour is not asked
// to carry identity alone - it is paired with a second channel, the lightness
// rung (alternating bright/deep down the list), and a third, the officer's
// initial set as a mark on the spine. Colour reinforces; the mark identifies.
// ---------------------------------------------------------------------------

export const ACCENT_ORDER = ["8EO", "8TO", "8SO", "8PO", "8DO", "8CO", "8MO", "8GO", "HUMAN"] as const;

export type AccentRung = "bright" | "deep";

/** Contrast targets for the two rungs. Both clear SC 1.4.3's 3:1 large-text
 *  floor; the bright rung clears it by a wide margin, which in a dark polarity
 *  means a lighter colour and in a light polarity a darker one. Two rungs
 *  double the perceptual separation the 80-degree band can produce. */
const RUNG_TARGET: Record<AccentRung, number> = {
	deep: CONTRAST_FLOOR.large + 0.2,
	bright: CONTRAST_FLOOR.large + 1.9,
};

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface StageType {
	px: number;
	lineHeightPx: number;
	weight: number;
	/** em. Emitted verbatim; the composer already applied optical correction. */
	tracking: number;
}

export interface OfficerAccent {
	code: string;
	/** Solved to a contrast target against the huddle's busiest surface. */
	hex: string;
	/** A legible foreground for text sitting ON the accent. */
	onHex: string;
	/** Low-chroma companion for fills, spines and ghost marks. */
	quietHex: string;
	hue: number;
	rung: AccentRung;
	/** One or two characters. The channel that actually carries identity. */
	mark: string;
	/** The officer's brief, read off the roster rather than restated here, so a
	 *  roster change moves the slide label with it. */
	role: string;
}

export interface SlideTheme {
	/** design-compose's own spec id. Same huddle, same id, forever. */
	designId: string;
	huddleId: string;
	coordinate: Coordinate;
	polarity: Polarity;
	baselinePx: number;
	color: {
		bg0: string;
		bg1: string;
		bg2: string;
		bg3: string;
		border: string;
		text: string;
		textSecondary: string;
		textTertiary: string;
		accent: string;
		accentQuiet: string;
		onAccent: string;
		secondary: string;
		/** The ASSERTED chip. Solved, not picked. */
		warn: string;
		onWarn: string;
	};
	/** Exactly five sizes. Ngo economy: fewer distinct sizes, stronger system. */
	type: {
		hero: StageType;
		cover: StageType;
		title: StageType;
		lead: StageType;
		sub: StageType;
	};
	/** Canvas-scale spacing, on the same baseline grid as the type. */
	space: Record<string, number>;
	radius: { sm: number; md: number; lg: number; xl: number };
	motion: {
		enterMs: number;
		easing: string;
		/** What the enter token becomes under prefers-reduced-motion. */
		reducedMs: number;
	};
	/** Page margins, derived from the spacing ramp rather than typed in. */
	pad: { x: number; top: number; bottom: number };
	officers: Record<string, OfficerAccent>;
	/** One line of provenance, stamped into the slide's HTML comment. */
	summary: string;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

function role(colors: readonly ColorRole[], name: string): string {
	const found = colors.find((c) => c.name === name);
	if (!found) throw new DesignRefused("palette.role", `the composed palette has no role "${name}"`);
	return found.hex;
}

/**
 * The huddle's design.
 *
 * `tone: "stage"` is design-compose's presentation preset: golden ratio, 45ch
 * measure, spacious density, size-weight emphasis, expressive motion, cover
 * skeleton, flat surfaces. That pins seven axes. The seven it leaves free -
 * ramp generator, space unit, space family, accent hue, palette structure,
 * polarity and radius - are what make two huddles look different, and they are
 * drawn from the huddle id alone.
 *
 * SELECTION IS A SEED WALK, NOT `search().best`, and that is a finding rather
 * than a preference. `search` ranks candidates on design-compose's scorer, and
 * the scorer has systematic optima: restraint is Ngo economy, so the `sharp`
 * radius family (four zeroes, one distinct value) beats every other family on
 * every design, and contrast headroom favours the dark polarity. Measured on
 * four huddle ids, best-of-40 returned dark + sharp every single time. A
 * selector that always wins the same axis positions has deleted those axes.
 *
 * So: walk the seed from zero and take the FIRST admissible design. About one
 * lattice point in forty is refused outright (space.distinct, per the package's
 * own measured walk), so the walk terminates immediately in practice, and the
 * huddle id maps onto the whole free lattice rather than onto the scorer's
 * favourite corner. The refusals are still refusals - they are skipped, never
 * corrected, and the count is returned so a caller can see them.
 */
export function huddleDesign(huddleId: string): { spec: DesignSpec; skipped: number } {
	const product = `8gent-huddle:${huddleId}`;
	let skipped = 0;
	for (let seed = 0; seed < 64; seed += 1) {
		try {
			return { spec: compose({ product, tone: "stage", seed }), skipped };
		} catch (err) {
			if (err instanceof DesignRefused) {
				skipped += 1;
				continue;
			}
			throw err;
		}
	}
	// Not reachable in the measured lattice, and stated rather than silently
	// falling back to a hand-written theme, which is the failure mode this whole
	// package exists to remove.
	throw new DesignRefused(
		"huddle.design",
		`all 64 seeds for huddle ${huddleId} were refused. The stage tone cannot be composed on this lattice.`,
	);
}

/** Round to the nearest multiple of `unit`, never below one unit. */
function snap(value: number, unit: number): number {
	return Math.max(unit, Math.round(value / unit) * unit);
}

/**
 * Solve the stage base size.
 *
 * The reading role on a slide is h3 - the size bullets, timeline entries and
 * compare panels are set at. Walk integer base sizes and keep the one whose h3
 * lands closest to LEAD_TARGET_PX. Ties break to the larger base, because a
 * larger base lifts the whole lower half of the ramp and the lower half is
 * where legibility is scarce on a 1920 canvas.
 *
 * This is a search over one integer, not a fudge factor: the ramp itself is
 * still generated entirely by design-compose from the huddle's coordinate.
 */
function solveStageBase(coordinate: Coordinate, baselinePx: number): number {
	const lineHeightTarget = DENSITIES[coordinate.density].lineHeight;
	let bestBase = 16;
	let bestMiss = Number.POSITIVE_INFINITY;
	for (let base = 10; base <= 40; base += 1) {
		const ramp = buildTypeRamp({
			basePx: base,
			ratio: coordinate.ratio,
			generator: coordinate.ramp,
			baselinePx,
			lineHeightTarget,
			emphasis: coordinate.emphasis,
		});
		const h3 = ramp.find((t) => t.role === "h3");
		if (!h3) continue;
		const miss = Math.abs(h3.px - LEAD_TARGET_PX);
		if (miss <= bestMiss) {
			bestMiss = miss;
			bestBase = base;
		}
	}
	return bestBase;
}

/**
 * Solve an officer accent at a hue and a rung.
 *
 * Everything here is design-compose's: the chroma envelope, the bisection
 * solver, the contrast floors, the hue ban, the warm profile. The only thing
 * this function adds is the pairing of a hue with a rung. It throws
 * DesignRefused - never returns a corrected colour - which is what keeps a
 * violet officer accent impossible rather than merely discouraged.
 */
export function solveOfficerAccent(
	code: string,
	hue: number,
	rung: AccentRung,
	polarity: Polarity,
	surfaceHex: string,
	base: readonly ColorRole[],
): OfficerAccent {
	const away = polarity === "dark" ? "lighter" : "darker";
	const surface = fromHex(surfaceHex);
	const hit = solveLegibleHex(hue, accentChroma, surface, RUNG_TARGET[rung], away);
	if (!hit) {
		throw new DesignRefused(
			"a11y.contrast",
			`no lightness at hue ${hue} reaches ${RUNG_TARGET[rung]}:1 against ${surfaceHex} for officer ${code}. This hue cannot carry an accent on this surface.`,
		);
	}

	const accentRgb = fromHex(hit.hex);
	const on =
		solveLegibleHex(hue, () => 0.008, accentRgb, CONTRAST_FLOOR.body, "darker") ??
		solveLegibleHex(hue, () => 0.008, accentRgb, CONTRAST_FLOOR.body, "lighter");
	if (!on) {
		throw new DesignRefused(
			"a11y.contrast",
			`officer ${code}'s accent ${hit.hex} sits in the mid-lightness dead zone: no near-black or near-white foreground reaches 4.5:1 on it.`,
		);
	}

	// The quiet companion. Same rule buildPalette uses for accent-quiet: step off
	// the accent's lightness towards the page and halve the chroma. It carries no
	// contrast contract of its own - it is only ever a fill or a ghost mark - so
	// it is derived rather than solved, and it is still gated below.
	const quietL = polarity === "dark" ? Math.max(0.24, hit.l - 0.2) : Math.min(0.93, hit.l + 0.22);
	const quietHex = toHex(gamutMap({ l: quietL, c: accentChroma(quietL) * 0.5, h: hue }));

	const accentRole: ColorRole = {
		name: "accent",
		hex: hit.hex,
		oklch: { l: hit.l, c: accentChroma(hit.l), h: hue },
		renderedHue: renderedHue(accentRgb),
	};
	const onRole: ColorRole = {
		name: "on-accent",
		hex: on.hex,
		oklch: { l: on.l, c: 0.008, h: hue },
		renderedHue: renderedHue(fromHex(on.hex)),
	};
	const quietRole: ColorRole = {
		name: "accent-quiet",
		hex: quietHex,
		oklch: { l: quietL, c: accentChroma(quietL) * 0.5, h: hue },
		renderedHue: renderedHue(fromHex(quietHex)),
	};

	// THE GATE, on the palette this officer will actually be rendered against:
	// the huddle's own backgrounds and text roles with this accent swapped in.
	// Not a re-implementation - these are design-compose's own assertions.
	const merged = [...base.filter((c) => c.name !== "accent" && c.name !== "on-accent" && c.name !== "accent-quiet"), accentRole, onRole, quietRole];
	assertBrandHue(merged);
	assertWarmProfile(merged);
	checkContrast(merged);

	return {
		code,
		hex: hit.hex,
		onHex: on.hex,
		quietHex,
		hue,
		rung,
		mark: markFor(code),
		role: OFFICERS[code]?.role ?? (code === "HUMAN" ? "chair" : "officer"),
	};
}

/**
 * The officer's mark. Two characters for an officer code (the two that differ:
 * "8TO" -> "TO"), one for a human. This is the channel that actually carries
 * identity at a glance, because nine hues inside an 80-degree band do not.
 */
export function markFor(code: string): string {
	if (code === "HUMAN") return "H";
	const upper = code.toUpperCase();
	if (/^8[A-Z]{2}$/.test(upper)) return upper.slice(1);
	return upper.slice(0, 2);
}

/**
 * Spread N officers across the warm hue set, rotated so the huddle's own accent
 * hue is the exec's. Even spacing, deterministic, no hashing.
 */
function officerHues(baseHue: number, count: number): number[] {
	const hues = WARM_HUES;
	const start = Math.max(0, hues.indexOf(baseHue));
	const stride = hues.length / count;
	return Array.from({ length: count }, (_, i) => hues[(start + Math.round(i * stride)) % hues.length] as number);
}

// ---------------------------------------------------------------------------
// themeFor
// ---------------------------------------------------------------------------

const CACHE = new Map<string, SlideTheme>();

/**
 * The huddle's theme. Memoised, because composing forty candidates and solving
 * eighteen accent colours is a few milliseconds and a huddle renders it once
 * per turn on the floor's critical path. The memo is a cache of a pure
 * function: it changes nothing about determinism.
 */
export function themeFor(huddleId: string): SlideTheme {
	const hit = CACHE.get(huddleId);
	if (hit) return hit;
	const built = buildTheme(huddleId);
	CACHE.set(huddleId, built);
	return built;
}

export function buildTheme(huddleId: string): SlideTheme {
	const { spec, skipped } = huddleDesign(huddleId);
	const c = spec.coordinate;
	const colors = spec.colors;

	// ── Type, at canvas scale ───────────────────────────────────────────────
	const stageBase = solveStageBase(c, spec.baselinePx);
	const ramp = buildTypeRamp({
		basePx: stageBase,
		ratio: c.ratio,
		generator: c.ramp,
		baselinePx: spec.baselinePx,
		lineHeightTarget: DENSITIES[c.density].lineHeight,
		emphasis: c.emphasis,
	});
	const at = (name: string): StageType => {
		const t = ramp.find((r) => r.role === name);
		if (!t) throw new DesignRefused("type.role", `the stage ramp has no role "${name}"`);
		return { px: t.px, lineHeightPx: t.lineHeightPx, weight: t.weight, tracking: t.tracking };
	};

	const cover = at("h1");
	const title = at("h2");
	const lead = at("h3");
	const sub = at("body-lg");
	const display = at("display");

	// The hero is display LETTERING, not a reading role. A poster's headline
	// numeral is sized by the canvas it has to fill, which is why it gets an
	// anchor of its own rather than the ramp's top step: a compressed ramp
	// (Carbon's recurrence, say) tops out around 84px, and an 84px metric on a
	// 1920 canvas is not a hero, it is a subheading. Its WEIGHT and TRACKING
	// still come from the composed display role, so the design's voice carries.
	const hero: StageType = {
		px: Math.min(HERO_MAX_PX, Math.max(display.px, Math.round(cover.px * 1.9))),
		lineHeightPx: 0, // set below, once px is final
		weight: display.weight,
		tracking: display.tracking,
	};
	hero.lineHeightPx = snap(hero.px * 0.94, spec.baselinePx);

	// ── Space, at canvas scale ──────────────────────────────────────────────
	// The composed ramp is a reading-surface ramp (4-40px). Scale the GENERATOR
	// CONSTANT, never the generated values - the same rule composeAt applies for
	// density - by the whole multiple of the baseline nearest 10px. Every value
	// stays on the baseline grid, so the vertical rhythm the type is snapped to
	// is the same grid the spacing uses.
	const stageUnit = snap(10, spec.baselinePx);
	const stageSpace = buildSpaceRamp(stageUnit, c.spaceFamily);
	assertSpacingDistinct(stageSpace);
	const space: Record<string, number> = Object.fromEntries(stageSpace.map((s) => [s.name, s.px]));

	// ── Radii, scaled to the canvas ─────────────────────────────────────────
	// A 4px corner on a 1920 poster is a square corner. The FAMILY is the design
	// decision (sharp stays sharp, pill stays pill); the multiplier is medium.
	const radiusScale = 3;
	const rr = (n: number): number => (n >= 999 ? 999 : n * radiusScale);
	const radius = {
		sm: rr(spec.radius[0]?.px ?? 0),
		md: rr(spec.radius[1]?.px ?? 0),
		lg: rr(spec.radius[2]?.px ?? 0),
		xl: rr(spec.radius[3]?.px ?? 0),
	};

	// ── Motion ──────────────────────────────────────────────────────────────
	// One token, taken from the composed set. The huddle's motion lives BETWEEN
	// slides, not inside them: a slide is screenshotted for the bake, so an
	// animation running inside it is a source of pixel nondeterminism. The
	// reduced variant is carried through from the token that declares it, so the
	// reduced-motion rule cannot be forgotten here.
	const enter = spec.motion.find((m) => m.axis === "opacity") ?? spec.motion[0];
	if (!enter) throw new DesignRefused("motion.missing", "the composed spec carries no motion tokens");
	const motion = {
		enterMs: enter.durationMs,
		easing: enter.easing ? `cubic-bezier(${enter.easing.join(", ")})` : "linear",
		reducedMs: enter.reduced.durationMs,
	};

	// ── The ASSERTED chip colour ────────────────────────────────────────────
	// Solved, not picked. Hue 45 is amber, inside the warm band, and 45 degrees
	// from anything the accent axis can land on at the red end. Deliberately not
	// red: an asserted value is unverified, not wrong.
	const warnPalette = buildPalette({
		accentHue: 45,
		structure: "mono",
		polarity: c.polarity,
		emphasis: c.emphasis,
		available: WARM_HUES,
	});

	// ── Officer accents ─────────────────────────────────────────────────────
	const hues = officerHues(c.accentHue, ACCENT_ORDER.length);
	const officers: Record<string, OfficerAccent> = {};
	for (let i = 0; i < ACCENT_ORDER.length; i += 1) {
		const code = ACCENT_ORDER[i] as string;
		officers[code] = solveOfficerAccent(
			code,
			hues[i] as number,
			i % 2 === 0 ? "bright" : "deep",
			c.polarity,
			role(colors, "bg-2"),
			colors,
		);
	}

	const theme: SlideTheme = {
		designId: spec.id,
		huddleId,
		coordinate: c,
		polarity: c.polarity,
		baselinePx: spec.baselinePx,
		color: {
			bg0: role(colors, "bg-0"),
			bg1: role(colors, "bg-1"),
			bg2: role(colors, "bg-2"),
			bg3: role(colors, "bg-3"),
			border: role(colors, "border"),
			text: role(colors, "text-primary"),
			textSecondary: role(colors, "text-secondary"),
			textTertiary: role(colors, "text-tertiary"),
			accent: role(colors, "accent"),
			accentQuiet: role(colors, "accent-quiet"),
			onAccent: role(colors, "on-accent"),
			secondary: role(colors, "secondary"),
			warn: role(warnPalette, "accent"),
			onWarn: role(warnPalette, "on-accent"),
		},
		type: { hero, cover, title, lead, sub },
		space,
		radius,
		motion,
		pad: {
			x: space["5xl"] ?? 100,
			top: space["4xl"] ?? 80,
			bottom: space["3xl"] ?? 60,
		},
		officers,
		summary: `${toSummary(spec)} ${skipped} candidate${skipped === 1 ? "" : "s"} refused before this one.`,
	};

	return theme;
}

/**
 * The accent for a participant, with a defined fallback.
 *
 * A code that is not on the roster (a guest, a renamed officer) gets the exec
 * accent rather than an exception: an unknown officer must not be able to stop
 * a huddle rendering. The roster itself is the thing to fix in that case.
 */
export function accentFor(theme: SlideTheme, code: string): OfficerAccent {
	return theme.officers[code.toUpperCase()] ?? (theme.officers["8EO"] as OfficerAccent);
}
