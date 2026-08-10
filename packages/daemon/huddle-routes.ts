/**
 * 8gent Huddle daemon routing - Phase 0 (docs/8GENT-HUDDLE-SPEC.md).
 *
 * Owns the `huddle:*` WS frames. Reached from table-routes.ts's
 * handleTableFrame AFTER its F1 (loopback) check and its pinned-identity actor
 * resolution have already run, so huddle frames inherit both guards with no
 * new trust surface (spec section 3.5). This module never re-derives the
 * actor or the loopback state itself.
 *
 * The actual floor STATE MACHINE lives in packages/table/floor.ts and knows
 * nothing about AgentPool, TableStore, or the wire protocol. This file is the
 * glue: it turns a `huddle:open` frame into a FloorMachine, implements
 * `prepareAgentTurn` by calling the officer's local model (mirroring
 * runMentionFlow's session binding), implements `postTurnText` by reusing the
 * existing gated post_to_channel tool (so a huddle turn lands in the signed
 * ledger exactly like any other channel message, and TableVoice.swift speaks
 * it automatically - no new audio path), and fans FloorMachine's frames out to
 * every WS client subscribed to the huddle's channel via the SAME
 * `broadcast()` a client already uses for message:appended.
 */

import {
	AUDIO_START_GRACE_MS,
	CHAIR_AGENT_ID,
	CHAIR_HUMAN_ID,
	type ChairMode,
	DEFAULT_MAX_DURATION_MS,
	DEFAULT_MAX_ROUNDS,
	SPEAK_BUDGET_MS,
	FloorMachine,
	type HuddleOpenConfig,
	type HuddleOutFrame,
	newHuddleId,
	PREPARE_BUDGET_MS,
	type PrepareContext,
	assertPromptBudget,
	buildChairDigest,
} from "../table/floor";
import { stripProposal } from "../table/helm-bridge";
import { loadMemory } from "../table/memory";
import { resolveOfficer } from "../table/officer-config";
import { OFFICERS, TABLE_AGENT_SCOPE, makePostToChannelTool, tableSessionId } from "../table/index";
import type { ChannelBroadcast, TableRouteDeps } from "./table-routes";
import {
	type CloseResult,
	closeStage,
	ingestDictation,
	noteStageReady,
	openStage,
	runTurnPipeline,
	snapshotManifest,
} from "./huddle-stage";
import { scheduleMinutes } from "./huddle-minutes";

/** One live huddle: its FloorMachine plus the daemon deps it needs for IO. */
class HuddleInstance {
	readonly machine: FloorMachine;
	readonly channelId: string;

	constructor(config: HuddleOpenConfig, deps: TableRouteDeps) {
		this.channelId = config.channelId;
		this.machine = new FloorMachine(config, {
			emit: (frame) => {
				deps.broadcast(config.channelId, frame);
				if (frame.type === "huddle:closed") {
					openByChannel.delete(config.channelId);
					// Minutes read the real turns, and closeStage drops the stage state
					// - so snapshot FIRST. An in-memory object copy: no IO, no model,
					// microseconds. The minutes PASS itself is scheduled below, after
					// the bake, and runs strictly off this emit path.
					const manifest = snapshotManifest(config.huddleId);
					// Phase 1: the huddle bakes down to something James can watch.
					// Wrapped because a failed bake must still close the huddle.
					try {
						const baked = closeStage(config.huddleId);
						if (baked) void postCloser(deps, config.channelId, baked);
					} catch (err) {
						console.warn(`[huddle] bake failed: ${(err as Error).message}`);
					}
					// Minutes: parked on the event loop (setTimeout 0 inside), so this
					// adds one timer registration to the emit path and nothing else -
					// huddle:closed was broadcast at the top of this callback, and the
					// synchronous bake above already ran (#2867: never widen that lag).
					scheduleMinutes(deps, manifest);
				}
			},
			prepareAgentTurn: (ctx) => runAgentTurn(deps, ctx),
			postTurnText: (ctx, text) => {
				void postHuddleTurn(deps, ctx, text);
				// Phase 1: slide + narration for this turn. Deliberately not awaited
				// - the FloorMachine's own timers own the turn's lifetime, and a slow
				// TTS must never extend or stall the floor.
				//
				// onAudio is how the turn's REAL spoken length gets back to those
				// timers. The pipeline measures it; without this the floor was still
				// guessing with a reading estimate capped at 20 seconds, started at
				// the wrong moment, and officers were cut off mid-sentence.
				void runTurnPipeline(ctx.huddleId, ctx.turnId, ctx.holder, text, deps.broadcast, {
					onAudio: (turnId, durationMs) => this.machine.noteTurnAudio(turnId, durationMs),
				});
			},
		});
	}
}

