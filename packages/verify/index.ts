/**
 * @8gent/verify - deterministic verification substrate for 8gent Table.
 *
 * Officers write REFERENCES ([[CLAIM ...]] markers), never values. Daemon-side
 * code resolves each reference twice against real state, strips anything that
 * fails, substitutes verified values into the channel message, and records the
 * whole derivation canonically in the existing hash-chained ledger.
 *
 * Design doc: 8gi-governance/docs/8GENT-VERIFICATION-SUBSTRATE.md
 */

export * from "./types";
export { EXTRACTORS, defaultRoots, resolveReference, resolveSafePath } from "./extractors";
export { OFFICER_CLAIM_PROMPT, parseMarkers, isDeriveOp } from "./marker";
export { processClaims, hasClaimMarkers, valuesEqual } from "./pipeline";
