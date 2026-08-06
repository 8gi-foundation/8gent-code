/**
 * 8gent Table - the 8GI officer roster.
 *
 * Eight officers, each PINNED to a specific on-box (sovereign) inference
 * backend. Every backend here is local: nothing in this file routes a Table
 * officer to a cloud endpoint (that is enforced separately by the F4 gate in
 * packages/daemon/agent-pool.ts, which downgrades any cloud runtime for a
 * Table session). The eight are distributed evenly across the four live local
 * backends, two officers each, so no single backend carries the whole table.
 *
 * A roster entry is pure data: `{ code, name, role, provider, model, baseUrl,
 * systemPrompt }`. A caller turns one into a running Table session by handing
 * the routing fields to `AgentPool.createSession(sid, "table", { runtime,
 * model, baseUrl, systemPrompt, agentScope: "__table__" })`.
 *
 * ── baseUrl conventions (IMPORTANT - each client appends its own path) ──
 * The `baseUrl` shape differs by provider because each LLM client appends a
 * different suffix (see packages/eight/clients/*):
 *   - ollama   : host only, no path      e.g. "http://127.0.0.1:11434"
 *                (OllamaClient appends "/api/chat")
 *   - lmstudio : host only, NO "/v1"     e.g. "http://127.0.0.1:1234"
 *                (LMStudioClient appends "/v1/chat/completions")
 *   - apfel    : host + "/v1"            e.g. "http://127.0.0.1:11435/v1"
 *                (ApfelClient appends "/chat/completions")
 * Getting this wrong double-suffixes the URL, so the values below are
 * deliberate. apple-foundation is not used here (it is a subprocess bridge
 * with no URL); the two "apfel" officers use the OpenAI-compatible apfel
 * server that fronts the same Apple Foundation model over HTTP.
 */

/** On-box provider/runtime an officer is pinned to. All are local. */
export type OfficerProvider = "apfel" | "ollama" | "lmstudio";

/**
 * A CLI coding-agent worker kind Helm can spawn. Mirrors helm.py's KINDS keys
 * exactly - this union MUST stay in lockstep with both helm.py's KINDS dict and
 * helm-bridge.ts's HelmKind type, or a harness binding here could name a kind
 * Helm cannot actually run. "goose" is deliberately NOT in this union yet - the
 * `goose` on PATH on the reference machine is a broken, unrelated stale PyPI
 * package (ModuleNotFoundError: langfuse.decorators), not Block's Goose CLI. It
 * stays out until the real Goose CLI binary replaces it and its --help is
 * reverified per the same procedure used for pi/opencode/cursor-agent below.
 */
export type HarnessKind =
	| "claude"
	| "codex"
	| "8gent-local"
	| "shell"
	| "pi"
	| "cursor-agent"
	| "opencode";

/**
 * An officer's EXECUTION harness - the CLI coding agent Helm spawns when this
 * officer's Helm proposal is approved. Independent of `provider`/`model` below,
 * which is the officer's CHAT backend (the local LLM answering as them in a
 * Table channel). An officer chatting on a local model and executing through a
 * cloud-billed CLI (claude/codex/cursor-agent) is expected, not a bug - see
 * harness-config.ts's logCloudBilledOfficers for the disclosure this earns.
 */
export interface OfficerHarness {
	/** Which CLI Helm launches. Must be a kind Helm's KINDS dict actually has. */
	kind: HarnessKind;
	/** Optional model override passed to the harness's OWN --model flag (NOT
	 *  Officer.model, which is the chat backend's model id). Undefined = the
	 *  harness's own default model. Validated by helm.py's _MODEL_RE either way. */
	model?: string;
	/** Optional skill names appended to the harness's system prompt (only kinds
	 *  with a real skills flag honour this - see _KIND_OPTIONS in helm.py). */
	skills?: string[];
}

