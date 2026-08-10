/**
 * Huddle minutes - deterministic tests for the post-close minutes pass.
 *
 * The model seam is an injected chat function (the same seam production fills
 * with AgentPool.chat), so every assertion here is deterministic - never a
 * live-model assertion. Proven:
 *
 *   M-1  a valid strict-JSON reply becomes schema-complete minutes: summary,
 *        decisions, takeaways, code-assigned action ids, verified entities.
 *   M-2  the entity law: an entity whose name is not literally present in the
 *        turns/topic is dropped - the model proposes, the code verifies.
 *   M-3  suggestedOfficer survives only as a real officer code; action ids and
 *        status are code-owned.
 *   M-4  parse failure retries EXACTLY once with a correction, and a valid
 *        second reply is used.
 *   M-5  double failure writes honest minutes: summary "minutes generation
 *        failed", empty structure, generation:"failed", raw turns preserved.
 *   M-6  generateAndPublishMinutes writes minutes.json beside manifest.json
 *        AND posts the compact rendering into the channel as the chair,
 *        through the real gated post tool against a real store.
 *   M-7  scheduleMinutes adds no synchronous work: nothing observable happens
 *        during the call itself; the pass lands on a later event-loop turn
 *        (the #2867 discipline - minutes can never widen the emit-path stall).
 *   M-8  minutes generation is opt-out under test by default, so the existing
 *        termination fuzz suite never pays for a model pass per close.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Ledger } from "../../goal/ledger.js";
import { huddleDir, type BakedTurn, type HuddleManifest } from "../../table/bake.js";
import { CHAIR_AGENT_ID } from "../../table/floor.js";
import { TableStore, installTablePolicies } from "../../table/index.js";
import type { AgentPool } from "../agent-pool.js";
import {
	buildMinutesPrompt,
	generateAndPublishMinutes,
	generateMinutes,
	huddleMinutesEnabled,
	parseMinutesReply,
	participantsOf,
	renderMinutesPost,
	scheduleMinutes,
	setHuddleMinutes,
	writeMinutesFile,
	type HuddleMinutes,
} from "../huddle-minutes.js";

const DATA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "huddle-minutes-datadir-"));
process.env.EIGHT_DATA_DIR = DATA_TMP;
installTablePolicies();

/** Huddle ids used here are namespaced so cleanup can never touch a real one. */
const CLEANUP: string[] = [];
afterEach(() => {
	for (const id of CLEANUP.splice(0)) {
		fs.rmSync(huddleDir(id), { recursive: true, force: true });
	}
	setHuddleMinutes(false);
});

function turn(partial: Partial<BakedTurn> & { turnId: string; holder: string; text: string }): BakedTurn {
	return {
		index: 0,
		code: partial.holder.startsWith("agent:") ? partial.holder.slice("agent:".length).toUpperCase() : "HUMAN",
		name: "someone",
		voice: "test",
		spec: { layout: "bullets", heading: "h", bullets: ["b"] } as never,
		sha256: "0".repeat(64),
		audioPath: null,
		audioOffsetMs: 0,
		durationMs: 1000,
		hasAsserted: false,
		assertedFields: [],
		...partial,
	};
}

function makeManifest(huddleId: string): HuddleManifest {
	CLEANUP.push(huddleId);
	return {
		huddleId,
		channelId: "ch_test",
		topic: "ship the relay minutes route",
		themeVersion: "test",
		openedAt: 1000,
		closedAt: 2000,
		turns: [
			turn({
				turnId: "t1",
				holder: "agent:8TO",
				name: "Rishi",
				text: "The relay must serve minutes.json from the huddles dir. I can own PR #341 in 8gent-ios this week.",
			}),
			turn({
				turnId: "t2",
				holder: "agent:8PO",
				name: "Samantha",
				text: "Users need the archive to open on minutes first. Decision: minutes before video.",
			}),
			turn({
				turnId: "t3",
				holder: "human:james",
				name: "James",
				text: "Agreed. Rishi takes the relay route, and the phone polls briefly after close.",
			}),
		],
	};
}

