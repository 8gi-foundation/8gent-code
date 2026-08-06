/**
 * The checker: resolve every reference twice, independently; compare; strip
 * anything that fails; substitute verified values into the reply; record every
 * claim and derivation canonically in the ledger.
 *
 * Runs DAEMON-SIDE, in the same seam as helm-bridge's parseProposal: after an
 * officer's reply is generated and before store.postMessage. The officer's
 * chat model never sees an extractor, never executes, and never learns the
 * ledger key - it only ever emitted a reference.
 *
 * One deliberate deviation from Kepler's "strip before a human ever sees it":
 * a failed claim is stripped, but the STRIP ITSELF is visible in the channel,
 * with the verified value beside it. In a governance channel the officer's
 * error is signal - hiding it would be its own kind of dishonesty.
 */

import { defaultRoots, resolveReference } from "./extractors";
import { isDeriveOp, parseMarkers } from "./marker";
import {
	CLAIM_LEDGER_KIND,
	type Claim,
	type ClaimResult,
	DERIVATION_LEDGER_KIND,
	type Derivation,
	type VerifyOptions,
	type VerifyOutcome,
} from "./types";

/** Values compare numerically when both sides are finite numbers, else as
 *  trimmed strings. "313" == "313.0" is a match; hashes compare exactly. */
