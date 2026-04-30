/**
 * @8gent/eight-bdh - Concept ontology for monosemantic synapse targets.
 *
 * Owner: 8GO (Solomon). Spec: docs/specs/8GENT-0.1-BDH-ORCHESTRATOR.md §4.4.
 *
 * The ontology is a stable ordered list. Position in CONCEPT_VOCAB is the
 * synapse index used by the concept head and by decode.extractTrace() (which
 * is positional: activations[i] maps to conceptIds[i]). Reordering this list
 * is a breaking change and requires bumping ONTOLOGY_VERSION.
 *
 * Categories (per spec §4.4):
 *   1. Task class      (~25)
 *   2. Sensitivity     (~15)
 *   3. Vessel-fit      (~9)
 *   4. Budget signal   (~6)
 *   5. Policy signal   (~12)
 *   6. Provider-fit    (~25)
 *   7. State / history (~15)
 *   8. Output kind     (~5)
 *   9. Reserve / drift (~8)
 *
 * Naming: kebab-case. Family prefixes used by the schema:
 *   - vessel-*    : vessel-fit signals (e.g. vessel-8TO-fits)
 *   - decision-*  : output-kind signals (terminal head selectors)
 *   - budget-*    : budget envelope signals
 *   - authority-* : G8WAY authority level signals
 *   - reserve-*   : unallocated synapses for emergent concepts
 */

import type { ConceptId } from "./types";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// 1. Task class (25)
// ---------------------------------------------------------------------------
const TASK_CLASS: readonly ConceptId[] = [
	"code-edit",
	"code-read",
	"code-explain",
	"code-write-new",
	"debug",
	"refactor",
	"test-write",
	"test-run",
	"doc-write",
	"doc-read",
	"review",
	"plan",
	"research-web",
	"research-internal",
	"summarise",
	"translate",
	"deploy",
	"rollback",
	"config-edit",
	"data-migration",
	"chat-reply",
	"clarify-intent",
	"governance-decision",
	"orchestration-meta",
	"file-search",
] as const;

// ---------------------------------------------------------------------------
// 2. Sensitivity (15)
// ---------------------------------------------------------------------------
const SENSITIVITY: readonly ConceptId[] = [
	"security-sensitive",
	"auth-touching",
	"payment-touching",
	"pii-touching",
	"prod-touching",
	"main-branch-touching",
	"secret-touching",
	"legal-sensitive",
	"compliance-sensitive",
	"customer-facing-copy",
	"brand-sensitive",
	"read-only",
	"low-stakes",
	"reversible",
	"irreversible",
] as const;

// ---------------------------------------------------------------------------
// 3. Vessel-fit (9)
// One per officer plus a "no fit" signal. Officer set per 8GI Constitution.
// ---------------------------------------------------------------------------
const VESSEL_FIT: readonly ConceptId[] = [
	"vessel-8EO-fits",
	"vessel-8TO-fits",
	"vessel-8PO-fits",
	"vessel-8DO-fits",
	"vessel-8SO-fits",
	"vessel-8CO-fits",
	"vessel-8MO-fits",
	"vessel-8GO-fits",
	"vessel-none-fits",
] as const;

// ---------------------------------------------------------------------------
// 4. Budget signal (6)
// ---------------------------------------------------------------------------
const BUDGET_SIGNAL: readonly ConceptId[] = [
	"budget-low-tokens",
	"budget-low-time",
	"budget-comfortable",
	"budget-exhausted",
	"budget-unbounded",
	"budget-mismatch",
] as const;

// ---------------------------------------------------------------------------
// 5. Policy signal (12)
// ---------------------------------------------------------------------------
const POLICY_SIGNAL: readonly ConceptId[] = [
	"authority-l0",
	"authority-l1",
	"authority-l2",
	"authority-l3",
	"authority-l4",
	"authority-l5",
	"deny-listed-action",
	"requires-approval",
	"approval-already-granted",
	"policy-violation-risk",
	"policy-clear",
	"tenant-cap-engaged",
] as const;

// ---------------------------------------------------------------------------
// 6. Provider-fit (25)
// ---------------------------------------------------------------------------
const PROVIDER_FIT: readonly ConceptId[] = [
	"local-sufficient",
	"local-preferred",
	"frontier-required",
	"claude-best-fit",
	"gpt-best-fit",
	"gemini-best-fit",
	"grok-best-fit",
	"ollama-best-fit",
	"openrouter-free-best-fit",
	"apple-foundation-best-fit",
	"eight-1-q3-best-fit",
	"tool-call-heavy",
	"vision-required",
	"audio-required",
	"long-context-required",
	"short-context-sufficient",
	"latency-critical",
	"throughput-critical",
	"cost-critical",
	"quality-critical",
	"streaming-required",
	"deterministic-required",
	"reasoning-heavy",
	"code-specialist-required",
	"multilingual-required",
] as const;

// ---------------------------------------------------------------------------
// 7. State / history (15)
// ---------------------------------------------------------------------------
const STATE_HISTORY: readonly ConceptId[] = [
	"recent-failure",
	"recent-success",
	"loop-suspected",
	"compaction-due",
	"fresh-session",
	"long-session",
	"multi-agent-active",
	"checkpoint-restored",
	"escalation-requested",
	"user-frustrated",
	"user-satisfied",
	"prior-decision-overridden",
	"deadline-pressure",
	"ci-failed-recently",
	"prior-vessel-handoff",
] as const;

