/**
 * Harness/Host Contract Validator
 *
 * Host-side checker for every harness→host call. Lives in `packages/runtime`
 * because the runtime is what mediates between a spawned harness and the
 * underlying host APIs.
 *
 * Usage:
 *   const contract = buildContract("claude");           // pull declared caps
 *   const decision = validateRequest(contract, request); // check at boundary
 *   if (!decision.ok) throw new ContractViolationError(decision);
 *
 * Issue: #2086
 */

import type {
	CapabilityAction,
	CapabilityCategory,
	ContractDecision,
	HarnessCapability,
	HarnessHostContract,
	HostRequest,
} from "@8gent/types";
import { ContractViolationError, getFlavorDeclaration } from "@8gent/types";

// ---------------------------------------------------------------------------
// Target matching
// ---------------------------------------------------------------------------

/**
 * Match a target string against an allowlist pattern. Supports:
 *   - exact match
 *   - "*"            → wildcard (any target)
 *   - "*.example"    → suffix match (any prefix ending in `.example`)
 *   - "prefix/*"     → prefix match (any suffix after `prefix/`)
 *   - "prefix/**"    → prefix match (any suffix after `prefix/`, multi-segment)
 */
export function matchTarget(target: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern === target) return true;

	if (pattern.startsWith("*.")) {
		const suffix = pattern.slice(1); // ".example"
		return target.endsWith(suffix) && target.length > suffix.length;
	}

	if (pattern.endsWith("/**")) {
		const prefix = pattern.slice(0, -3); // "prefix"
		return target === prefix || target.startsWith(`${prefix}/`);
	}

	if (pattern.endsWith("/*")) {
		const prefix = pattern.slice(0, -2); // "prefix"
		if (!target.startsWith(`${prefix}/`)) return false;
		const tail = target.slice(prefix.length + 1);
		return tail.length > 0 && !tail.includes("/");
	}

	if (pattern.endsWith("*")) {
		const prefix = pattern.slice(0, -1);
		return target.startsWith(prefix) && target.length > prefix.length;
	}

	return false;
}

function targetAllowed(targets: readonly string[], target: string): boolean {
	for (const pattern of targets) {
		if (matchTarget(target, pattern)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Core validator
// ---------------------------------------------------------------------------

/**
 * Check a single host request against a harness's contract.
 *
 * Walks the contract's capabilities looking for one that covers the
 * request's `(category, action, target)` triple. Returns `{ ok: true }`
 * on match, `{ ok: false, ... }` with the missing piece on miss.
 */
export function validateRequest(
	contract: HarnessHostContract,
	request: HostRequest,
): ContractDecision {
	const flavor = contract.flavor;
	const sameCategory: HarnessCapability[] = contract.capabilities.filter(
		(cap) => cap.category === request.category,
	);

	if (sameCategory.length === 0) {
		return {
			ok: false,
			reason: "missing_category",
			missing: { category: request.category },
			message: `Harness "${flavor}" was not granted any "${request.category}" capability.`,
			flavor,
		};
	}

	const withAction = sameCategory.filter((cap) =>
		(cap.actions as readonly string[]).includes(request.action),
	);

	if (withAction.length === 0) {
		return {
			ok: false,
			reason: "missing_action",
			missing: { category: request.category, action: request.action },
			message: `Harness "${flavor}" cannot perform "${request.action}" on "${request.category}".`,
			flavor,
		};
	}

	for (const cap of withAction) {
		if (targetAllowed(cap.targets, request.target)) {
			return { ok: true };
		}
	}

	return {
		ok: false,
		reason: "target_not_allowed",
		missing: {
			category: request.category,
			action: request.action,
			target: request.target,
		},
		message: `Harness "${flavor}" cannot ${request.action} "${request.target}" on "${request.category}" — target outside allowlist.`,
		flavor,
	};
}

/**
 * Throwing variant — convenient for boundary code that wants the host call
 * to fail fast. Consumers that want structured handling should call
 * `validateRequest` directly.
 */
export function enforceRequest(
	contract: HarnessHostContract,
	request: HostRequest,
): void {
	const decision = validateRequest(contract, request);
	if (!decision.ok) throw new ContractViolationError(decision);
}

/**
 * Curried form — useful when you want to bind a single contract once and
 * pass the resulting function around as a guard.
 */
export function createValidator(
	contract: HarnessHostContract,
): (request: HostRequest) => ContractDecision {
	return (request) => validateRequest(contract, request);
}

// ---------------------------------------------------------------------------
// Contract construction
// ---------------------------------------------------------------------------

export interface BuildContractOptions {
	/** Optional metadata to attach (spawn id, parent session, etc.) */
	metadata?: Record<string, unknown>;
	/**
	 * Optional narrowing function — given the flavor's required capabilities,
	 * return the subset to actually grant. Default: grant everything declared.
	 */
	narrow?: (required: HarnessCapability[]) => HarnessCapability[];
}

/**
 * Build a `HarnessHostContract` for a known flavor. Throws if the flavor is
 * not registered — host callers must fail fast rather than spawn a harness
 * with an empty contract.
 */
export function buildContract(
	flavor: string,
	options: BuildContractOptions = {},
): HarnessHostContract {
	const declaration = getFlavorDeclaration(flavor);
	if (!declaration) {
		throw new Error(
			`Unknown harness flavor "${flavor}" — no capability declaration registered. ` +
				"Add one in packages/types/harness-flavors.ts.",
		);
	}

	const granted = options.narrow
		? options.narrow(declaration.required)
		: declaration.required;

	return {
		flavor,
		capabilities: granted,
		metadata: options.metadata,
	};
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/** Pretty-print a denial for logs. */
export function formatDenial(decision: ContractDecision): string {
	if (decision.ok) return "[contract] allow";
	const { missing } = decision;
	const target = missing.target ? ` target=${missing.target}` : "";
	const action = missing.action ? ` action=${missing.action}` : "";
	return `[contract] deny flavor=${decision.flavor} reason=${decision.reason} category=${missing.category}${action}${target}`;
}

export type {
	CapabilityAction,
	CapabilityCategory,
	ContractDecision,
	HarnessCapability,
	HarnessHostContract,
	HostRequest,
} from "@8gent/types";
