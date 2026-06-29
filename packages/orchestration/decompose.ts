/**
 * decompose.ts - the "decompose" planner.
 *
 * Turns one build task into many small, model-sized units (one file each) so a
 * weak local model only ever does small things it can actually do. The engineer
 * stage runs PER UNIT instead of producing a whole app in one shot.
 *
 * A strong "thinker" completion model does the planning (injected as a
 * ThinkerCall so this module is testable without a live model). The output is a
 * strict BuildPlan whose units are returned already topologically sorted by
 * their dependsOn edges (config/types/layout first, then components, then pages).
 */

import type { BuildPlan, BuildUnit, UnitKind } from "./pipeline-contracts.js";

/**
 * An injected model call: a strong "thinker" completion model.
 * @param system - the system prompt (instructions + output contract).
 * @param user   - the user prompt (the concrete task to decompose).
 * @returns the model's raw text completion.
 */
export type ThinkerCall = (system: string, user: string) => Promise<string>;

/** The set of kinds we accept; anything else is coerced to "other". */
const VALID_KINDS: readonly UnitKind[] = [
	"config",
	"type",
	"style",
	"component",
	"page",
	"module",
	"other",
];

/** Options for {@link decompose}. */
export interface DecomposeOptions {
	/** The whole build task to break down. */
	task: string;
	/** Optional hint, e.g. "next-app", "static-site", "node-cli". */
	projectType?: string;
	/** Optional scaffold structureNote so units fit the given structure. */
	structureNote?: string;
	/** Injected strong "thinker" completion model. */
	call: ThinkerCall;
}

/**
 * Decompose one build task into a topologically ordered BuildPlan of
 * model-sized units (one file each).
 *
 * Robust by construction: if the model returns no usable units, a minimal
 * fallback plan (the whole task as a single file) is returned so the caller
 * always gets a usable plan.
 */
export async function decompose(opts: DecomposeOptions): Promise<BuildPlan> {
	const system = buildSystemPrompt(opts.structureNote);
	const user = buildUserPrompt(opts.task, opts.projectType);

	let raw = "";
	try {
		raw = await opts.call(system, user);
	} catch {
		// A thrown call is treated like an unusable response: fall back.
		return fallbackPlan(opts.task, opts.projectType);
	}

	const parsed = parsePlan(raw);
	if (!parsed || parsed.units.length === 0) {
		return fallbackPlan(opts.task, opts.projectType);
	}

	return {
		projectType: parsed.projectType || opts.projectType || "other",
		summary: parsed.summary || `Plan for: ${opts.task}`,
		units: topoSortUnits(parsed.units),
	};
}

/**
 * Stable topological order by dependsOn: units whose dependencies are already
 * emitted come first. Cycles (and edges to unknown ids) are tolerated by
 * appending the leftover units in their original order.
 */
export function topoSortUnits(units: BuildUnit[]): BuildUnit[] {
	const remaining = [...units];
	const knownIds = new Set(units.map((u) => u.id));
	const emitted = new Set<string>();
	const ordered: BuildUnit[] = [];

	// Greedy stable passes: each pass emits every unit whose deps are satisfied
	// (or point outside the plan). Repeat until a pass emits nothing.
	let progress = true;
	while (remaining.length > 0 && progress) {
		progress = false;
		for (let i = 0; i < remaining.length; i++) {
			const unit = remaining[i];
			const ready = unit.dependsOn.every(
				(dep) => emitted.has(dep) || !knownIds.has(dep),
			);
			if (ready) {
				ordered.push(unit);
				emitted.add(unit.id);
				remaining.splice(i, 1);
				i--;
				progress = true;
			}
		}
	}

	// Leftovers are part of a cycle: append in original order.
	for (const unit of remaining) ordered.push(unit);
	return ordered;
}

// ── Prompt construction ──────────────────────────────────────────────────────

