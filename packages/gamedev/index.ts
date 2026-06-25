/**
 * 8gent Code - Game Development Tools
 *
 * AI-assisted game dev pipeline:
 * 1. Sprite sheet generation prompts (for ChatGPT Image, DALL-E, etc.)
 * 2. Sprite slicing (split sheet into individual frames)
 * 3. Animation generation (animated GIF/WebP from frames)
 * 4. Sprite sheet packing (pack frames into a sheet)
 * 5. Game scaffolding templates (Phaser, Pixi.js)
 *
 * The workflow: AI generates sprite sheet -> slicer extracts frames ->
 * animation generator animates -> scaffolder generates game code.
 * ~20 minutes from idea to playable.
 */

export {
	sliceSpriteSheet,
	detectGrid,
	type SliceOptions,
	type SliceResult,
} from "./sprite-slicer";

export {
	animate,
	packSpriteSheet,
	getFrameDuration,
	type AnimateOptions,
	type AnimateResult,
	type PackOptions,
	type PackResult,
} from "./animation-generator";

export {
	SPRITE_PROMPTS,
	buildSpritePrompt,
	type SpritePromptConfig,
} from "./prompts";

export { scaffoldGame, type GameConfig } from "./scaffold";

export {
	generate,
	detectTools,
	listAssets,
	type GenerateOptions,
	type GenerateResult,
	type MediaAsset,
	type MediaAssetManifest,
} from "./harness";