export interface Officer {
	/** Officer code, e.g. "8TO". Case-sensitive canonical form is upper. */
	code: string;
	/** Display name, e.g. "Rishi". */
	name: string;
	/** Short role label, e.g. "tech". */
	role: string;
	/** Local backend this officer runs on. Maps 1:1 to AgentConfig.runtime. */
	provider: OfficerProvider;
	/** Model id as the backend expects it. */
	model: string;
	/** Endpoint base URL (see the per-provider convention note above). */
	baseUrl: string;
	/** Short, in-character system prompt (1-2 sentences). */
	systemPrompt: string;
	/** EXECUTION harness - see OfficerHarness doc comment. Coded default; a
	 *  human may override it per-officer via ~/.8gent/table-harness.json,
	 *  resolved at call time by harness-config.ts's resolveHarness(). */
	harness: OfficerHarness;
}

// Live backend endpoints (local only). Centralised so a port change is one edit.
const APFEL_BASE = "http://127.0.0.1:11435/v1"; // apfel appends /chat/completions
const OLLAMA_BASE = "http://127.0.0.1:11434"; // ollama appends /api/chat
const LMSTUDIO_BASE = "http://127.0.0.1:1234"; // lmstudio appends /v1/chat/completions

/**
 * The eight officers, keyed by code. Distribution across the four live local
 * backends (two officers each):
 *   apfel  (apple-foundationmodel)  -> 8EO AI James, 8PO Samantha
 *   ollama (llama3.2:3b)            -> 8CO Luis,     8MO Zara
 *   lmstudio ornith-1.0-9b (reason) -> 8GO Solomon,  8SO Karen
 *   lmstudio gemma-4-12b-coder      -> 8TO Rishi,    8DO Moira
 */
