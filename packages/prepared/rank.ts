/**
 * Profile and ranking (Owned Duet, #5233 slice 1).
 *
 * The profile is built only from local signals: approvals, rejections (with
 * reasons) and issues assigned to the owner. It lives in profile.json inside
 * the prepared dir, on the owner's box, and is never sent anywhere.
 * packages/memory was considered and not used: MemoryStore opens sqlite with
 * vector extensions for free-text recall, and this profile is a few counters.
 * Two arms: profile-ranked and recency-ranked.
 */

import * as path from "node:path";
import type { Packet } from "./packet.js";
import type { PreparedIO } from "./store.js";

export interface Profile {
	v: 1;
	features: Record<string, { a: number; r: number }>;
	rejected: { id: string; tokens: string[]; reason: string }[];
	asked: Record<string, number>;
}

export const emptyProfile = (): Profile => ({ v: 1, features: {}, rejected: [], asked: {} });

export function loadProfile(io: PreparedIO): Profile {
	return io.exists("profile.json")
		? (JSON.parse(io.read("profile.json")) as Profile)
		: emptyProfile();
}
export function saveProfile(io: PreparedIO, p: Profile): void {
	io.write("profile.json", `${JSON.stringify(p, null, 2)}\n`);
}

const STOP = new Set([
	"this",
	"that",
	"with",
	"from",
	"have",
	"todo",
	"fixme",
	"when",
	"will",
	"should",
]);
export function tokens(text: string): string[] {
	const t = text.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? [];
	return [...new Set(t.filter((w) => !STOP.has(w)))].slice(0, 12);
}

type Featured = Pick<Packet, "title" | "source">;
export function featuresOf(p: Featured): string[] {
	const f = [`kind:${p.source.kind}`, ...tokens(p.title).map((t) => `t:${t}`)];
	if (p.source.path) f.push(`dir:${path.dirname(p.source.path)}`);
	return f;
}

export function recordSignal(
	profile: Profile,
	p: Packet,
	outcome: "approve" | "reject",
	reason = "",
): void {
	for (const f of featuresOf(p)) {
		const c = (profile.features[f] ??= { a: 0, r: 0 });
		if (outcome === "approve") c.a++;
		else c.r++;
	}
	if (outcome === "reject") {
		profile.rejected.push({ id: p.id, tokens: tokens(`${p.title} ${reason}`), reason });
	}
}

export function recordAsked(profile: Profile, p: Featured): void {
	for (const f of featuresOf(p)) profile.asked[f] = (profile.asked[f] ?? 0) + 1;
}

const jaccard = (a: string[], b: string[]): number => {
	const A = new Set(a);
	const inter = b.filter((x) => A.has(x)).length;
	const union = new Set([...a, ...b]).size;
	return union === 0 ? 0 : inter / union;
};

/** Highest similarity between a candidate and anything the owner rejected. */
export function rejectedSimilarity(profile: Profile, title: string): number {
	const t = tokens(title);
	return profile.rejected.reduce((m, r) => Math.max(m, jaccard(t, r.tokens)), 0);
}

export function profileScore(p: Packet, profile: Profile): number {
	const fs = featuresOf(p);
	let sum = 0;
	let n = 0;
	for (const f of fs) {
		const c = profile.features[f];
		if (c) {
			sum += (c.a - c.r) / (c.a + c.r + 2);
			n++;
		}
	}
	const asked = fs.reduce((m, f) => Math.max(m, profile.asked[f] ?? 0), 0);
	const sim = rejectedSimilarity(profile, p.title);
	return p.confidence + (n ? sum / n : 0) + Math.min(asked, 3) * 0.05 - (sim >= 0.4 ? sim : 0);
}

export function rank(packets: Packet[], arm: "profile" | "recency", profile: Profile): Packet[] {
	const byId = (a: Packet, b: Packet) => (a.id < b.id ? -1 : 1);
	if (arm === "recency") {
		return [...packets].sort(
			(a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || byId(a, b),
		);
	}
	const score = new Map(packets.map((p) => [p.id, profileScore(p, profile)]));
	return [...packets].sort((a, b) => score.get(b.id)! - score.get(a.id)! || byId(a, b));
}