const VALID_REPLY = JSON.stringify({
	summary: "The board agreed the relay serves minutes.json and the archive opens on minutes first.",
	decisions: [{ text: "Minutes before video in the archive", by: "Samantha" }],
	takeaways: [{ text: "The phone polls briefly after close" }],
	actions: [
		{ text: "Serve minutes.json from the relay", suggestedOfficer: "8TO" },
		{ text: "Poll for minutes after close", suggestedOfficer: "NOT_AN_OFFICER" },
	],
	entities: [
		{ name: "8gent-ios", kind: "repo" },
		{ name: "PR #341", kind: "pr" },
		{ name: "totally-invented-repo", kind: "repo" },
		{ name: "Rishi", kind: "person" },
	],
});

describe("M-1/M-2/M-3 - parse + validate", () => {
	it("valid strict JSON becomes schema-complete minutes with verified entities", async () => {
		const manifest = makeManifest("hm_m1");
		const minutes = await generateMinutes(manifest, async () => VALID_REPLY);

		expect(minutes.generation).toBe("ok");
		expect(minutes.huddleId).toBe("hm_m1");
		expect(minutes.channelId).toBe("ch_test");
		expect(minutes.topic).toBe("ship the relay minutes route");
		expect(minutes.closedAt).toBe(2000);
		expect(minutes.summary).toContain("minutes first");
		expect(minutes.decisions).toEqual([{ text: "Minutes before video in the archive", by: "Samantha" }]);
		expect(minutes.takeaways).toEqual([{ text: "The phone polls briefly after close" }]);
		expect(minutes.rawTurns).toBeUndefined();

		// Participants: code-derived from who actually held the floor.
		expect(participantsOf(manifest)).toEqual([
			{ id: "agent:8TO", code: "8TO", name: "Rishi" },
			{ id: "agent:8PO", code: "8PO", name: "Samantha" },
			{ id: "human:james", code: "HUMAN", name: "James" },
		]);
		expect(minutes.participants).toEqual(participantsOf(manifest));
	});

	it("M-2: an entity not literally present in the turns is dropped, present ones survive", async () => {
		const manifest = makeManifest("hm_m2");
		const minutes = await generateMinutes(manifest, async () => VALID_REPLY);
		const names = minutes.entities.map((e) => e.name);
		expect(names).toContain("8gent-ios");
		expect(names).toContain("PR #341");
		expect(names).toContain("Rishi");
		expect(names).not.toContain("totally-invented-repo");
	});

	it("M-3: officer suggestion validated, ids and status code-owned", async () => {
		const manifest = makeManifest("hm_m3");
		const minutes = await generateMinutes(manifest, async () => VALID_REPLY);
		expect(minutes.actions).toHaveLength(2);
		expect(minutes.actions[0]).toEqual({
			id: "act_hm_m3_1",
			text: "Serve minutes.json from the relay",
			suggestedOfficer: "8TO",
			status: "open",
		});
		// A code that is not a real officer is dropped, the action kept.
		expect(minutes.actions[1].suggestedOfficer).toBeUndefined();
		expect(minutes.actions[1].id).toBe("act_hm_m3_2");
		expect(minutes.actions[1].status).toBe("open");
	});

	it("parseMinutesReply salvages JSON wrapped in prose/fences, rejects no-summary", () => {
		const manifest = makeManifest("hm_parse");
		const wrapped = "Here are the minutes:\n```json\n" + VALID_REPLY + "\n```\nDone.";
		expect(parseMinutesReply(wrapped, manifest)?.summary).toContain("minutes first");
		expect(parseMinutesReply("not json at all", manifest)).toBeNull();
		expect(parseMinutesReply('{"summary": ""}', manifest)).toBeNull();
		expect(parseMinutesReply('{"decisions": []}', manifest)).toBeNull();
	});
});