// ---------------------------------------------------------------------------
// 8. Output kind (5)
// Mirrors DecisionKind in types.ts. Order matches the union for readability.
// ---------------------------------------------------------------------------
const OUTPUT_KIND: readonly ConceptId[] = [
	"decision-model",
	"decision-agent",
	"decision-tool",
	"decision-reject",
	"decision-clarify",
] as const;

// ---------------------------------------------------------------------------
// 9. Reserve / drift (8)
// Unallocated synapses. Filled by 8GO when post-training probes find an
// emergent concept that recurs and deserves a stable label. See RATIONALE.
// ---------------------------------------------------------------------------
const RESERVE: readonly ConceptId[] = [
	"reserve-01",
	"reserve-02",
	"reserve-03",
	"reserve-04",
	"reserve-05",
	"reserve-06",
	"reserve-07",
	"reserve-08",
] as const;

// ---------------------------------------------------------------------------
// Concatenated vocab (frozen, ordered).
// ---------------------------------------------------------------------------
export const CONCEPT_VOCAB: readonly ConceptId[] = Object.freeze([
	...TASK_CLASS,
	...SENSITIVITY,
	...VESSEL_FIT,
	...BUDGET_SIGNAL,
	...POLICY_SIGNAL,
	...PROVIDER_FIT,
	...STATE_HISTORY,
	...OUTPUT_KIND,
	...RESERVE,
]) as readonly ConceptId[];

// ---------------------------------------------------------------------------
// Reverse index: concept -> position. Built once at module load.
// ---------------------------------------------------------------------------
function buildIndex(vocab: readonly ConceptId[]): ReadonlyMap<ConceptId, number> {
	const m = new Map<ConceptId, number>();
	for (let i = 0; i < vocab.length; i++) {
		const id = vocab[i] as ConceptId;
		if (m.has(id)) {
			throw new Error(
				`ontology: duplicate concept id detected at index ${i}: ${id}. Vocab must be unique.`,
			);
		}
		m.set(id, i);
	}
	return m;
}

export const CONCEPT_INDEX: ReadonlyMap<ConceptId, number> = buildIndex(CONCEPT_VOCAB);

// ---------------------------------------------------------------------------
// Category descriptors. Ranges are inclusive indices into CONCEPT_VOCAB.
// ---------------------------------------------------------------------------
export interface ConceptCategory {
	readonly name: string;
	readonly range: readonly [number, number];
	readonly description: string;
}

function range(start: number, len: number): readonly [number, number] {
	return [start, start + len - 1] as const;
}

const TASK_START = 0;
const SENS_START = TASK_START + TASK_CLASS.length;
const VESSEL_START = SENS_START + SENSITIVITY.length;
const BUDGET_START = VESSEL_START + VESSEL_FIT.length;
const POLICY_START = BUDGET_START + BUDGET_SIGNAL.length;
const PROVIDER_START = POLICY_START + POLICY_SIGNAL.length;
const STATE_START = PROVIDER_START + PROVIDER_FIT.length;
const OUTPUT_START = STATE_START + STATE_HISTORY.length;
const RESERVE_START = OUTPUT_START + OUTPUT_KIND.length;

export const CATEGORIES: readonly ConceptCategory[] = Object.freeze([
	{
		name: "task-class",
		range: range(TASK_START, TASK_CLASS.length),
		description:
			"What kind of work the request is. Drives downstream model and agent selection.",
	},
	{
		name: "sensitivity",
		range: range(SENS_START, SENSITIVITY.length),
		description:
			"Risk surface of the action. Gates approvals, deny-list checks, and escalation.",
	},
	{
		name: "vessel-fit",
		range: range(VESSEL_START, VESSEL_FIT.length),
		description:
			"Which 8GI officer vessel is best suited to handle the request, or none.",
	},
	{
		name: "budget-signal",
		range: range(BUDGET_START, BUDGET_SIGNAL.length),
		description:
			"State of the token and time budget envelope at decision time.",
	},
	{
		name: "policy-signal",
		range: range(POLICY_START, POLICY_SIGNAL.length),
		description:
			"G8WAY authority level and policy-engine signals consumed by validateForAuthority.",
	},
	{
		name: "provider-fit",
		range: range(PROVIDER_START, PROVIDER_FIT.length),
		description:
			"Which provider or model class fits the request. Local-first by Principle 2.",
	},
	{
		name: "state-history",
		range: range(STATE_START, STATE_HISTORY.length),
		description:
			"Session and conversation state signals (failures, loops, deadlines).",
	},
	{
		name: "output-kind",
		range: range(OUTPUT_START, OUTPUT_KIND.length),
		description:
			"Terminal head selectors. One should fire per decision. Mirrors DecisionKind.",
	},
	{
		name: "reserve",
		range: range(RESERVE_START, RESERVE.length),
		description:
			"Unallocated synapses for emergent concepts. Relabelled by 8GO via ontology version bump.",
	},
]) as readonly ConceptCategory[];

// ---------------------------------------------------------------------------
// Version + content hash.
// ---------------------------------------------------------------------------
export const ONTOLOGY_VERSION: "0.1.0" = "0.1.0";

let cachedHash: string | null = null;

/**
 * SHA-256 over JSON.stringify(CONCEPT_VOCAB). Computed lazily and cached.
 * Downstream consumers store this alongside training runs and audit traces;
 * a mismatch at inference time is a hard fail.
 */
export function ONTOLOGY_HASH(): string {
	if (cachedHash !== null) return cachedHash;
	const h = createHash("sha256");
	h.update(JSON.stringify(CONCEPT_VOCAB));
	cachedHash = h.digest("hex");
	return cachedHash;
}
