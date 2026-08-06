/**
 * 8gent Huddle Phase 1 - end-to-end demo.
 *
 *   bun run packages/table/huddle-demo.ts
 *
 * This is not a mock. It drives the REAL FloorMachine from Phase 0, calls the
 * REAL officer model each officer is configured with, parses the officers' own
 * [[SLIDE]] markers, resolves their [[CLAIM]] references against this actual
 * repo, renders with the pure renderer, narrates with Supertonic in each
 * officer's DECLARED voice, and bakes an MP4 into ~/.8gent/creative/.
 *
 * What is real here: the floor order, the officer replies, every number on
 * every slide, every voice, the slide hashes, the artifact.
 * What is scripted: the topic, and the roster (three officers, chosen so the
 * demo is short). Nothing else.
 *
 * Env:
 *   HUDDLE_TOPIC   the question put to the table
 *   HUDDLE_ROSTER  comma-separated officer codes (default 8TO,8SO,8PO)
 *   HUDDLE_BASE    OpenAI-compatible base URL (default LM Studio on 1234)
 *   HUDDLE_MODEL   model id
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FloorMachine, type HuddleOpenConfig, type PrepareContext, type TurnRecord } from "./floor";
import { OFFICERS } from "./officers";
import { resolveSlide, OFFICER_SLIDE_PROMPT } from "./slide-spec";
import { verifySlideSpec } from "./slide-verify";
import { renderSlide } from "./slide-render";
import { voiceFor, narrateTurn, speechText } from "./huddle-voice";
import { bakeHuddle, ensureHuddleDirs, huddleDir, type BakedTurn, type HuddleManifest, THEME_VERSION } from "./bake";
import { OFFICER_CLAIM_PROMPT } from "../verify";

const BASE = process.env.HUDDLE_BASE ?? "http://127.0.0.1:1234/v1";
const MODEL = process.env.HUDDLE_MODEL ?? "gemma-4-12b-coder-fable5-composer2.5-v1";
const TOPIC = process.env.HUDDLE_TOPIC ?? "Is the huddle stage ready to demo, and what is still missing?";
const ROSTER = (process.env.HUDDLE_ROSTER ?? "8TO,8SO,8PO").split(",").map((s) => s.trim().toUpperCase());

const REPO = join(import.meta.dir, "..", "..");

function codeOf(holder: string): string {
	return holder.replace(/^agent:/, "").toUpperCase();
}

async function callModel(system: string, user: string): Promise<string> {
	const res = await fetch(`${BASE}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			temperature: 0.3,
			max_tokens: 420,
		}),
	});
	if (!res.ok) throw new Error(`model HTTP ${res.status}`);
	const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: Record<string, number> };
	const text = data.choices?.[0]?.message?.content ?? "";
	if (data.usage) usage.push(data.usage);
	return text.trim();
}

const usage: Record<string, number>[] = [];

/** Everything Phase 1 adds on top of a Phase 0 turn, keyed by turnId. */
const prepared = new Map<string, Omit<BakedTurn, "index">>();

