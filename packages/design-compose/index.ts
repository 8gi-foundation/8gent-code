/**
 * @8gent/design-compose
 *
 * The design layer of the reference contract. [[TASK]]/[[HELM]] is the action
 * layer, [[CLAIM]]/[[DERIVE]] is the data layer, [[DESIGN]] is this one.
 *
 * An officer states an intent. Code composes the design. The design space is
 * traversed by executing code, not by reasoning in a context window.
 */

export {
	axisCardinalities,
	coordinateAt,
	latticeSize,
	BANNED_HUE_MAX,
	BANNED_HUE_MIN,
	DENSITIES,
	EMPHASIS_STRATEGIES,
	LEGAL_HUES,
	MEASURES,
	MOTION_PERSONALITIES,
	PALETTE_STRUCTURES,
	POLARITIES,
	RADIUS_FAMILIES,
	RAMP_GENERATORS,
	SKELETONS,
	SPACE_FAMILIES,
	SPACE_UNITS,
	SURFACES,
	TYPE_RATIOS,
	WARM_HUES,
	type Coordinate,
	type Density,
	type Polarity,
} from "./axes";

export {
	CONTRAST_FLOOR,
	contrastRatio,
	fromHex,
	gamutMap,
	inSrgbGamut,
	lightnessSeparation,
	relativeLuminance,
	renderedHue,
	rgbToOklch,
	toHex,
	type Oklch,
	type Rgb,
} from "./color";

export { compose, composeAt, coordinateId, resolve, search, TONE_NAMES, TONES, type SearchResult } from "./compose";

export {
	assertBrandHue,
	assertMeasure,
	assertMonotonicRamp,
	assertNoEmDash,
	assertReducedMotion,
	assertSpacingDistinct,
	assertTargetSize,
	assertWarmProfile,
	checkContrast,
	gate,
} from "./constraints";

export { buildLayout, MAX_MEASURE_CH, MIN_TARGET_PX } from "./layout";
export { OFFICER_DESIGN_PROMPT, parseDesignMarkers, type ParsedDesign } from "./marker";
export { buildMotion } from "./motion";
export { accentChroma, buildPalette, REQUIRED_PAIRS, secondaryHue } from "./palette";
export {
	DESIGN_LEDGER_KIND,
	DESIGN_REFUSED_LEDGER_KIND,
	renderDesignMarkers,
	type DesignOptions,
	type DesignOutcome,
	type LedgerLike,
} from "./pipeline";
export { toCss, toSummary, toTokens } from "./render";
export {
	buildSpaceRamp,
	buildTypeRamp,
	carbonTypeSize,
	fluidClamp,
	fluidResizeFailure,
	TYPE_ROLES,
} from "./scales";
export { hierarchyStrength, restraint, rhythmConsistency, scoreDesign } from "./score";
export { solveLegibleHex, solveLightness } from "./solve";
export {
	DesignRefused,
	type ColorRole,
	type ContrastPair,
	type DesignIntent,
	type DesignScore,
	type DesignSpec,
	type LayoutSpec,
	type MotionToken,
	type TypeStep,
} from "./types";
