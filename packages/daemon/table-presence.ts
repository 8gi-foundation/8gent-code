/**
 * Table presence - the queryable side of the agent:activity broadcast.
 *
 * table-routes.ts has always BROADCAST an honest activity signal around every
 * officer model call: `agent:activity {channelId, agentId, state}` is emitted
 * before pool.chat / executeApproved / answerWorker and cleared in `finally`.
 * But a broadcast only reaches a connection that is subscribed at that moment.
 * A polling client (the phone, via the relay's short-lived loopback sockets -
 * mac/relay/daemon_client.py in 8gent-glasses) connects, asks, and closes, so
 * it could never see the frame. This module RECORDS the same lifecycle so a
 * `channel:presence` query can answer "who is generating right now".
 *
 * Truth rules (the whole point):
 *  - An entry exists ONLY between the "thinking" announcement and its paired
 *    "idle" - i.e. exactly while a model call / harness run is in flight.
 *    There is no timer, no animation state, no fabricated "typing" (pool.chat
 *    does not stream, so "typing" would be a lie).
 *  - Recording and broadcasting happen in ONE call (announceActivity below is
 *    used by table-routes.ts at every former broadcast site), so the map can
 *    never drift from what live subscribers were told.
 *  - Entries carry `since` (epoch ms) and are dropped after PRESENCE_STALE_MS
 *    when read. The `finally` blocks in table-routes.ts make leaks unlikely,
 *    but an in-memory map must never be able to pin "thinking" forever - a
 *    stale claim of activity is worse than none.
 *
 * State is module-level and in-memory, like helm-bridge's pending/awaiting
 * maps: a daemon restart honestly resets to "nobody is doing anything".
 */

// Broadcast signature matches table-routes.ts ChannelBroadcast; declared
// structurally here so table-presence has no import cycle with table-routes.
type ChannelBroadcast = (channelId: string, frame: unknown) => void;

export type ActivityState = "thinking" | "idle";

/** Drop entries older than this on read - safety valve, not a UX timer. */
export const PRESENCE_STALE_MS = 10 * 60_000;

export interface PresenceEntry {
	/** "agent:8TO" - same prefixed id the activity broadcast carries. */
	agentId: string;
	/** Only in-flight states are stored; "idle" deletes, it is never listed. */
	state: Exclude<ActivityState, "idle">;
	/** epoch ms when this state was announced. */
	since: number;
}

/** channelId -> agentId -> live entry. */
const activity = new Map<string, Map<string, PresenceEntry>>();

/**
 * Record an activity transition. "idle" removes the entry (and any empty
 * channel bucket); anything else upserts with a fresh `since`.
 */
export function noteActivity(
	channelId: string,
	agentId: string,
	state: ActivityState,
	now: number = Date.now(),
): void {
	if (state === "idle") {
		const bucket = activity.get(channelId);
		if (bucket) {
			bucket.delete(agentId);
			if (bucket.size === 0) activity.delete(channelId);
		}
		return;
	}
	let bucket = activity.get(channelId);
	if (!bucket) {
		bucket = new Map();
		activity.set(channelId, bucket);
	}
	bucket.set(agentId, { agentId, state, since: now });
}

/**
 * Who is generating in this channel right now. Stale entries (older than
 * PRESENCE_STALE_MS) are dropped, not returned - see the truth rules above.
 * Sorted by `since` ascending so the longest-running officer lists first,
 * deterministically.
 */
export function presenceOf(channelId: string, now: number = Date.now()): PresenceEntry[] {
	const bucket = activity.get(channelId);
	if (!bucket) return [];
	const live: PresenceEntry[] = [];
	for (const entry of bucket.values()) {
		if (now - entry.since > PRESENCE_STALE_MS) {
			bucket.delete(entry.agentId);
			continue;
		}
		live.push(entry);
	}
	if (bucket.size === 0) activity.delete(channelId);
	return live.sort((a, b) => a.since - b.since || a.agentId.localeCompare(b.agentId));
}

/**
 * Record AND broadcast one activity transition - the single call site shape
 * used by table-routes.ts wherever it previously broadcast agent:activity
 * directly. One function so the queryable map and the live frame can never
 * disagree about what was announced.
 */
export function announceActivity(
	broadcast: ChannelBroadcast,
	channelId: string,
	agentId: string,
	state: ActivityState,
): void {
	noteActivity(channelId, agentId, state);
	broadcast(channelId, { type: "agent:activity", channelId, agentId, state });
}

/** Test hook: wipe all recorded activity. */
export function resetPresenceForTest(): void {
	activity.clear();
}
