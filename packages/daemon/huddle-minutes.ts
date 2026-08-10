/**
 * 8gent Huddle minutes - the deliberation becomes FUNCTIONAL after it closes.
 *
 * James: "there needs to be minutes (semantic web style) also and takeaways,
 * related tasks/issues etc. so they become functional." Semantic-web style
 * means LINKED, not prose: decisions carry who made them, actions carry a
 * suggested officer and an id a phone can tap to delegate, entities are the
 * repos/PRs/issues/people the turns actually named - each one a hook into the
 * rest of the system, not a paragraph.
 *
 * The pipeline, on huddle close (hooked from huddle-routes.ts):
 *
 *   real turns (the same BakedTurn[] the manifest holds)
 *     -> ONE model pass via the daemon's existing AgentPool (the same
 *        infrastructure the officers reply with - no new model path)
 *     -> STRICT JSON contract: validate, retry once on parse failure, and on
 *        final failure write minutes with summary "minutes generation failed"
 *        and the raw turns preserved. NEVER fake structure.
 *     -> minutes.json beside manifest.json in ~/.8gent/huddles/<id>/
 *     -> a compact rendering posted into the channel as a Table message from
 *        the chair, through the SAME gated post_to_channel tool every officer
 *        reply uses - so the minutes live where the conversation lives, in
 *        the signed ledger.
 *
 * TIMING CONTRACT (issue #2867): closeStage - and the bake inside it - is
 * synchronous in the FloorMachine emit path. Minutes must never widen that
 * stall. scheduleMinutes() therefore only PARKS the work on the event loop
 * (setTimeout 0); the model call, the file write and the channel post all run
 * strictly after huddle:closed was broadcast and after the emit callback has
 * returned. The only synchronous cost added to the emit path is building the
 * manifest snapshot: an in-memory object copy, no IO, no model.
 *
 * HONESTY CONTRACT:
 *   - participants come from the manifest's turns, code-derived, never the model
 *   - an entity survives ONLY if its name literally appears in the turns or
 *     topic - the model can propose, the code verifies; nothing is invented
 *   - suggestedOfficer survives only if it is a real officer code
 *   - action ids and statuses are assigned by code, never by the model
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHuddleDirs, type BakedTurn, type HuddleManifest } from "../table/bake";
import { CHAIR_AGENT_ID } from "../table/floor";
import { resolveOfficer } from "../table/officer-config";
import { OFFICERS, TABLE_AGENT_SCOPE, makePostToChannelTool, tableSessionId } from "../table/index";
import type { TableRouteDeps } from "./table-routes";

// ── the shipped schema ─────────────────────────────────────────────────────

export interface MinutesParticipant {
	/** Participant id as it held the floor, e.g. "agent:8TO" or "human:james". */
	id: string;
	code: string;
	name: string;
}

export interface MinutesDecision {
	text: string;
	/** Who made the call - a name or code that spoke in this huddle. */
	by: string;
}

export interface MinutesTakeaway {
	text: string;
}

export interface MinutesAction {
	/** Code-assigned, stable, tappable: "act_<huddle suffix>_<n>". */
	id: string;
	text: string;
	/** A real officer code (validated), when the minutes suggest an owner. */
	suggestedOfficer?: string;
	/** Always "open" at generation time - task state lives in the Table's own
	 *  propose/approve flow, not here. */
	status: "open";
}

export type MinutesEntityKind = "repo" | "pr" | "issue" | "person" | "project";

export interface MinutesEntity {
	/** Verified: this exact string appears in the turns or the topic. */
	name: string;
	kind: MinutesEntityKind;
	/** Optional locator (path, #number, URL) - also verified against the turns. */
	ref?: string;
}

export interface HuddleMinutes {
	huddleId: string;
	/** The channel the huddle ran on - the delegation surface needs it to post
	 *  the task ask back into the same room. */
	channelId: string;
	topic: string;
	closedAt: number;
	participants: MinutesParticipant[];
	summary: string;
	decisions: MinutesDecision[];
	takeaways: MinutesTakeaway[];
	actions: MinutesAction[];
	entities: MinutesEntity[];
	/** "ok" = the model pass validated; "failed" = both attempts failed and
	 *  the structured fields are honestly empty. Never faked. */
	generation: "ok" | "failed";
	generatedAt: number;
	/** Present ONLY on failure: the real turns, preserved verbatim, so the
	 *  record is never lost even when the model pass is. */
	rawTurns?: Array<{ turnId: string; holder: string; code: string; name: string; text: string }>;
}

