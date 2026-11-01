/**
 * Table presence tests - the queryable twin of the agent:activity broadcast.
 *
 * Pins the truth rules that make a phone-side "Rishi is thinking" indicator
 * honest instead of decorative:
 *  - an entry exists ONLY between a "thinking" announcement and its paired
 *    "idle" (the same lifecycle table-routes.ts has always broadcast around
 *    officer model calls);
 *  - announceActivity records and broadcasts in one call, so the queryable
 *    map and live subscribers can never be told different things;
 *  - stale entries (older than PRESENCE_STALE_MS) are dropped on read, never
 *    returned - a stale claim of activity is worse than none;
 *  - the channel:presence route frame carries the same read authority as a
 *    message read (TABLE_NOT_FOUND on a dead channel, TABLE_AUTH on a private
 *    channel the actor is not a member of) and rides the same F1 loopback
 *    guard as every other Table frame.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import { Ledger } from "../../goal/ledger.js";
import { TableStore } from "../../table/index.js";
import {
	type TableRouteDeps,
	type TableRouteState,
	handleTableFrame,
} from "../table-routes.js";
import {
	PRESENCE_STALE_MS,
	announceActivity,
	noteActivity,
	presenceOf,
	resetPresenceForTest,
} from "../table-presence.js";

// Isolate any default-keydir / audit writes away from the real ~/.8gent
// (same discipline as table-security.test.ts).
const DATA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "table-presence-"));
process.env.EIGHT_DATA_DIR = DATA_TMP;

function freshStore(tmp: string): TableStore {
	const ledger = Ledger.open({
		runId: "table-presence",
		baseDir: path.join(tmp, "ledger"),
		key: randomBytes(32),
	});
	return new TableStore({ dbPath: ":memory:", ledger });
}

function makeDeps(store: TableStore, state: TableRouteState): {
	deps: TableRouteDeps;
	sent: Array<Record<string, unknown>>;
	broadcasts: Array<Record<string, unknown>>;
} {
	const sent: Array<Record<string, unknown>> = [];
	const broadcasts: Array<Record<string, unknown>> = [];
	const deps: TableRouteDeps = {
		store,
		// pool is only touched by the human+mention flow, which none of these
		// tests trigger; a stub keeps the surface honest.
		pool: {} as TableRouteDeps["pool"],
		broadcast: (_c, frame) => broadcasts.push(frame as Record<string, unknown>),
		sendRaw: (frame) => sent.push(frame as Record<string, unknown>),
		state,
	};
	return { deps, sent, broadcasts };
}

function loopbackState(participantId = "human:james"): TableRouteState {
	return {
		subscribedChannels: new Set<string>(),
		participantId,
		remoteAddress: "127.0.0.1",
	};
}

beforeEach(() => resetPresenceForTest());

describe("noteActivity / presenceOf - lifecycle truth", () => {
	it("an entry exists only between thinking and its paired idle", () => {
		expect(presenceOf("chan_a")).toEqual([]);
		noteActivity("chan_a", "agent:8TO", "thinking", 1000);
		expect(presenceOf("chan_a", 2000)).toEqual([
			{ agentId: "agent:8TO", state: "thinking", since: 1000 },
		]);
		noteActivity("chan_a", "agent:8TO", "idle", 3000);
		expect(presenceOf("chan_a", 3000)).toEqual([]);
	});

	it("channels are isolated - activity in one never leaks into another", () => {
		noteActivity("chan_a", "agent:8TO", "thinking", 1000);
		expect(presenceOf("chan_b", 1000)).toEqual([]);
	});

	it("multiple officers list longest-running first, deterministically", () => {
		noteActivity("chan_a", "agent:8SO", "thinking", 2000);
		noteActivity("chan_a", "agent:8TO", "thinking", 1000);
		expect(presenceOf("chan_a", 2500).map((e) => e.agentId)).toEqual([
			"agent:8TO",
			"agent:8SO",
		]);
	});

	it("drops stale entries on read rather than pinning thinking forever", () => {
		noteActivity("chan_a", "agent:8TO", "thinking", 0);
		// One ms inside the window: still live.
		expect(presenceOf("chan_a", PRESENCE_STALE_MS).length).toBe(1);
		// Re-announce (fresh since), then read past the original window: the
		// fresh entry survives on its own clock.
		noteActivity("chan_a", "agent:8TO", "thinking", PRESENCE_STALE_MS);
		expect(presenceOf("chan_a", PRESENCE_STALE_MS + 1000).length).toBe(1);
		// Past the fresh entry's window: gone.
		expect(presenceOf("chan_a", 2 * PRESENCE_STALE_MS + 1001)).toEqual([]);
	});

	it("idle for an unknown agent or channel is a no-op, never a throw", () => {
		noteActivity("chan_never", "agent:8TO", "idle");
		expect(presenceOf("chan_never")).toEqual([]);
	});
});

describe("announceActivity - one call, map and broadcast agree", () => {
	it("records the entry AND emits the exact agent:activity frame", () => {
		const frames: Array<Record<string, unknown>> = [];
		announceActivity((_c, f) => frames.push(f as Record<string, unknown>), "chan_a", "agent:8TO", "thinking");
		expect(frames).toEqual([
			{ type: "agent:activity", channelId: "chan_a", agentId: "agent:8TO", state: "thinking" },
		]);
		expect(presenceOf("chan_a").map((e) => e.agentId)).toEqual(["agent:8TO"]);

		announceActivity((_c, f) => frames.push(f as Record<string, unknown>), "chan_a", "agent:8TO", "idle");
		expect(frames[1]).toEqual(
			{ type: "agent:activity", channelId: "chan_a", agentId: "agent:8TO", state: "idle" },
		);
		expect(presenceOf("chan_a")).toEqual([]);
	});
});

describe("channel:presence route frame", () => {
	it("answers channel:presenceState with the live entries for the channel", () => {
		const store = freshStore(fs.mkdtempSync(path.join(os.tmpdir(), "tp-")));
		const { deps, sent } = makeDeps(store, loopbackState());
		const channel = store.createChannel({
			name: "ops",
			type: "stream",
			visibility: "open",
			createdBy: "human:james",
		});

		// Nobody generating: an empty entries list, not an error.
		handleTableFrame(deps, { type: "channel:presence", id: "p1", channelId: channel.id });
		expect(sent[0]).toMatchObject({
			type: "channel:presenceState",
			id: "p1",
			channelId: channel.id,
			entries: [],
		});

		// Announce through the same helper the reply pipeline uses, then query.
		announceActivity(deps.broadcast, channel.id, "agent:8TO", "thinking");
		handleTableFrame(deps, { type: "channel:presence", id: "p2", channelId: channel.id });
		const reply = sent[1] as { entries: Array<{ agentId: string; state: string; since: number }> };
		expect(reply.entries.length).toBe(1);
		expect(reply.entries[0].agentId).toBe("agent:8TO");
		expect(reply.entries[0].state).toBe("thinking");
		expect(typeof reply.entries[0].since).toBe("number");

		// Cleared on idle - the phone must never see a finished turn as live.
		announceActivity(deps.broadcast, channel.id, "agent:8TO", "idle");
		handleTableFrame(deps, { type: "channel:presence", id: "p3", channelId: channel.id });
		expect(sent[2]).toMatchObject({ type: "channel:presenceState", id: "p3", entries: [] });
	});

	it("refuses an unknown channel with TABLE_NOT_FOUND", () => {
		const store = freshStore(fs.mkdtempSync(path.join(os.tmpdir(), "tp-")));
		const { deps, sent } = makeDeps(store, loopbackState());
		handleTableFrame(deps, { type: "channel:presence", id: "p1", channelId: "chan_dead" });
		expect(sent[0]).toMatchObject({ type: "table:error", id: "p1", code: "TABLE_NOT_FOUND" });
	});

	it("refuses a private channel the actor is not a member of with TABLE_AUTH", () => {
		const store = freshStore(fs.mkdtempSync(path.join(os.tmpdir(), "tp-")));
		const channel = store.createChannel({
			name: "grp-secret",
			type: "stream",
			visibility: "private",
			createdBy: "human:alice",
		});
		const { deps, sent } = makeDeps(store, loopbackState("human:bob"));
		handleTableFrame(deps, { type: "channel:presence", id: "p1", channelId: channel.id });
		expect(sent[0]).toMatchObject({ type: "table:error", id: "p1", code: "TABLE_AUTH" });
	});

	it("answers a private channel to its members (creator is seeded owner)", () => {
		const store = freshStore(fs.mkdtempSync(path.join(os.tmpdir(), "tp-")));
		const channel = store.createChannel({
			name: "grp-team",
			type: "stream",
			visibility: "private",
			createdBy: "human:james",
		});
		const { deps, sent } = makeDeps(store, loopbackState("human:james"));
		handleTableFrame(deps, { type: "channel:presence", id: "p1", channelId: channel.id });
		expect(sent[0]).toMatchObject({ type: "channel:presenceState", id: "p1", entries: [] });
	});

	it("rides the F1 loopback guard like every other Table frame", () => {
		const store = freshStore(fs.mkdtempSync(path.join(os.tmpdir(), "tp-")));
		const state = loopbackState();
		state.remoteAddress = "192.168.1.20";
		const { deps, sent } = makeDeps(store, state);
		handleTableFrame(deps, { type: "channel:presence", id: "p1", channelId: "chan_x" });
		expect(sent[0]).toMatchObject({ type: "table:error", code: "TABLE_FORBIDDEN" });
	});
});