export function valuesEqual(a: string, b: string): boolean {
	const ta = a.trim();
	const tb = b.trim();
	if (ta === tb) return true;
	const na = Number(ta);
	const nb = Number(tb);
	return ta !== "" && tb !== "" && Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

function checkClaim(claim: Claim, roots: string[]): ClaimResult {
	const base = {
		kind: "claim" as const,
		id: claim.id,
		src: claim.src,
		args: claim.args,
		expect: claim.expect,
	};
	let first: string;
	try {
		first = resolveReference(claim.src, claim.args, roots);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { ...base, status: "error", reason, rendered: renderStripped(claim.src, reason) };
	}
	// Independent second resolution: a reference whose value is not stable
	// under re-resolution is not a deterministic fact and does not pass.
	let second: string;
	try {
		second = resolveReference(claim.src, claim.args, roots);
	} catch (err) {
		const reason = `re-resolution failed: ${err instanceof Error ? err.message : String(err)}`;
		return { ...base, status: "error", reason, rendered: renderStripped(claim.src, reason) };
	}
	if (!valuesEqual(first, second)) {
		const reason = `unstable reference: ${JSON.stringify(first)} then ${JSON.stringify(second)}`;
		return { ...base, status: "unstable", reason, rendered: renderStripped(claim.src, reason) };
	}
	if (claim.expect !== undefined && !valuesEqual(claim.expect, first)) {
		return {
			...base,
			status: "mismatch",
			value: first,
			reason: `asserted ${JSON.stringify(claim.expect)}, verified ${JSON.stringify(first)}`,
			rendered: renderMismatch(claim, first),
		};
	}
	return { ...base, status: "verified", value: first, rendered: renderVerified(claim, first) };
}

function checkDerivation(d: Derivation, byId: Map<string, ClaimResult>): ClaimResult {
	const base = {
		kind: "derivation" as const,
		id: d.id,
		src: `derive.${d.op}`,
		args: { of: d.of.join(",") },
		expect: d.expect,
	};
	if (!isDeriveOp(d.op)) {
		const reason = `unknown op: ${JSON.stringify(d.op)}`;
		return { ...base, status: "error", reason, rendered: renderStripped(base.src, reason) };
	}
	if (d.of.length < 2) {
		const reason = "needs at least two input claim ids (of=c1,c2)";
		return { ...base, status: "error", reason, rendered: renderStripped(base.src, reason) };
	}
	const operands: number[] = [];
	for (const id of d.of) {
		const input = byId.get(id);
		if (!input || input.status !== "verified") {
			const reason = `input ${id} is not a verified claim`;
			return { ...base, status: "error", reason, rendered: renderStripped(base.src, reason) };
		}
		const n = Number(input.value);
		if (!Number.isFinite(n)) {
			const reason = `input ${id} is not numeric (${JSON.stringify(input.value)})`;
			return { ...base, status: "error", reason, rendered: renderStripped(base.src, reason) };
		}
		operands.push(n);
	}
	let value: number;
	switch (d.op) {
		case "sum":
			value = operands.reduce((a, b) => a + b, 0);
			break;
		case "diff":
			value = operands.reduce((a, b) => a - b);
			break;
		case "ratio": {
			if (operands.slice(1).some((n) => n === 0)) {
				const reason = "division by zero";
				return { ...base, status: "error", reason, rendered: renderStripped(base.src, reason) };
			}
			value = operands.reduce((a, b) => a / b);
			break;
		}
		case "max":
			value = Math.max(...operands);
			break;
		case "min":
			value = Math.min(...operands);
			break;
	}
	const rendered = String(value);
	if (d.expect !== undefined && !valuesEqual(d.expect, rendered)) {
		return {
			...base,
			status: "mismatch",
			value: rendered,
			reason: `asserted ${JSON.stringify(d.expect)}, computed ${JSON.stringify(rendered)}`,
			rendered: `[CLAIM STRIPPED: asserted ${d.expect}, ${d.op}(${d.of.join(",")}) computes to ${rendered}]`,
		};
	}
	return {
		...base,
		status: "verified",
		value: rendered,
		rendered: `${rendered} (verified: ${d.op} of ${d.of.join(",")})`,
	};
}

function fmtArgs(args: Record<string, string>): string {
	return Object.entries(args)
		.map(([k, v]) => `${k}=${v}`)
		.join(" ");
}

function renderVerified(claim: Claim, value: string): string {
	return `${value} (verified: ${claim.src} ${fmtArgs(claim.args)})`;
}

function renderMismatch(claim: Claim, value: string): string {
	return `[CLAIM STRIPPED: asserted ${claim.expect}, but ${claim.src} ${fmtArgs(claim.args)} verifies as ${value}]`;
}

function renderStripped(src: string, reason: string): string {
	return `[CLAIM STRIPPED: ${src || "malformed"} - ${reason}]`;
}

/**
 * Verify every marker in an officer reply. Pure over its inputs plus the real
 * state the references point at. Returns the reply with markers replaced and
 * appends one canonical ledger entry per claim/derivation when a ledger is
 * supplied (the daemon supplies its own; this package never opens one).
 */
export function processClaims(reply: string, opts: VerifyOptions = {}): VerifyOutcome {
	const roots = opts.roots ?? defaultRoots();
	const now = opts.now ?? Date.now;
	const { claims, derivations } = parseMarkers(reply);

	const results: ClaimResult[] = [];
	const byId = new Map<string, ClaimResult>();
	let text = reply;

	for (const claim of claims) {
		let result = checkClaim(claim, roots);
		// Two markers with the same explicit id would make derivation inputs
		// ambiguous - the later one is stripped, never silently swapped in.
		if (byId.has(result.id)) {
			result = {
				...result,
				status: "error",
				value: undefined,
				reason: `duplicate claim id ${result.id}`,
				rendered: `[CLAIM STRIPPED: duplicate claim id ${result.id}]`,
			};
		}
		results.push(result);
		if (!byId.has(result.id)) byId.set(result.id, result);
		text = text.replace(claim.raw, result.rendered);
		opts.ledger?.append({
			kind: CLAIM_LEDGER_KIND,
			payload: {
				id: result.id,
				src: result.src,
				args: result.args,
				expect: result.expect ?? null,
				value: result.value ?? null,
				status: result.status,
				reason: result.reason ?? null,
				ts: now(),
			},
		});
	}

	for (const d of derivations) {
		const result = checkDerivation(d, byId);
		results.push(result);
		byId.set(result.id, result);
		text = text.replace(d.raw, result.rendered);
		opts.ledger?.append({
			kind: DERIVATION_LEDGER_KIND,
			payload: {
				id: result.id,
				op: d.op,
				// The full derivation chain: each input's reference AND resolved
				// value, so the computation is replayable from primitives.
				inputs: d.of.map((id) => {
					const input = byId.get(id);
					return {
						id,
						src: input?.src ?? null,
						args: input?.args ?? null,
						value: input?.value ?? null,
					};
				}),
				expect: result.expect ?? null,
				value: result.value ?? null,
				status: result.status,
				reason: result.reason ?? null,
				ts: now(),
			},
		});
	}

	return {
		text: text.trim(),
		results,
		allVerified: results.every((r) => r.status === "verified"),
	};
}

/** True when a reply contains any claim/derive marker (cheap pre-check). */
export function hasClaimMarkers(reply: string): boolean {
	return /\[\[(?:CLAIM|DERIVE)\s/.test(reply);
}