const ENTITY_KINDS = new Set<MinutesEntityKind>(["repo", "pr", "issue", "person", "project"]);

// ── media-style switch (same pattern as huddle-stage.ts mediaEnabled) ──────

/**
 * Minutes generation is a model call plus a channel post - side-effect IO the
 * termination fuzz tests must not pay for on every randomized close. Same
 * discipline as the bake: opt-OUT under test, on everywhere else. Tests that
 * want the real pipeline call generateAndPublishMinutes directly or flip this.
 */
let minutesEnabled = process.env.NODE_ENV !== "test";

export function setHuddleMinutes(enabled: boolean): void {
	minutesEnabled = enabled;
}

export function huddleMinutesEnabled(): boolean {
	return minutesEnabled;
}

// ── prompt (strict JSON contract) ──────────────────────────────────────────

/** Cap one turn's contribution to the prompt. Turns are spoken (~40-60 words);
 *  this only guards against a pathological one. */
const TURN_TEXT_CAP = 400;
/** Cap the turn block overall so a marathon huddle still fits a local model's
 *  window. Deterministic: newest turns win because the decision lives there. */
const TURNS_BLOCK_CAP = 7000;

function turnsBlock(turns: BakedTurn[]): string {
	const lines = turns.map((t) => `${t.code === "HUMAN" ? t.name : `${t.code} ${t.name}`}: ${t.text.slice(0, TURN_TEXT_CAP)}`);
	let block = lines.join("\n");
	while (block.length > TURNS_BLOCK_CAP && lines.length > 1) {
		lines.shift(); // drop oldest first - the synthesis and decision are at the end
		block = lines.join("\n");
	}
	return block;
}

export function buildMinutesPrompt(manifest: HuddleManifest): string {
	return [
		"You are the scribe for a boardroom huddle that just closed. Produce MINUTES",
		"as STRICT JSON. Reply with ONLY a JSON object - no prose, no markdown, no",
		"code fences.",
		"",
		`TOPIC = ${JSON.stringify(manifest.topic)}`,
		"TURNS, in speaking order:",
		turnsBlock(manifest.turns),
		"",
		"The JSON object must have exactly these keys:",
		'  "summary":   string, 2-3 sentences, what the huddle concluded',
		'  "decisions": array of {"text": string, "by": string} - calls actually',
		"               made, by the person who made them. Empty array if none.",
		'  "takeaways": array of {"text": string} - insights worth keeping.',
		'  "actions":   array of {"text": string, "suggestedOfficer": string?} -',
		"               concrete next work. suggestedOfficer is an officer code",
		"               (8EO 8TO 8PO 8DO 8SO 8CO 8MO 8GO) only when the turns name",
		"               or clearly imply an owner; omit it otherwise.",
		'  "entities":  array of {"name": string, "kind": string, "ref": string?} -',
		'               kind is one of "repo", "pr", "issue", "person", "project".',
		"               name MUST be an exact string that appears in the turns",
		"               above. Never invent an entity. Empty array if none.",
		"Base everything ONLY on the turns above. Do not add opinions of your own.",
	].join("\n");
}

// ── parse + validate (code verifies, model only proposes) ──────────────────