/**
 * The channel closer (spec 7.3 item 5): one final message naming the artifact,
 * the turn count and the slide hashes, so the huddle's provenance is in the
 * signed ledger and not only on disk.
 */
async function postCloser(deps: TableRouteDeps, channelId: string, baked: CloseResult): Promise<void> {
	const lines = [
		baked.videoPath ? `Huddle baked: ${baked.videoPath}` : `Huddle closed, but no video was produced: ${baked.videoError}`,
		`${baked.turnCount} turns. Transcript: ${baked.transcriptPath}`,
		baked.hashes.length ? `Slide hashes: ${baked.hashes.map((h) => h.slice(0, 12)).join(" ")}` : "",
	].filter(Boolean);
	const tool = makePostToChannelTool({ store: deps.store, agentId: CHAIR_AGENT_ID, broadcast: deps.broadcast });
	const res = await tool.execute({ channelId, content: lines.join("\n") });
	if (!res.ok) console.warn(`[huddle] closer post denied: ${res.error}`);
}

// In-memory registry. Floor state lives ONLY in the daemon (spec 3.4.6) - this
// is intentionally process-local, exactly like AgentPool's session map.
const openByChannel = new Map<string, HuddleInstance>();
const byId = new Map<string, HuddleInstance>();

/** Human-authored channel post -> huddle presence + (if they hold the floor)
 *  turn text. Called from table-routes.ts's message:post case; a no-op when
 *  the channel has no open huddle. */
export function notifyHuddleMessagePosted(channelId: string, authorId: string, content: string): void {
	const instance = openByChannel.get(channelId);
	if (!instance) return;
	instance.machine.noteHumanTurnText(authorId, content);
}

function officerNameFor(id: string): string {
	if (id.startsWith("human:")) return id.slice("human:".length);
	const code = id.replace(/^agent:/, "").toUpperCase();
	return OFFICERS[code]?.name ?? code;
}

function officerCodeFor(id: string): string {
	return id.startsWith("agent:") ? id.slice("agent:".length).toUpperCase() : id;
}

/**
 * The huddle-turn system prompt. Deliberately NOT table-routes.ts's
 * tableSystemPrompt: that one teaches [[TASK]]/[[HELM]] work-dispatch, which a
 * live huddle turn does not use (a huddle turn is stripped of any proposal
 * markers before it is spoken - see runAgentTurn). Keeping this local also
 * avoids a table-routes.ts <-> huddle-routes.ts import cycle.
 */
function huddleSystemPrompt(officer: { name: string; role: string; systemPrompt: string } | undefined, isChair: boolean): string {
	const persona = officer ? officer.systemPrompt : "You are an officer at the 8gent Table.";
	return [
		persona,
		"You are in a LIVE, VOICED huddle. Turns are spoken aloud in order, one",
		"speaker at a time. This is not a chat window - do not propose HELM or TASK",
		"work here, and do not write markdown, headings, or lists. Say only what a",
		"person would actually say out loud.",
		isChair
			? "This turn you are CHAIRING: you close the round, you do not add a new opinion."
			: "This turn is your own point in the round - concise, direct, in character.",
	].join("\n");
}