async function prepare(ctx: PrepareContext): Promise<string> {
	const code = codeOf(ctx.holder);
	const officer = OFFICERS[code];
	if (!officer) throw new Error(`unknown officer ${code}`);

	const system = [officer.systemPrompt, "", OFFICER_SLIDE_PROMPT, "", OFFICER_CLAIM_PROMPT].join("\n");
	const prior = ctx.priorTurnsThisRound
		.filter((t) => t.text)
		.map((t) => `${codeOf(t.holder)}: ${t.text}`)
		.join("\n");
	const user = [
		`Topic: ${ctx.topic}`,
		prior ? `\nWhat the table has said so far:\n${prior}` : "",
		"\nTake the floor. Two or three sentences you would SAY out loud, then exactly one [[SLIDE]] marker.",
		`When you cite a repo fact use a claim marker against repo=${REPO}.`,
	].join("\n");

	const t0 = Date.now();
	const reply = await callModel(system, user);
	console.log(`  [${code}] model replied in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

	// ── the Phase 1 pipeline, exactly as the daemon runs it ────────────────
	const resolved = resolveSlide(reply);
	if (resolved.rejectedReason) console.log(`  [${code}] slide marker rejected (${resolved.rejectedReason}) - fell back to prose`);
	else console.log(`  [${code}] slide source: ${resolved.source}, layout: ${resolved.spec.layout}`);

	const verified = verifySlideSpec(resolved.spec, { roots: [REPO, process.env.HOME ?? "/"] });
	if (verified.assertedFields.length) console.log(`  [${code}] unverified fields marked ASSERTED: ${verified.assertedFields.join(", ")}`);

	const dir = ensureHuddleDirs(HUDDLE_ID);
	const index = prepared.size;
	const { html, sha256 } = renderSlide(verified.spec, {
		code,
		name: officer.name,
		index: index + 1,
		total: ROSTER.length,
		assertedFields: verified.assertedFields,
	});
	writeFileSync(join(dir, "slides", `slide-${ctx.turnId}.html`), html, "utf8");

	const voice = voiceFor(code);
	const speech = speechText(resolved.speech);
	const wav = join(dir, "audio", `turn-${ctx.turnId}.wav`);
	const narration = narrateTurn({ text: speech, voice, outPath: wav, interactive: true });
	console.log(
		`  [${code}] voice ${voice.supertonic} (${voice.say}), ${(narration.durationMs / 1000).toFixed(2)}s` +
			(narration.skipped ? ` [no audio: ${narration.skipped}]` : ""),
	);

	prepared.set(ctx.turnId, {
		turnId: ctx.turnId,
		holder: ctx.holder,
		code,
		name: officer.name,
		voice: voice.supertonic,
		spec: verified.spec,
		sha256,
		text: resolved.speech,
		audioPath: narration.audioPath,
		audioOffsetMs: 0,
		durationMs: narration.durationMs,
		hasAsserted: verified.assertedFields.length > 0,
		assertedFields: verified.assertedFields,
	});

	return resolved.speech;
}

const HUDDLE_ID = `huddle_demo_${Date.now().toString(36)}`;

async function main() {
	console.log(`\n8gent huddle Phase 1 demo`);
	console.log(`  topic:  ${TOPIC}`);
	console.log(`  roster: ${ROSTER.join(", ")}`);
	console.log(`  model:  ${MODEL}\n`);

	const config: HuddleOpenConfig = {
		huddleId: HUDDLE_ID,
		channelId: "demo",
		openedBy: "human:james",
		roster: ROSTER.map((c) => `agent:${c}`),
		topic: TOPIC,
		chair: "agent:8EO",
		chairMode: "agent",
		maxRounds: 1,
		maxDurationMs: 900_000,
		prepareBudgetMs: 180_000,
		speakMsOverride: 1, // the demo bakes from measured audio; do not idle here
	};

	const turns: TurnRecord[] = await new Promise((resolve) => {
		const machine = new FloorMachine(config, {
			emit: (frame) => {
				if (frame.type === "huddle:floor") console.log(`FLOOR -> ${frame.holder} (${frame.seat}, round ${frame.round})`);
				if (frame.type === "huddle:closed") resolve(frame.turns);
			},
			prepareAgentTurn: prepare,
		});
		machine.open();
	});

	// The chair (8EO) is part of the real floor protocol but the demo's roster
	// is the three ring officers, so a chair turn only appears if configured.
	const baked: BakedTurn[] = turns
		.filter((t) => prepared.has(t.turnId))
		.map((t, index) => ({ ...(prepared.get(t.turnId) as Omit<BakedTurn, "index">), index }));

	if (baked.length === 0) {
		console.error("\nNo turns produced. Nothing to bake.");
		process.exit(1);
	}

	const manifest: HuddleManifest = {
		huddleId: HUDDLE_ID,
		channelId: "demo",
		topic: TOPIC,
		themeVersion: THEME_VERSION,
		openedAt: turns[0]?.startedAt ?? Date.now(),
		closedAt: Date.now(),
		turns: baked,
	};

	console.log(`\nBaking ${baked.length} turns...`);
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
	const result = bakeHuddle(manifest, stamp);

	console.log(`\n  manifest:   ${result.manifestPath}`);
	console.log(`  transcript: ${result.transcriptPath}`);
	console.log(`  deck:       ${result.deckPath}`);
	console.log(`  deck-v2v:   ${result.deckV2VPath}`);
	if (result.videoPath) {
		console.log(`\n  VIDEO: ${result.videoPath}`);
	} else {
		console.error(`\n  VIDEO FAILED: ${result.videoError}`);
	}

	// Token cost, measured rather than asserted.
	const prompt = usage.reduce((a, u) => a + (u.prompt_tokens ?? 0), 0);
	const completion = usage.reduce((a, u) => a + (u.completion_tokens ?? 0), 0);
	console.log(`\n  measured tokens: ${prompt} prompt + ${completion} completion over ${usage.length} turns`);
	console.log(`  slide dir: ${join(huddleDir(HUDDLE_ID), "slides")}`);

	if (result.videoPath && existsSync(result.videoPath)) process.exit(0);
	process.exit(1);
}

void main();