function asTrimmedString(v: unknown): string | null {
	return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Parse one model reply against the contract. Returns null when the reply is
 * not usable (no JSON object, or no non-empty summary) - the caller retries
 * once, then falls back honestly. Individual bad rows are dropped, not fatal:
 * a half-good minutes beats a failed one, and nothing dropped is invented.
 */
export function parseMinutesReply(
	raw: string,
	manifest: HuddleManifest,
): Pick<HuddleMinutes, "summary" | "decisions" | "takeaways" | "actions" | "entities"> | null {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (typeof obj !== "object" || obj === null) return null;

	const summary = asTrimmedString(obj.summary);
	if (!summary) return null;

	// The corpus every claim of existence is checked against: what was actually
	// said, plus the topic. Lowercased once; membership is case-insensitive.
	const corpus = `${manifest.topic}\n${manifest.turns.map((t) => t.text).join("\n")}`.toLowerCase();
	const inCorpus = (s: string) => s.length > 0 && corpus.includes(s.toLowerCase());

	const decisions: MinutesDecision[] = [];
	if (Array.isArray(obj.decisions)) {
		for (const d of obj.decisions as unknown[]) {
			if (typeof d !== "object" || d === null) continue;
			const text = asTrimmedString((d as Record<string, unknown>).text);
			if (!text) continue;
			decisions.push({ text, by: asTrimmedString((d as Record<string, unknown>).by) ?? "" });
		}
	}

	const takeaways: MinutesTakeaway[] = [];
	if (Array.isArray(obj.takeaways)) {
		for (const t of obj.takeaways as unknown[]) {
			const text =
				typeof t === "string"
					? asTrimmedString(t)
					: typeof t === "object" && t !== null
						? asTrimmedString((t as Record<string, unknown>).text)
						: null;
			if (text) takeaways.push({ text });
		}
	}

	const actions: MinutesAction[] = [];
	if (Array.isArray(obj.actions)) {
		for (const a of obj.actions as unknown[]) {
			if (typeof a !== "object" || a === null) continue;
			const text = asTrimmedString((a as Record<string, unknown>).text);
			if (!text) continue;
			const rawOfficer = asTrimmedString((a as Record<string, unknown>).suggestedOfficer)?.toUpperCase();
			const suggestedOfficer = rawOfficer && OFFICERS[rawOfficer] ? rawOfficer : undefined;
			actions.push({
				// Id assigned HERE, by code - stable and tappable, never the model's.
				id: `act_${manifest.huddleId.slice(-6)}_${actions.length + 1}`,
				text,
				...(suggestedOfficer ? { suggestedOfficer } : {}),
				status: "open",
			});
		}
	}

	const entities: MinutesEntity[] = [];
	if (Array.isArray(obj.entities)) {
		for (const e of obj.entities as unknown[]) {
			if (typeof e !== "object" || e === null) continue;
			const name = asTrimmedString((e as Record<string, unknown>).name);
			const kind = asTrimmedString((e as Record<string, unknown>).kind)?.toLowerCase() as MinutesEntityKind | undefined;
			// THE LAW: an entity exists only if the turns actually said it.
			if (!name || !kind || !ENTITY_KINDS.has(kind) || !inCorpus(name)) continue;
			const ref = asTrimmedString((e as Record<string, unknown>).ref);
			entities.push({ name, kind, ...(ref && inCorpus(ref) ? { ref } : {}) });
		}
	}

	return { summary, decisions, takeaways, actions, entities };
}

/** Participants, code-derived from who actually held the floor. Deterministic
 *  and model-free by construction. */
export function participantsOf(manifest: HuddleManifest): MinutesParticipant[] {
	const seen = new Map<string, MinutesParticipant>();
	for (const t of manifest.turns) {
		if (!seen.has(t.holder)) seen.set(t.holder, { id: t.holder, code: t.code, name: t.name });
	}
	return [...seen.values()];
}

// ── generation (model pass, retry once, honest fallback) ───────────────────

/**
 * Generate minutes from a manifest via an injected chat function. The chat
 * function is the seam that makes this deterministic under test: production
 * hands in the AgentPool session (see generateAndPublishMinutes); tests hand
 * in a fake. Never throws.
 */
export async function generateMinutes(
	manifest: HuddleManifest,
	chat: (prompt: string) => Promise<string>,
): Promise<HuddleMinutes> {
	const base = {
		huddleId: manifest.huddleId,
		channelId: manifest.channelId,
		topic: manifest.topic,
		closedAt: manifest.closedAt,
		participants: participantsOf(manifest),
	};

	const prompt = buildMinutesPrompt(manifest);
	for (let attempt = 0; attempt < 2; attempt++) {
		let raw = "";
		try {
			raw = (await chat(
				attempt === 0
					? prompt
					: `${prompt}\n\nYour previous reply was not valid JSON matching the contract. Reply again with ONLY the JSON object.`,
			)).trim();
		} catch {
			raw = "";
		}
		const parsed = raw ? parseMinutesReply(raw, manifest) : null;
		if (parsed) {
			return { ...base, ...parsed, generation: "ok", generatedAt: Date.now() };
		}
	}

	// Both attempts failed: say so, keep the record. Never fake structure.
	return {
		...base,
		summary: "minutes generation failed",
		decisions: [],
		takeaways: [],
		actions: [],
		entities: [],
		generation: "failed",
		generatedAt: Date.now(),
		rawTurns: manifest.turns.map((t) => ({
			turnId: t.turnId,
			holder: t.holder,
			code: t.code,
			name: t.name,
			text: t.text,
		})),
	};
}

/** Persist minutes.json beside manifest.json in the huddle's own directory. */
export function writeMinutesFile(minutes: HuddleMinutes): string {
	const dir = ensureHuddleDirs(minutes.huddleId);
	const path = join(dir, "minutes.json");
	writeFileSync(path, JSON.stringify(minutes, null, 2), "utf8");
	return path;
}

// ── channel rendering (the minutes live where the conversation lives) ──────

/** Compact, readable rendering for the chair's channel post. Empty sections
 *  are skipped rather than padded - the post says what the minutes hold. */
export function renderMinutesPost(minutes: HuddleMinutes): string {
	const lines: string[] = [`Minutes - ${minutes.topic || minutes.huddleId}`, minutes.summary];
	if (minutes.decisions.length) {
		lines.push("Decisions:");
		for (const d of minutes.decisions) lines.push(`- ${d.text}${d.by ? ` (${d.by})` : ""}`);
	}
	if (minutes.takeaways.length) {
		lines.push("Takeaways:");
		for (const t of minutes.takeaways) lines.push(`- ${t.text}`);
	}
	if (minutes.actions.length) {
		lines.push("Actions:");
		for (const a of minutes.actions) lines.push(`- [${a.id}] ${a.text}${a.suggestedOfficer ? ` -> ${a.suggestedOfficer}` : ""}`);
	}
	if (minutes.entities.length) {
		lines.push(`Mentions: ${minutes.entities.map((e) => `${e.name} (${e.kind})`).join(", ")}`);
	}
	lines.push(`Full minutes: ~/.8gent/huddles/${minutes.huddleId}/minutes.json`);
	return lines.join("\n");
}

// ── orchestration (pool session in, minutes on disk + in channel out) ──────

/**
 * The whole minutes pass for one closed huddle: model via the daemon's own
 * pool, minutes.json on disk, compact rendering posted to the channel as the
 * chair. Never throws - a failed minutes pass must never take the daemon down.
 *
 * The scribe session is scoped per-huddle under a reserved participant name
 * ("minutes"), so it can never collide with an officer's own huddle session
 * (tableSessionId(huddleId, holder)) or a channel mention session.
 */
export async function generateAndPublishMinutes(
	deps: Pick<TableRouteDeps, "store" | "pool" | "broadcast">,
	manifest: HuddleManifest,
): Promise<HuddleMinutes | null> {
	try {
		const officerCode = CHAIR_AGENT_ID.replace(/^agent:/, "");
		const officer = resolveOfficer(officerCode) ?? OFFICERS[officerCode];
		const sid = tableSessionId(manifest.huddleId, "minutes");
		if (!deps.pool.hasSession(sid)) {
			deps.pool.createSession(sid, "table", {
				agentScope: TABLE_AGENT_SCOPE,
				runtime: officer?.provider as never,
				model: officer?.model,
				baseUrl: officer?.baseUrl,
				systemPrompt:
					"You are the minutes scribe for the 8gent Table. You reply with strict JSON only, exactly as instructed. You never invent facts.",
			});
		}

		const minutes = await generateMinutes(manifest, (prompt) => deps.pool.chat(sid, prompt));
		writeMinutesFile(minutes);

		// Post through the SAME gated write path every officer reply uses, as the
		// chair - so the minutes land in the signed ledger, in the room where the
		// deliberation happened, and TableVoice/phone surfaces see them arrive.
		const tool = makePostToChannelTool({ store: deps.store, agentId: CHAIR_AGENT_ID, broadcast: deps.broadcast });
		const res = await tool.execute({ channelId: manifest.channelId, content: renderMinutesPost(minutes) });
		if (!res.ok) console.warn(`[huddle] minutes post denied: ${res.error}`);
		return minutes;
	} catch (err) {
		console.warn(`[huddle] minutes generation failed for ${manifest.huddleId}: ${(err as Error).message}`);
		return null;
	}
}

/**
 * The hook huddle-routes.ts calls from the FloorMachine emit path, AFTER
 * huddle:closed was broadcast and closeStage/bake ran. Adds exactly one
 * setTimeout registration to that path - the entire pass runs later, on the
 * event loop, so it cannot widen the bake-blocks-broadcast window (#2867).
 */
export function scheduleMinutes(
	deps: Pick<TableRouteDeps, "store" | "pool" | "broadcast">,
	manifest: HuddleManifest | null,
): void {
	if (!minutesEnabled || !manifest) return;
	setTimeout(() => {
		void generateAndPublishMinutes(deps, manifest);
	}, 0);
}