/**
 * What an officer is told about slides, on EVERY live turn.
 *
 * Without this a live huddle produced NO slides at all. The ring prompt ended
 * "Output only what you would actually say", which explicitly forbids the
 * marker, and only huddle-demo.ts ever asked for one. So James watched a whole
 * huddle where the slide area showed nothing but the speaker's name and the
 * topic - "only their name changed throughout the constant huddle". The schema
 * had supported eight layouts the entire time; nobody was ever asked to use
 * them.
 *
 * The examples are deliberately SHAPED BUT IMPLAUSIBLE. A realistic worked
 * example gets copied verbatim onto every slide regardless of topic - measured
 * on this model class during Phase 1, where a sample commit hash ended up
 * labelled onto unrelated content.
 */
const SLIDE_INSTRUCTION = [
	"Then add EXACTLY ONE [[SLIDE ...]] marker containing JSON.",
	"The slide is NOT a transcript of what you said - it is what you would put",
	"ON SCREEN to make the point in fewer words. Choose the layout that fits:",
	'  bullets   2-5 short points      [[SLIDE {"layout":"bullets","heading":"...","bullets":["...","..."]}]]',
	'  compare   this versus that      [[SLIDE {"layout":"compare","heading":"...","compare":{"left":"...","right":"..."}}]]',
	'  timeline  ordered steps         [[SLIDE {"layout":"timeline","heading":"...","timeline":["...","..."]}]]',
	'  metric    one number that matters [[SLIDE {"layout":"metric","heading":"...","metric":{"value":"00","label":"..."}}]]',
	'  quote     a line worth reading  [[SLIDE {"layout":"quote","heading":"...","quote":{"text":"..."}}]]',
	'  code      a command or snippet  [[SLIDE {"layout":"code","heading":"...","code":{"lang":"bash","text":"..."}}]]',
	"Headings under 60 characters, bullets under 48. Prefer bullets, compare or",
	"timeline - they carry structure. Use metric only for a number you can",
	"actually justify from what you know, never an invented one.",
].join("\n");

function buildRingPrompt(officerCode: string, ctx: PrepareContext, channelId: string): string {
	// PASS THE CHANNEL. Without it every officer reads one global memory file and
	// drags every other channel's history into this huddle - the same leak fixed
	// in table-routes.ts, which survived here because this call site was written
	// separately and the parameter is optional.
	const memory = loadMemory(officerCode, channelId);
	const roundSoFar = ctx.priorTurnsThisRound
		.filter((t) => t.seat === "ring" && t.text)
		.map((t) => `${officerNameFor(t.holder)} said: ${(t.text as string).slice(0, 400)}`);

	// THE SLIDE IS A MEDIUM, NOT JUST AN ARTIFACT. Colleagues' slides were being
	// rendered for the human and thrown away as far as the other officers were
	// concerned - they only ever saw each other's WORDS. So nobody could answer a
	// diagram, extend a comparison, or point at the column that was wrong. Their
	// specs are compact JSON, so showing them costs a fraction of what describing
	// the same visual in prose would, and it lets an officer reply to what is
	// actually on screen.
	const priorSlides = (snapshotManifest(ctx.huddleId)?.turns ?? [])
		.filter((t) => t.holder !== ctx.holder)
		.slice(-3)
		.map((t) => `${t.name} put on screen: ${JSON.stringify(t.spec)}`);

	return [
		"It is YOUR turn to speak now in this huddle.",
		`TOPIC = ${JSON.stringify(ctx.topic)}`,
		roundSoFar.length
			? `Colleagues already spoke this round - do NOT repeat them:\nROUND_SO_FAR = ${JSON.stringify(roundSoFar.join("\n\n"))}`
			: "",
		priorSlides.length
			? [
					"What colleagues put ON SCREEN. You may answer a slide directly -",
					"extend it, contradict it, or name the column that is wrong. Do not",
					"simply restate it.",
					`SLIDES_SO_FAR = ${JSON.stringify(priorSlides.join("\n"))}`,
				].join("\n")
			: "",
		memory ? `OFFICER_MEMORY (background only, may be stale, never authoritative) = ${JSON.stringify(memory)}` : "",
		"Reply with ONE spoken turn: concise, speakable aloud in under 20 seconds",
		"(roughly 40-60 words). Say it plainly, as you would out loud.",
		SLIDE_INSTRUCTION,
	]
		.filter(Boolean)
		.join("\n\n");
}