export const OFFICERS: Readonly<Record<string, Officer>> = Object.freeze({
	"8EO": {
		code: "8EO",
		name: "AI James",
		role: "exec",
		provider: "apfel",
		model: "apple-foundationmodel",
		baseUrl: APFEL_BASE,
		systemPrompt:
			"You are AI James, the chief executive of the 8GI table. Decide, prioritise, and keep the group moving toward the mission; be direct and own the call.",
		// Broadest general-purpose CLI; exec needs the most capable default, not a
		// specialist tool.
		harness: { kind: "claude" },
	},
	"8PO": {
		code: "8PO",
		name: "Samantha",
		role: "product",
		provider: "lmstudio",
		model: "gemma-4-12b-coder-fable5-composer2.5-v1",
		baseUrl: LMSTUDIO_BASE,
		systemPrompt:
			"You are Samantha, the product officer. Discipline, always: state the problem in ONE sentence; name exactly ONE primary user and make them a specific human, never 'the agent' or a list of archetypes; define the Smallest Shippable Slice as a single concrete view plus one action a user takes, never a restatement of the full feature. Cut everything that is not those three.",
		// Multi-provider breadth (opencode routes many backends) fits a PM officer
		// who scopes across surfaces, not one stack.
		harness: { kind: "opencode" },
	},
	"8CO": {
		code: "8CO",
		name: "Luis",
		role: "community",
		provider: "lmstudio",
		model: "gemma-4-12b-coder-fable5-composer2.5-v1",
		baseUrl: LMSTUDIO_BASE,
		systemPrompt:
			"You are Luis, the community officer. Warm but useful: when someone has a problem, give ONE concrete known fix or the exact next step (or ask them to post their logs) so the solution lives in the public thread. Never reply with only vague questions. Keep it welcoming, keep it actionable.",
		// The open-source community officer runs the community's own free/local
		// harness - dogfoods what we ship.
		harness: { kind: "8gent-local" },
	},
	"8MO": {
		code: "8MO",
		name: "Zara",
		role: "marketing",
		provider: "ollama",
		model: "llama3.2:3b",
		baseUrl: OLLAMA_BASE,
		systemPrompt:
			"You are Zara, the marketing officer. Find the sharp, honest hook in the work and say it in plain words; evidence over hype.",
		// Lightweight, fast CLI for quick content/script tasks - matches
		// marketing's cadence.
		harness: { kind: "pi" },
	},
	"8GO": {
		code: "8GO",
		name: "Solomon",
		role: "governance",
		provider: "lmstudio",
		model: "ornith-1.0-9b",
		baseUrl: LMSTUDIO_BASE,
		systemPrompt:
			"You are Solomon, the governance officer. Reason carefully about rules, risk, and precedent, then state the principled position and why it holds.",
		// Governance <-> policy-hooks is Goose's actual design center, but the
		// `goose` on PATH on this machine is a broken, unrelated stale package
		// (see the HarnessKind doc comment) - not the real Block Goose CLI. Bound
		// to `pi` for now so Solomon has a WORKING harness rather than a silently
		// faked `goose`. Flip this to `kind: "goose"` the moment the real Goose
		// CLI is installed and its --help is reverified.
		harness: { kind: "pi" },
	},
	"8SO": {
		code: "8SO",
		name: "Karen",
		role: "security",
		provider: "lmstudio",
		model: "ornith-1.0-9b",
		baseUrl: LMSTUDIO_BASE,
		systemPrompt:
			"You are Karen, the security officer. Assume the input is hostile until proven otherwise; name the threat, the blast radius, and the smallest safe mitigation.",
		// Most auditable, most restricted: a literal shell she (and James) can
		// read command-by-command, no autonomous agent loop of its own.
		harness: { kind: "shell" },
	},
	"8TO": {
		code: "8TO",
		name: "Rishi",
		role: "tech",
		provider: "lmstudio",
		model: "gemma-4-12b-coder-fable5-composer2.5-v1",
		baseUrl: LMSTUDIO_BASE,
		systemPrompt:
			"You are Rishi, the tech officer. Terse and pragmatic; give the smallest change that works, the constraint that bounds it, and what you are not doing.",
		// OpenAI's code-specialist CLI - distinct from the exec's `claude`, per
		// James's own "code in one... claude code in another" split.
		harness: { kind: "codex" },
	},
	"8DO": {
		code: "8DO",
		name: "Moira",
		role: "design",
		provider: "lmstudio",
		model: "gemma-4-12b-coder-fable5-composer2.5-v1",
		baseUrl: LMSTUDIO_BASE,
		systemPrompt:
			"You are Moira, the design officer. Guard the interaction and the feel; reduce friction, and reject anything that makes the user work harder than needed.",
		// Cursor's agent CLI is the most interaction/UI-oriented of the installed
		// set; fits the design officer's brief.
		harness: { kind: "cursor-agent" },
	},
});

/** All officers as an array, in canonical (roster) order. */
export function listOfficers(): Officer[] {
	return Object.values(OFFICERS);
}

// Lower-cased lookup index: name -> officer AND code -> officer, so a mention
// can resolve by either. Built once. Codes and names do not collide.
const HANDLE_INDEX: ReadonlyMap<string, Officer> = (() => {
	const index = new Map<string, Officer>();
	for (const officer of Object.values(OFFICERS)) {
		index.set(officer.code.toLowerCase(), officer);
		index.set(officer.name.toLowerCase(), officer);
	}
	return index;
})();

/**
 * Resolve an @mention handle to an officer entry.
 *
 * Accepts, case-insensitively, either the officer code or the display name,
 * with or without a leading "@": "@rishi", "@8TO", "Rishi", "8to" all resolve
 * to the 8TO officer. A multi-word name is matched on its first token (the
 * @mention scanner only captures [A-Za-z0-9_-]), so "AI James" is reachable as
 * "@8EO" (its code); the display name "AI James" is not a single mention token.
 *
 * Returns the matching Officer, or undefined when the handle names no officer.
 * Pure and deterministic - safe to run on untrusted channel text.
 */
export function resolveOfficer(handle: string): Officer | undefined {
	if (!handle) return undefined;
	const cleaned = handle.trim().replace(/^@+/, "").toLowerCase();
	if (!cleaned) return undefined;
	return HANDLE_INDEX.get(cleaned);
}