/** The strict system prompt: instructions + the exact JSON contract. */
function buildSystemPrompt(structureNote?: string): string {
	const structureBlock = structureNote
		? `\nThe project already has this structure - make every unit fit it:\n${structureNote}\n`
		: "";

	return [
		"You are a senior software architect that decomposes a build task into",
		"the smallest possible units of work for a weak local model to execute.",
		"",
		"Rules:",
		"- Each unit = EXACTLY ONE file. Never bundle multiple files into one unit.",
		"- Specs must be concrete: name the exports, props, routes, fields, behaviour.",
		"- Order matters. Config and types and layout first, then components, then pages.",
		"- Use dependsOn to express ordering: a unit lists the ids of files it needs.",
		"- Keep each unit small enough that a 7-9B model can write the file in one pass.",
		structureBlock,
		"Return ONLY JSON (no prose, no markdown fences) matching this exact shape:",
		"{",
		'  "projectType": string,',
		'  "summary": string,',
		'  "units": [',
		"    {",
		'      "id": string,',
		'      "path": string,',
		'      "kind": "config|type|style|component|page|module|other",',
		'      "spec": string,',
		'      "dependsOn": string[]',
		"    }",
		"  ]",
		"}",
	].join("\n");
}

/** The user prompt: the concrete task plus an optional project-type hint. */
function buildUserPrompt(task: string, projectType?: string): string {
	const hint = projectType ? `\nTarget project type: ${projectType}` : "";
	return `Decompose this build task into model-sized file units.${hint}\n\nTASK:\n${task}`;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** Shape returned by {@link parsePlan} before topo-sorting / defaulting. */
interface ParsedPlan {
	projectType: string;
	summary: string;
	units: BuildUnit[];
}

/**
 * Robustly parse a model response into a ParsedPlan, or null if nothing usable.
 * Strips ```json fences, extracts the first balanced {...} object, JSON.parses,
 * validates each unit, coerces missing dependsOn to [], drops malformed units.
 */
function parsePlan(raw: string): ParsedPlan | null {
	const jsonText = extractJsonObject(stripFences(raw));
	if (!jsonText) return null;

	let obj: unknown;
	try {
		obj = JSON.parse(jsonText);
	} catch {
		return null;
	}
	if (!obj || typeof obj !== "object") return null;

	const record = obj as Record<string, unknown>;
	const rawUnits = Array.isArray(record.units) ? record.units : [];
	const units: BuildUnit[] = [];

	for (const candidate of rawUnits) {
		const unit = coerceUnit(candidate);
		if (unit) units.push(unit);
	}

	return {
		projectType: typeof record.projectType === "string" ? record.projectType : "",
		summary: typeof record.summary === "string" ? record.summary : "",
		units,
	};
}

/** Validate + coerce a single unit candidate; returns null if unusable. */
function coerceUnit(candidate: unknown): BuildUnit | null {
	if (!candidate || typeof candidate !== "object") return null;
	const c = candidate as Record<string, unknown>;

	const path = typeof c.path === "string" ? c.path.trim() : "";
	const spec = typeof c.spec === "string" ? c.spec.trim() : "";
	// A unit is meaningless without a path and a spec.
	if (!path || !spec) return null;

	const id = typeof c.id === "string" && c.id.trim() ? c.id.trim() : path;
	const kind = coerceKind(c.kind);
	const dependsOn = Array.isArray(c.dependsOn)
		? c.dependsOn.filter((d): d is string => typeof d === "string")
		: [];

	return { id, path, kind, spec, dependsOn };
}

/** Coerce an unknown kind to a valid UnitKind, defaulting to "other". */
function coerceKind(value: unknown): UnitKind {
	return typeof value === "string" && (VALID_KINDS as readonly string[]).includes(value)
		? (value as UnitKind)
		: "other";
}

/** Remove ```json ... ``` (or plain ```) fences if present. */
function stripFences(raw: string): string {
	return raw.replace(/```(?:json)?/gi, "```").replace(/```/g, " ");
}

/**
 * Extract the first balanced {...} object from arbitrary text, ignoring braces
 * inside strings. Returns null if no balanced object is found.
 */
function extractJsonObject(text: string): string | null {
	const start = text.indexOf("{");
	if (start === -1) return null;

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < text.length; i++) {
		const ch = text[i];

		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}

	return null;
}

// ── Fallback ─────────────────────────────────────────────────────────────────

/** A minimal one-unit plan so the caller always gets something usable. */
function fallbackPlan(task: string, projectType?: string): BuildPlan {
	const unit: BuildUnit = {
		id: "main",
		path: "index.ts",
		kind: "module",
		spec: task,
		dependsOn: [],
	};
	return {
		projectType: projectType || "other",
		summary: `[fallback] could not decompose; whole task as a single file: ${task}`,
		units: [unit],
	};
}