describe("M-4/M-5 - retry once, then honest failure", () => {
	it("M-4: retries exactly once with a correction and uses the second reply", async () => {
		const manifest = makeManifest("hm_m4");
		const prompts: string[] = [];
		const minutes = await generateMinutes(manifest, async (prompt) => {
			prompts.push(prompt);
			return prompts.length === 1 ? "sorry, here is prose instead of JSON" : VALID_REPLY;
		});
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toBe(buildMinutesPrompt(manifest));
		expect(prompts[1]).toContain("was not valid JSON");
		expect(minutes.generation).toBe("ok");
	});

	it("M-5: double failure -> summary 'minutes generation failed', raw turns preserved, nothing faked", async () => {
		const manifest = makeManifest("hm_m5");
		let calls = 0;
		const minutes = await generateMinutes(manifest, async () => {
			calls += 1;
			return "still not json";
		});
		expect(calls).toBe(2);
		expect(minutes.generation).toBe("failed");
		expect(minutes.summary).toBe("minutes generation failed");
		expect(minutes.decisions).toEqual([]);
		expect(minutes.takeaways).toEqual([]);
		expect(minutes.actions).toEqual([]);
		expect(minutes.entities).toEqual([]);
		expect(minutes.rawTurns).toHaveLength(3);
		expect(minutes.rawTurns?.[0]).toEqual({
			turnId: "t1",
			holder: "agent:8TO",
			code: "8TO",
			name: "Rishi",
			text: manifest.turns[0].text,
		});
	});

	it("a chat that THROWS is a failure path, not a crash", async () => {
		const manifest = makeManifest("hm_throw");
		const minutes = await generateMinutes(manifest, async () => {
			throw new Error("model exploded");
		});
		expect(minutes.generation).toBe("failed");
		expect(minutes.rawTurns).toHaveLength(3);
	});
});

// ── the real store + pool seam (M-6) ──────────────────────────────────────

function freshStore(tmp: string): TableStore {
	const ledger = Ledger.open({ runId: "huddle-minutes", baseDir: path.join(tmp, "ledger"), key: randomBytes(32) });
	return new TableStore({ dbPath: ":memory:", ledger });
}

function makeStubPool(chatImpl: (sid: string, prompt: string) => Promise<string>): {
	pool: AgentPool;
	created: string[];
	chats: Array<{ sid: string; prompt: string }>;
} {
	const sessions = new Set<string>();
	const created: string[] = [];
	const chats: Array<{ sid: string; prompt: string }> = [];
	const pool = {
		hasSession: (sid: string) => sessions.has(sid),
		createSession: (sid: string) => {
			sessions.add(sid);
			created.push(sid);
		},
		chat: (sid: string, prompt: string) => {
			chats.push({ sid, prompt });
			return chatImpl(sid, prompt);
		},
	} as unknown as AgentPool;
	return { pool, created, chats };
}

describe("M-6 - generateAndPublishMinutes writes the file and posts as the chair", () => {
	it("minutes.json lands beside manifest.json and the channel gets the chair's rendering", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm6-"));
		const store = freshStore(tmp);
		const channel = store.createChannel({ name: `minutes-${Date.now()}`, type: "stream", visibility: "open", createdBy: "human:james" });
		store.addMember({ channelId: channel.id, participantId: CHAIR_AGENT_ID, role: "bot", addedBy: "human:james" });

		const manifest = makeManifest("hm_m6");
		manifest.channelId = channel.id;

		const { pool, created, chats } = makeStubPool(async () => VALID_REPLY);
		const appended: Array<Record<string, unknown>> = [];
		const minutes = await generateAndPublishMinutes(
			{ store, pool, broadcast: (_c, f) => appended.push(f as Record<string, unknown>) },
			manifest,
		);

		// The scribe session is huddle-scoped under the reserved "minutes" name.
		expect(created).toEqual(["table:hm_m6:minutes"]);
		expect(chats).toHaveLength(1);

		// The file, beside manifest.json in the huddle's own dir.
		const filePath = path.join(huddleDir("hm_m6"), "minutes.json");
		expect(fs.existsSync(filePath)).toBe(true);
		const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8")) as HuddleMinutes;
		expect(onDisk.generation).toBe("ok");
		expect(onDisk.channelId).toBe(channel.id);
		expect(onDisk.actions[0].id).toBe("act_hm_m6_1");

		// The channel post, from the chair, through the real gated tool.
		const posted = appended.find((f) => f.type === "message:appended") as { message?: { authorId?: string; content?: string } } | undefined;
		expect(posted).toBeTruthy();
		expect(posted?.message?.authorId).toBe(CHAIR_AGENT_ID);
		expect(posted?.message?.content).toContain("Minutes - ship the relay minutes route");
		expect(posted?.message?.content).toContain("[act_hm_m6_1]");
		expect(posted?.message?.content).toContain("-> 8TO");
		expect(minutes?.summary).toContain("minutes first");

		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("a denied post (chair not a member) does not lose the minutes file", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm6b-"));
		const store = freshStore(tmp);
		const channel = store.createChannel({ name: `minutes-deny-${Date.now()}`, type: "stream", visibility: "open", createdBy: "human:james" });
		// Deliberately NOT adding the chair as a member.

		const manifest = makeManifest("hm_m6b");
		manifest.channelId = channel.id;
		const { pool } = makeStubPool(async () => VALID_REPLY);
		const minutes = await generateAndPublishMinutes({ store, pool, broadcast: () => {} }, manifest);

		expect(minutes?.generation).toBe("ok");
		expect(fs.existsSync(path.join(huddleDir("hm_m6b"), "minutes.json"))).toBe(true);
		fs.rmSync(tmp, { recursive: true, force: true });
	});
});

