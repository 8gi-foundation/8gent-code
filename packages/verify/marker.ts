/**
 * [[CLAIM ...]] and [[DERIVE ...]] marker parsing.
 *
 * Same family, same tolerance philosophy as helm-bridge's parseProposal: the
 * 9-12B local models these officers run on truncate markers, close brackets
 * early, and reorder keys. A marker we can still make sense of is parsed, not
 * rejected - the CHECKER is where rigor lives, not the punctuation.
 *
 * Grammar (one line each):
 *   [[CLAIM id=c1 src=git.head repo=~/8gent-code]]
 *   [[CLAIM src=file.lines path=packages/goal/ledger.ts expect=313]]
 *   [[DERIVE op=ratio of=c1,c2 expect=0.5]]
 *
 * Values are single tokens (no spaces) - every locator this substrate accepts
 * (paths, refs, globs, numbers) is space-free by construction.
 */

import { type Claim, DERIVE_OPS, type Derivation, type DeriveOp } from "./types";

const CLAIM_RE = /\[\[CLAIM\s+([\s\S]*?)(?:\]\]|$)/g;
const DERIVE_RE = /\[\[DERIVE\s+([\s\S]*?)(?:\]\]|$)/g;

/** Keys that are marker metadata, not extractor args. */
const META_KEYS = new Set(["id", "src", "expect"]);

function parsePairs(body: string): Record<string, string> {
	const pairs: Record<string, string> = {};
	// k=v tokens; v runs to the next whitespace. Trailing "]" (early-closed
	// bracket) is stripped from values, same salvage as parseProposal.
	for (const m of body.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)=(\S+)/g)) {
		pairs[m[1]] = m[2].replace(/\]+$/, "");
	}
	return pairs;
}

export interface ParsedMarkers {
	claims: Claim[];
	derivations: Derivation[];
}

/** Parse all markers in document order. Malformed markers are returned as
 *  claims with src="" so the pipeline strips them visibly (never silently). */
export function parseMarkers(reply: string): ParsedMarkers {
	const claims: Claim[] = [];
	const derivations: Derivation[] = [];

	// Assign auto-ids that can never collide with an officer-chosen id (or
	// another auto-id): collect every explicit id first, then fill gaps.
	const used = new Set<string>();
	for (const re of [CLAIM_RE, DERIVE_RE]) {
		for (const m of reply.matchAll(re)) {
			const id = parsePairs(m[1]).id;
			if (id) used.add(id);
		}
	}
	let auto = 0;
	const nextId = (prefix: string): string => {
		let id: string;
		do {
			auto += 1;
			id = `${prefix}${auto}`;
		} while (used.has(id));
		used.add(id);
		return id;
	};

	for (const m of reply.matchAll(CLAIM_RE)) {
		const pairs = parsePairs(m[1]);
		const args: Record<string, string> = {};
		for (const [k, v] of Object.entries(pairs)) {
			if (!META_KEYS.has(k)) args[k] = v;
		}
		claims.push({
			id: pairs.id ?? nextId("c"),
			src: pairs.src ?? "",
			args,
			expect: pairs.expect,
			raw: m[0],
		});
	}

	for (const m of reply.matchAll(DERIVE_RE)) {
		const pairs = parsePairs(m[1]);
		derivations.push({
			id: pairs.id ?? nextId("d"),
			op: (pairs.op ?? "") as DeriveOp,
			of: (pairs.of ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
			expect: pairs.expect,
			raw: m[0],
		});
	}

	return { claims, derivations };
}

/** True when the op is one code knows how to compute. */
export function isDeriveOp(op: string): op is DeriveOp {
	return DERIVE_OPS.has(op);
}

/** Officer-facing instructions, appended to an officer's system prompt by the
 *  daemon. Teaches references-not-values in the same voice as the TASK rule. */
export const OFFICER_CLAIM_PROMPT = [
	"When you state a fact about a repo or file (a commit hash, a line count, a",
	"file count, a branch name), NEVER write the number or hash yourself. Write a",
	"claim marker and the system will insert the verified value:",
	"  [[CLAIM src=git.head repo=~/8gent-code]]",
	"  [[CLAIM src=file.lines path=~/8gent-code/packages/goal/ledger.ts]]",
	"Available sources: file.sha256, file.lines, file.line (path= line=),",
	"dir.count (path= glob=), git.head, git.rev (repo= ref=), git.count",
	"(repo= range=), git.branch, ledger.head (path=).",
	"If you must assert a specific value, add expect=<value>; a wrong expect is",
	"stripped from your message and flagged, so only claim what you can source.",
	"To compute from two claims, give them ids and write",
	"  [[DERIVE op=ratio of=c1,c2]]  (ops: sum diff ratio max min).",
	"You never do arithmetic yourself.",
].join("\n");