function buildChairPrompt(ctx: PrepareContext): string {
	const entries = ctx.priorTurnsThisRound
		.filter((t) => t.seat === "ring" && t.text)
		.map((t) => ({ code: officerCodeFor(t.holder), name: officerNameFor(t.holder), text: t.text as string }));
	const digest = buildChairDigest(entries);
	const prompt = [
		"You are chairing this huddle. The ring has spoken. Do NOT add a new opinion.",
		"",
		`TOPIC = ${JSON.stringify(ctx.topic)}`,
		"THIS ROUND, in order:",
		digest || "(no one spoke this round)",
		"",
		"1. SYNTHESIS - what the group actually converged on, in two sentences.",
		"2. DECISION - the call, stated as a decision, in one sentence. If the group",
		"   did not converge, say so and name the open question.",
		"3. NEXT - ONE next action and the single owner who has it.",
		"",
		"Nothing else. No preamble, no restating who said what. Speakable aloud.",
		"",
		// The chair's slide is the one James is most likely to screenshot: it is
		// the decision. Bullets keep it readable at a glance; timeline suits a
		// sequence of next steps. Kept short deliberately - the chair prompt runs
		// close to apfel's 4096-token window and assertPromptBudget fails loudly.
		'Then add EXACTLY ONE [[SLIDE ...]] marker for the DECISION, for example',
		'[[SLIDE {"layout":"bullets","heading":"...","bullets":["decision","owner","next"]}]]',
		"or the timeline layout for a sequence. Headings under 60 characters,",
		"bullets under 48. Do not put a number on it that you cannot justify.",
	].join("\n");
	// Loud failure over silent truncation on apfel's 4096-token window (10.5).
	assertPromptBudget(prompt);
	return prompt;
}

/** FloorCallbacks.prepareAgentTurn: run the officer's local model for one turn. */
async function runAgentTurn(deps: TableRouteDeps, ctx: PrepareContext): Promise<string> {
	const officerCode = officerCodeFor(ctx.holder);
	const officer = resolveOfficer(officerCode) ?? OFFICERS[officerCode];
	if (!officer) throw new Error(`unknown officer ${officerCode}`);

	// Session scoped per-huddle (not per-channel) so a huddle round never
	// collides with the officer's ordinary @mention session on the same channel.
	const sid = tableSessionId(ctx.huddleId, ctx.holder);
	if (!deps.pool.hasSession(sid)) {
		deps.pool.createSession(sid, "table", {
			agentScope: TABLE_AGENT_SCOPE,
			runtime: officer.provider as never,
			model: officer.model,
			baseUrl: officer.baseUrl,
			systemPrompt: huddleSystemPrompt(officer, ctx.seat === "chair"),
		});
	}

	// The huddle's channel, so officer memory is read per-channel rather than
	// from one global file shared with every other room.
	const channelId = byId.get(ctx.huddleId)?.machine.config.channelId ?? "";
	const prompt =
		ctx.seat === "chair" ? buildChairPrompt(ctx) : buildRingPrompt(officerCode, ctx, channelId);
	const raw = (await deps.pool.chat(sid, prompt)).trim();
	if (!raw || raw.startsWith("[error]") || raw.startsWith("[budget")) return "";
	return stripProposal(raw);
}

/** FloorCallbacks.postTurnText: post through the SAME gated write path a
 *  normal officer reply uses, so it ledgers and TableVoice speaks it. */
