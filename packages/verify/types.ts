/**
 * 8gent verification substrate - claim types.
 *
 * The contract (the data-layer twin of the [[TASK]]/[[HELM]] action-layer
 * contract): an officer NEVER writes a repo fact as prose. It writes a
 * REFERENCE - a [[CLAIM ...]] marker naming a deterministic extractor and its
 * locator args. Daemon-side code resolves the reference to a value; the model
 * never authors or manipulates the number. If the officer does assert a value
 * (expect=), the assertion only survives when an independent deterministic
 * re-resolution agrees; otherwise it is stripped and replaced with the
 * verified value plus an explicit flag. Nothing unverified passes silently.
 */

/** A parsed [[CLAIM ...]] marker: a reference, never a value. */
export interface Claim {
	/** Officer-chosen id ("c1") so a [[DERIVE]] can name its inputs. */
	id: string;
	/** Extractor name, e.g. "git.head", "file.lines". */
	src: string;
	/** Locator args for the extractor (path, repo, ref, line, glob, range). */
	args: Record<string, string>;
	/** Officer-asserted value, if any. Only survives when verification agrees. */
	expect?: string;
	/** Raw marker text as it appeared in the reply (for substitution). */
	raw: string;
}

/** A parsed [[DERIVE ...]] marker: names WHAT to compute, never computes. */
export interface Derivation {
	id: string;
	/** Whitelisted arithmetic op. Code computes; the model only names it. */
	op: DeriveOp;
	/** Claim ids whose VERIFIED values are the operands, in order. */
	of: string[];
	expect?: string;
	raw: string;
}

export type DeriveOp = "sum" | "diff" | "ratio" | "max" | "min";
export const DERIVE_OPS: ReadonlySet<string> = new Set(["sum", "diff", "ratio", "max", "min"]);

export type ClaimStatus =
	/** Reference resolved, both independent resolutions agree, expect (if any) matches. */
	| "verified"
	/** Officer asserted a value; deterministic re-resolution disagrees. Stripped. */
	| "mismatch"
	/** Two independent resolutions of the same reference disagreed. Stripped. */
	| "unstable"
	/** Unknown extractor, missing args, denied path, or extractor failure. Stripped. */
	| "error";

export interface ClaimResult {
	kind: "claim" | "derivation";
	id: string;
	src: string;
	args: Record<string, string>;
	expect?: string;
	/** The deterministically resolved value. Present unless status is "error". */
	value?: string;
	status: ClaimStatus;
	/** Human-readable reason when not verified. */
	reason?: string;
	/** Text substituted into the channel message in place of the marker. */
	rendered: string;
}

/**
 * Whatever appends to the daemon's ledger. In the daemon this is the live
 * Table Ledger (single writer, daemon-owned); in tests a temp Ledger. This
 * package NEVER opens the live ledger itself - the caller injects it.
 */
export interface LedgerLike {
	append(input: { kind: string; payload: Record<string, unknown> }): unknown;
}

export interface VerifyOptions {
	/** Absolute directories references may read from. Default: standard work roots. */
	roots?: string[];
	/** Ledger to record claim + derivation entries into. Optional (tests, dry runs). */
	ledger?: LedgerLike;
	/** Clock override for tests. */
	now?: () => number;
}

export interface VerifyOutcome {
	/** The reply with every marker replaced by a verified value or a strip flag. */
	text: string;
	results: ClaimResult[];
	/** True when every claim and derivation verified. */
	allVerified: boolean;
}

/** Ledger event kinds this package appends (Ledger accepts `string` kinds). */
export const CLAIM_LEDGER_KIND = "verify.claim";
export const DERIVATION_LEDGER_KIND = "verify.derivation";