describe("M-7/M-8 - the emit-path discipline and the test-mode default", () => {
	it("M-8: minutes are OFF by default under test, so fuzzed closes never pay for a model pass", () => {
		expect(huddleMinutesEnabled()).toBe(false);
	});

	it("M-7: scheduleMinutes does nothing synchronously; the pass lands on a later tick", async () => {
		setHuddleMinutes(true);
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm7-"));
		const store = freshStore(tmp);
		const channel = store.createChannel({ name: `minutes-async-${Date.now()}`, type: "stream", visibility: "open", createdBy: "human:james" });
		store.addMember({ channelId: channel.id, participantId: CHAIR_AGENT_ID, role: "bot", addedBy: "human:james" });

		const manifest = makeManifest("hm_m7");
		manifest.channelId = channel.id;
		const { pool, chats } = makeStubPool(async () => VALID_REPLY);
		const appended: Array<Record<string, unknown>> = [];

		scheduleMinutes({ store, pool, broadcast: (_c, f) => appended.push(f as Record<string, unknown>) }, manifest);

		// SYNCHRONOUSLY after the call - the emit path's vantage point - nothing
		// has run: no model call, no post, no file. This is the #2867 guarantee.
		expect(chats).toHaveLength(0);
		expect(appended).toHaveLength(0);
		expect(fs.existsSync(path.join(huddleDir("hm_m7"), "minutes.json"))).toBe(false);

		// On a later event-loop turn the whole pass completes.
		await new Promise((r) => setTimeout(r, 50));
		expect(chats).toHaveLength(1);
		expect(fs.existsSync(path.join(huddleDir("hm_m7"), "minutes.json"))).toBe(true);
		expect(appended.some((f) => f.type === "message:appended")).toBe(true);

		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("scheduleMinutes with minutes disabled or a null manifest is a no-op", async () => {
		const { pool, chats } = makeStubPool(async () => VALID_REPLY);
		const deps = { store: null as never, pool, broadcast: () => {} };
		scheduleMinutes(deps, null);
		setHuddleMinutes(false);
		scheduleMinutes(deps, makeManifest("hm_noop"));
		await new Promise((r) => setTimeout(r, 30));
		expect(chats).toHaveLength(0);
	});
});

describe("rendering + persistence helpers", () => {
	it("renderMinutesPost skips empty sections and always names the file", async () => {
		const manifest = makeManifest("hm_render");
		const failed = await generateMinutes(manifest, async () => "nope");
		const post = renderMinutesPost(failed);
		expect(post).toContain("minutes generation failed");
		expect(post).not.toContain("Decisions:");
		expect(post).not.toContain("Actions:");
		expect(post).toContain("~/.8gent/huddles/hm_render/minutes.json");
	});

	it("writeMinutesFile round-trips the schema", async () => {
		const manifest = makeManifest("hm_write");
		const minutes = await generateMinutes(manifest, async () => VALID_REPLY);
		const p = writeMinutesFile(minutes);
		expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual(JSON.parse(JSON.stringify(minutes)));
	});
});