async function postHuddleTurn(deps: TableRouteDeps, ctx: PrepareContext, text: string): Promise<void> {
	const channelId = byId.get(ctx.huddleId)?.channelId;
	if (!channelId) return; // huddle closed/unknown between prepare and post - drop, never post orphaned
	const tool = makePostToChannelTool({ store: deps.store, agentId: ctx.holder, broadcast: deps.broadcast });
	const res = await tool.execute({ channelId, content: text });
	if (!res.ok) console.warn(`[huddle] turn post denied for ${ctx.holder}: ${res.error}`);
}

/** The set of huddle:* frames this module owns (mirrors table-routes.ts's
 *  isTableFrame naming so the two are obviously paired). */
export function isHuddleFrame(type: unknown): boolean {
	return typeof type === "string" && type.startsWith("huddle:");
}

/**
 * Handle one huddle:* frame. `actor` is the ALREADY-PINNED participant id from
 * table-routes.ts (F2) - this function never re-derives or trusts anything
 * from the frame body for identity. Always returns true (every huddle:* type
 * is recognized; unknown sub-types get an explicit huddle:error).
 */
export function handleHuddleFrame(deps: TableRouteDeps, msg: Record<string, unknown>, actor: string): boolean {
	const { store, sendRaw } = deps;
	const type = msg.type as string;
	const id = msg.id;

	const sendErr = (code: string, message: string, extra?: { huddleId?: string; turnId?: string }) => {
		sendRaw({ type: "huddle:error", id, code, message, ...extra });
	};

	// FloorMachine already BROADCASTS a HUDDLE_FORBIDDEN to the whole channel
	// (spec's own huddle:error is a broadcast frame - a rejected floor-verb
	// attempt is a security-relevant event the whole channel should see). This
	// ALSO sends a directly correlated (request `id`-bearing) copy back to the
	// specific connection that made the attempt, matching every other error
	// path in this codebase. A "dropped" result (stale turnId) is correctly
	// silent - see spec section 3.4.5.
	const reportIfForbidden = (huddleId: string, result: "ok" | "forbidden" | "dropped") => {
		if (result === "forbidden") sendErr("HUDDLE_FORBIDDEN", `${actor} may not perform this action`, { huddleId });
	};

	switch (type) {
		case "huddle:open": {
			if (!actor.startsWith("human:")) {
				sendErr("HUDDLE_FORBIDDEN", "only a human may open a huddle");
				return true;
			}
			const channelId = String(msg.channelId ?? "");
			const channel = store.getChannel(channelId);
			if (!channel) {
				sendErr("HUDDLE_VALIDATION", `unknown channel "${channelId}"`);
				return true;
			}
			if (openByChannel.has(channelId)) {
				sendErr("HUDDLE_CONFLICT", `a huddle is already open on "${channelId}"`, { huddleId: openByChannel.get(channelId)?.machine.config.huddleId });
				return true;
			}
			const roster = Array.isArray(msg.roster) ? (msg.roster as unknown[]).map(String) : [];
			if (roster.length === 0) {
				sendErr("HUDDLE_VALIDATION", "roster must be non-empty");
				return true;
			}
			const memberIds = new Set(store.listMembers(channelId).map((m) => m.participantId));
			for (const p of roster) {
				if (!memberIds.has(p)) {
					sendErr("HUDDLE_VALIDATION", `roster member "${p}" is not a member of "${channelId}"`);
					return true;
				}
			}
			const chair = typeof msg.chair === "string" && msg.chair ? msg.chair : CHAIR_HUMAN_ID;
			if (chair !== CHAIR_HUMAN_ID && chair !== CHAIR_AGENT_ID) {
				sendErr("HUDDLE_VALIDATION", `chair must be "${CHAIR_HUMAN_ID}" or "${CHAIR_AGENT_ID}"`);
				return true;
			}
			const chairModeRaw = msg.chairMode;
			const chairMode: ChairMode =
				chairModeRaw === "human" || chairModeRaw === "agent" || chairModeRaw === "auto" ? chairModeRaw : "auto";
			const maxRounds = Number.isFinite(msg.maxRounds) && Number(msg.maxRounds) > 0 ? Number(msg.maxRounds) : DEFAULT_MAX_ROUNDS;
			const maxDurationMs =
				Number.isFinite(msg.maxDurationMs) && Number(msg.maxDurationMs) > 0
					? Number(msg.maxDurationMs)
					: DEFAULT_MAX_DURATION_MS;
			// THINKING budget. Distinct from the speaking budget below - conflating
			// the two is exactly what cut officers off mid-presentation.
			const prepareBudgetMs =
				Number.isFinite(msg.budgetMs) && Number(msg.budgetMs) > 0 ? Number(msg.budgetMs) : PREPARE_BUDGET_MS;
			// SPEAKING budget, and the wait for narration to start. This daemon runs
			// the Phase 1 pipeline (render -> stage_ready gate -> Supertonic), so it
			// opts into the grace; a bare FloorMachine with no pipeline still
			// defaults to 0 and behaves exactly as before.
			const speakBudgetMs =
				Number.isFinite(msg.speakBudgetMs) && Number(msg.speakBudgetMs) > 0
					? Number(msg.speakBudgetMs)
					: SPEAK_BUDGET_MS;
			const audioStartGraceMs =
				Number.isFinite(msg.audioStartGraceMs) && Number(msg.audioStartGraceMs) >= 0
					? Number(msg.audioStartGraceMs)
					: AUDIO_START_GRACE_MS;
			const topic = typeof msg.topic === "string" ? msg.topic : "";
			const huddleId = newHuddleId();

			const config: HuddleOpenConfig = {
				huddleId,
				channelId,
				openedBy: actor,
				roster,
				topic,
				chair,
				chairMode,
				maxRounds,
				maxDurationMs,
				prepareBudgetMs,
				speakBudgetMs,
				audioStartGraceMs,
			};
			const instance = new HuddleInstance(config, deps);
			openByChannel.set(channelId, instance);
			byId.set(huddleId, instance);
			// Phase 1: arm the stage BEFORE open() fires the first grant, so the
			// very first turn already has somewhere to render into.
			openStage(huddleId, channelId, topic);
			// open() synchronously broadcasts huddle:opened to channel subscribers
			// and fires the first grant. The requester also gets a directly
			// correlated (request `id`-bearing) copy, since they may not yet be
			// subscribed to the channel via message:subscribe.
			instance.machine.open();
			sendRaw({ type: "huddle:opened", id, huddleId, huddle: instance.machine.getSnapshot() });
			return true;
		}

		case "huddle:subscribe": {
			const huddleId = String(msg.huddleId ?? "");
			const instance = byId.get(huddleId);
			if (!instance) {
				sendErr("HUDDLE_NOT_FOUND", `unknown huddle "${huddleId}"`, { huddleId });
				return true;
			}
			sendRaw({ type: "huddle:state", id, huddleId, huddle: instance.machine.getSnapshot() });
			return true;
		}

		case "huddle:raise": {
			const huddleId = String(msg.huddleId ?? "");
			const instance = byId.get(huddleId);
			if (!instance) {
				sendErr("HUDDLE_NOT_FOUND", `unknown huddle "${huddleId}"`, { huddleId });
				return true;
			}
			reportIfForbidden(huddleId, instance.machine.raise(actor));
			return true;
		}

		case "huddle:cut": {
			const huddleId = String(msg.huddleId ?? "");
			const turnId = String(msg.turnId ?? "");
			const instance = byId.get(huddleId);
			if (!instance) {
				sendErr("HUDDLE_NOT_FOUND", `unknown huddle "${huddleId}"`, { huddleId });
				return true;
			}
			reportIfForbidden(huddleId, instance.machine.cut(actor, turnId));
			return true;
		}

		// A huddle is a group call, not a fixed committee - James asked to "add
		// and remove 8gents at will". Both are human-only and both are idempotent,
		// so a double-click is harmless.
		case "huddle:invite":
		case "huddle:drop": {
			const huddleId = String(msg.huddleId ?? "");
			const participantId = String(msg.participantId ?? "");
			const instance = byId.get(huddleId);
			if (!instance) {
				sendErr("HUDDLE_NOT_FOUND", `unknown huddle "${huddleId}"`, { huddleId });
				return true;
			}
			if (!participantId) {
				sendErr("HUDDLE_VALIDATION", "requires participantId", { huddleId });
				return true;
			}
			// Only someone already in the channel can be pulled into its huddle -
			// the same membership rule huddle:open enforces on its roster.
			if (type === "huddle:invite") {
				const members = new Set(
					deps.store.listMembers(instance.machine.config.channelId).map((m) => m.participantId),
				);
				if (!members.has(participantId)) {
					sendErr("HUDDLE_VALIDATION", `"${participantId}" is not a member of this channel`, { huddleId });
					return true;
				}
			}
			reportIfForbidden(
				huddleId,
				type === "huddle:invite"
					? instance.machine.invite(actor, participantId)
					: instance.machine.drop(actor, participantId),
			);
			return true;
		}

		case "huddle:yield": {
			const huddleId = String(msg.huddleId ?? "");
			const turnId = String(msg.turnId ?? "");
			const instance = byId.get(huddleId);
			if (!instance) {
				sendErr("HUDDLE_NOT_FOUND", `unknown huddle "${huddleId}"`, { huddleId });
				return true;
			}
			reportIfForbidden(huddleId, instance.machine.yield(actor, turnId));
			return true;
		}

		case "huddle:close": {
			const huddleId = String(msg.huddleId ?? "");
			const instance = byId.get(huddleId);
			if (!instance) {
				sendErr("HUDDLE_NOT_FOUND", `unknown huddle "${huddleId}"`, { huddleId });
				return true;
			}
			reportIfForbidden(huddleId, instance.machine.close(actor));
			return true;
		}

		case "huddle:stage_ready": {
			// THE SYNC GATE (spec 5.1 step 7). The stage tells us a specific turn's
			// slide is composited; only then does that turn's voice start. No
			// identity check: this frame cannot move the floor, cannot change any
			// turn's content, and only ever ends a wait the daemon armed itself.
			noteStageReady(String(msg.huddleId ?? ""), String(msg.turnId ?? ""));
			return true;
		}

		case "huddle:dictate": {
			// ZEN-GEN (spec section 6). James takes the floor and dictates; his own
			// recording is the playback audio and the slides are keyed to whisper's
			// timestamps against it. Human only - this writes turns into the record.
			if (!actor.startsWith("human:")) {
				sendErr("HUDDLE_FORBIDDEN", "only a human may dictate");
				return true;
			}
			const huddleId = String(msg.huddleId ?? "");
			const instance = byId.get(huddleId);
			if (!instance) {
				sendErr("HUDDLE_NOT_FOUND", `unknown huddle "${huddleId}"`, { huddleId });
				return true;
			}
			const wavPath = String(msg.wavPath ?? "");
			const jsonPath = String(msg.whisperJsonPath ?? `${wavPath}.json`);
			if (!wavPath) {
				sendErr("HUDDLE_VALIDATION", "dictate requires wavPath", { huddleId });
				return true;
			}
			// Presence evidence, and it keeps the chair resolving to the human who
			// is demonstrably in the room dictating.
			instance.machine.noteHumanTurnText(actor, "");
			const count = ingestDictation(huddleId, actor, wavPath, jsonPath, deps.broadcast);
			if (count === 0) {
				sendErr("HUDDLE_VALIDATION", `no usable transcript at "${jsonPath}"`, { huddleId });
				return true;
			}
			sendRaw({ type: "huddle:dictated", id, huddleId, slides: count });
			return true;
		}

		default:
			sendErr("HUDDLE_VALIDATION", `unknown huddle frame "${type}"`);
			return true;
	}
}
