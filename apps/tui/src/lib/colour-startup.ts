/**
 * Apply the colour policy to stdout before anything draws (#3171).
 * Imported by index.tsx straight after early-input, so Ink, the splash and
 * any startup log line all go through it. See lib/colour-policy.ts for the
 * NO_COLOR / FORCE_COLOR / TERM=dumb precedence.
 */
import { installColourPolicy } from "./colour-policy.js";

export const COLOUR_STRIPPED = installColourPolicy();
